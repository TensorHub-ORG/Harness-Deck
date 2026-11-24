import { ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createMailroomClient } from "@harness-deck/mailroom";
import { WorktreeManager, loadWorkstationConfig } from "@harness-deck/dispatcher";

export interface TcpProbeResult {
  configured: boolean;
  url?: string;
  host?: string;
  port?: number;
  reachable: boolean;
  error?: string;
}

export async function probeTcpPort(host: string, port: number, timeoutMs = 1500): Promise<{ reachable: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (reachable: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, `timeout after ${timeoutMs}ms`));
    socket.once("error", (err) => finish(false, err.message));
  });
}

export async function probeEndpointUrl(rawUrl: string | undefined, timeoutMs = 1500): Promise<TcpProbeResult> {
  if (!rawUrl || !rawUrl.trim()) {
    return { configured: false, reachable: false };
  }
  try {
    const parsed = new URL(rawUrl.trim());
    const host = parsed.hostname;
    const defaultPort = parsed.protocol === "wss:" || parsed.protocol === "https:" ? 443 : 80;
    const port = parsed.port ? Number(parsed.port) : defaultPort;
    const res = await probeTcpPort(host, port, timeoutMs);
    return {
      configured: true,
      url: rawUrl.trim(),
      host,
      port,
      reachable: res.reachable,
      error: res.error,
    };
  } catch (err) {
    return {
      configured: true,
      url: rawUrl.trim(),
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface StackStatusReport {
  timestamp: string;
  platform: string;
  endpoint: string;
  mode: "local" | "remote";
  mailroom: {
    ok: boolean;
    error?: string;
    agents: Array<{ agent_id: string; tier: string; role: string; online: boolean; last_heartbeat: string }>;
    pending_approvals: Array<{ short_code: string; task_id: string | null; action_summary: string; expires_at: string }>;
    recent_tasks: Array<{ task_id: string; project: string; status: string; driver: string | null; updated_at: string }>;
  };
  napcat: {
    o1: TcpProbeResult;
    k1: TcpProbeResult;
  };
  workstation: {
    config_path: string;
    exists: boolean;
    node_id?: string;
    workspaces: string[];
    enabled_engineers: string[];
    active_worktrees: number;
  };
  supervisor: {
    running: boolean;
    pid?: number;
    started_at?: string;
    children?: Record<string, { state: string; pid?: number; restarts: number }>;
  };
}

export async function collectStackStatus(repoRoot: string): Promise<StackStatusReport> {
  const endpoint = process.env.DECK_ENDPOINT || "file://./.deck/mailroom";
  const isRemote = endpoint.startsWith("http://") || endpoint.startsWith("https://");

  const [napcatO1, napcatK1] = await Promise.all([
    probeEndpointUrl(process.env.NAPCAT_O1_WS_URL),
    probeEndpointUrl(process.env.NAPCAT_K1_WS_URL),
  ]);

  const wsPath = path.resolve(repoRoot, process.env.DECK_WORKSTATION_CONFIG ?? ".deck/workstation.yaml");
  const wsInfo: StackStatusReport["workstation"] = {
    config_path: wsPath,
    exists: fs.existsSync(wsPath),
    workspaces: [],
    enabled_engineers: [],
    active_worktrees: 0,
  };
  if (wsInfo.exists) {
    try {
      const cfg = loadWorkstationConfig(wsPath);
      wsInfo.node_id = cfg.node_id;
      wsInfo.workspaces = Object.keys(cfg.workspaces);
      wsInfo.enabled_engineers = Object.entries(cfg.engineers)
        .filter(([, e]) => e.enabled)
        .map(([name, e]) => `${name}(${e.driver})`);
      const wtMgr = new WorktreeManager(cfg.worktree_root);
      wsInfo.active_worktrees = wtMgr.listWorktrees().length;
    } catch {
      // keep partial info
    }
  }

  const mailroomInfo: StackStatusReport["mailroom"] = {
    ok: false,
    agents: [],
    pending_approvals: [],
    recent_tasks: [],
  };

  let shouldQueryMailroom = true;
  if (isRemote) {
    const tcp = await probeEndpointUrl(endpoint, 1500);
    if (!tcp.reachable) {
      shouldQueryMailroom = false;
      mailroomInfo.error = `Relay unreachable at ${endpoint} (${tcp.error ?? "connection failed"})`;
    }
  }

  if (shouldQueryMailroom) {
    const token =
      process.env.DECK_TOKEN_BOSS ||
      process.env.DECK_TOKEN_KUMI_O1 ||
      process.env.DECK_TOKEN_DISPATCHER ||
      process.env.DECK_RELAY_ADMIN_TOKEN;
    const client = createMailroomClient(endpoint, token);
    try {
      const [agents, approvals, tasks] = await Promise.all([
        client.listAgents(),
        client.listApprovals("pending"),
        client.listTasks(),
      ]);
      mailroomInfo.ok = true;
      mailroomInfo.agents = agents.map((a) => ({
        agent_id: a.agent_id,
        tier: a.tier,
        role: a.role,
        online: a.online,
        last_heartbeat: a.last_heartbeat,
      }));
      mailroomInfo.pending_approvals = approvals.map((a) => ({
        short_code: a.short_code,
        task_id: a.task_id,
        action_summary: a.action_summary,
        expires_at: a.expires_at,
      }));
      mailroomInfo.recent_tasks = tasks.slice(0, 5).map((t) => ({
        task_id: t.task_id,
        project: t.project,
        status: t.status,
        driver: t.driver,
        updated_at: t.updated_at,
      }));
    } catch (err) {
      mailroomInfo.error = err instanceof Error ? err.message : String(err);
    } finally {
      client.close();
    }
  }

  const statusFile = path.resolve(repoRoot, ".deck", "runtime-status.json");
  let supInfo: StackStatusReport["supervisor"] = { running: false };
  if (fs.existsSync(statusFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(statusFile, "utf8")) as {
        pid?: number;
        started_at?: string;
        children?: Record<string, { state: string; pid?: number; restarts: number }>;
      };
      if (parsed.pid && isPidAlive(parsed.pid)) {
        supInfo = {
          running: true,
          pid: parsed.pid,
          started_at: parsed.started_at,
          children: parsed.children,
        };
      }
    } catch {
      // ignore corrupted status file
    }
  }

  return {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    endpoint,
    mode: isRemote ? "remote" : "local",
    mailroom: mailroomInfo,
    napcat: { o1: napcatO1, k1: napcatK1 },
    workstation: wsInfo,
    supervisor: supInfo,
  };
}

function splitShellArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function expandHomeInArg(arg: string): string {
  if (arg === "~") return os.homedir();
  if (arg.startsWith("~/") || arg.startsWith("~\\")) {
    return path.join(os.homedir(), arg.slice(2));
  }
  return arg;
}

function terminateChild(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 4000 });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
}

export interface SupervisorOptions {
  repoRoot: string;
  cliEntryPath: string;
  profile: "o1" | "k1";
  withRelay?: boolean;
  includeQq?: boolean;
  includeDispatch?: boolean;
  includeTunnel?: boolean;
}

export async function runSupervisor(options: SupervisorOptions): Promise<void> {
  const deckDir = path.resolve(options.repoRoot, ".deck");
  fs.mkdirSync(deckDir, { recursive: true });
  const statusFile = path.join(deckDir, "runtime-status.json");
  const startedAt = new Date().toISOString();

  interface ServiceSpec {
    name: string;
    command: string;
    args: string[];
    delayMs?: number;
  }

  const specs: ServiceSpec[] = [];

  // 1. Optional SSH tunnel (configured via DECK_SSH_TUNNEL_ARGS in .env)
  const tunnelArgsRaw = process.env.DECK_SSH_TUNNEL_ARGS?.trim();
  if (options.includeTunnel !== false && tunnelArgsRaw) {
    specs.push({
      name: "ssh-tunnel",
      command: "ssh",
      args: splitShellArgs(tunnelArgsRaw).map(expandHomeInArg),
    });
  }

  // 2. Optional local Relay server
  if (options.withRelay) {
    specs.push({
      name: "relay",
      command: process.execPath,
      args: ["--no-warnings", options.cliEntryPath, "relay"],
    });
  }

  const baseDelay = specs.length > 0 ? 2000 : 0;

  // 3. Desktop Foreman Dispatcher (T2)
  if (options.includeDispatch !== false) {
    specs.push({
      name: "dispatch",
      command: process.execPath,
      args: ["--no-warnings", options.cliEntryPath, "dispatch"],
      delayMs: baseDelay,
    });
  }

  // 4. QQ Bridge (O1 or K1)
  if (options.includeQq !== false) {
    specs.push({
      name: `qq-bridge:${options.profile}`,
      command: process.execPath,
      args: ["--no-warnings", options.cliEntryPath, "qq-bridge", "--profile", options.profile],
      delayMs: baseDelay + 500,
    });
  }

  if (specs.length === 0) {
    throw new Error("No services selected for `deck up`. Remove --no-qq / --no-dispatch or pass --with-relay.");
  }

  const stateMap: Record<string, { state: string; pid?: number; restarts: number; last_exit?: number | null }> = {};
  const activeChildren = new Map<string, ChildProcess>();
  const timers = new Set<NodeJS.Timeout>();
  let stopping = false;

  const writeStatus = () => {
    try {
      fs.writeFileSync(
        statusFile,
        JSON.stringify(
          {
            pid: process.pid,
            started_at: startedAt,
            updated_at: new Date().toISOString(),
            children: stateMap,
          },
          null,
          2
        )
      );
    } catch {
      // non-fatal
    }
  };

  const logPrefixed = (name: string, chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      console.error(`[${new Date().toISOString().slice(11, 19)}][${name}] ${line}`);
    }
  };

  const launchSpec = (spec: ServiceSpec, backoffMs = 2000) => {
    if (stopping) return;
    const prev = stateMap[spec.name] ?? { state: "starting", restarts: 0 };
    const spawnedAt = Date.now();
    const child = spawn(spec.command, spec.args, {
      cwd: options.repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.set(spec.name, child);
    stateMap[spec.name] = { state: "running", pid: child.pid, restarts: prev.restarts };
    writeStatus();
    console.error(`[supervisor] Started ${spec.name} (pid=${child.pid ?? "?"})`);

    child.stdout?.on("data", (d: Buffer) => logPrefixed(spec.name, d));
    child.stderr?.on("data", (d: Buffer) => logPrefixed(spec.name, d));

    child.on("close", (code) => {
      activeChildren.delete(spec.name);
      if (stopping) {
        stateMap[spec.name] = { state: "stopped", restarts: prev.restarts, last_exit: code };
        writeStatus();
        return;
      }
      const livedMs = Date.now() - spawnedAt;
      const nextBackoff = livedMs > 60_000 ? 2000 : Math.min(30_000, backoffMs * 2);
      const restarts = (stateMap[spec.name]?.restarts ?? 0) + 1;
      stateMap[spec.name] = { state: "restarting", restarts, last_exit: code };
      writeStatus();
      console.error(`[supervisor] ${spec.name} exited (code=${code ?? "?"}); restarting in ${backoffMs / 1000}s...`);
      const t = setTimeout(() => {
        timers.delete(t);
        launchSpec(spec, nextBackoff);
      }, backoffMs);
      timers.add(t);
    });
  };

  for (const spec of specs) {
    stateMap[spec.name] = { state: "scheduled", restarts: 0 };
    if (spec.delayMs && spec.delayMs > 0) {
      const t = setTimeout(() => {
        timers.delete(t);
        launchSpec(spec);
      }, spec.delayMs);
      timers.add(t);
    } else {
      launchSpec(spec);
    }
  }
  writeStatus();

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.error("\n[supervisor] Shutting down Harness-Deck stack...");
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const child of activeChildren.values()) {
      terminateChild(child);
    }
    activeChildren.clear();
    try {
      fs.rmSync(statusFile, { force: true });
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep supervisor alive indefinitely until SIGINT/SIGTERM
  await new Promise<void>(() => {});
}

export function manageDaemonAutostart(params: {
  action: "script" | "install" | "uninstall";
  repoRoot: string;
  cliEntryPath: string;
  profile: "o1" | "k1";
  apply: boolean;
}): { platform: string; scriptPath: string; commandHint: string; applied: boolean } {
  const deckDir = path.resolve(params.repoRoot, ".deck");
  fs.mkdirSync(deckDir, { recursive: true });
  const taskName = `HarnessDeckPilot_${params.profile.toUpperCase()}`;

  if (process.platform === "win32") {
    const psPath = path.join(deckDir, `start-harness-deck-${params.profile}.ps1`);
    const psContent = [
      "# Auto-generated by `pnpm deck daemon` (Harness-Deck Unattended Supervisor)",
      `$ErrorActionPreference = "Continue"`,
      `Set-Location "${params.repoRoot}"`,
      `& "${process.execPath}" --no-warnings "${params.cliEntryPath}" up --profile ${params.profile}`,
      "",
    ].join("\r\n");
    fs.writeFileSync(psPath, psContent, "utf8");

    const createCmd = `schtasks /Create /TN "${taskName}" /SC ONLOGON /RL LIMITED /F /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \\"${psPath}\\""`;
    const deleteCmd = `schtasks /Delete /TN "${taskName}" /F`;

    if (params.action === "install" && params.apply) {
      execFileSync(
        "schtasks",
        [
          "/Create",
          "/TN",
          taskName,
          "/SC",
          "ONLOGON",
          "/RL",
          "LIMITED",
          "/F",
          "/TR",
          `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${psPath}"`,
        ],
        { stdio: "inherit" }
      );
      return { platform: "win32", scriptPath: psPath, commandHint: createCmd, applied: true };
    }
    if (params.action === "uninstall" && params.apply) {
      execFileSync("schtasks", ["/Delete", "/TN", taskName, "/F"], { stdio: "inherit" });
      return { platform: "win32", scriptPath: psPath, commandHint: deleteCmd, applied: true };
    }
    return {
      platform: "win32",
      scriptPath: psPath,
      commandHint: params.action === "uninstall" ? deleteCmd : createCmd,
      applied: false,
    };
  }

  // POSIX / Linux systemd --user unit
  const unitName = `harness-deck-${params.profile}.service`;
  const unitPath = path.join(deckDir, unitName);
  const unitContent = [
    "[Unit]",
    `Description=Harness-Deck Supervisor (${params.profile.toUpperCase()})`,
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${params.repoRoot}`,
    `ExecStart=${process.execPath} --no-warnings ${params.cliEntryPath} up --profile ${params.profile}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  fs.writeFileSync(unitPath, unitContent, "utf8");

  const installHint = `mkdir -p ~/.config/systemd/user && cp "${unitPath}" ~/.config/systemd/user/${unitName} && systemctl --user daemon-reload && systemctl --user enable --now ${unitName}`;
  const uninstallHint = `systemctl --user disable --now ${unitName} && rm -f ~/.config/systemd/user/${unitName}`;

  if (params.action === "install" && params.apply) {
    const userDir = path.join(os.homedir(), ".config", "systemd", "user");
    fs.mkdirSync(userDir, { recursive: true });
    fs.copyFileSync(unitPath, path.join(userDir, unitName));
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", unitName], { stdio: "inherit" });
    return { platform: process.platform, scriptPath: unitPath, commandHint: installHint, applied: true };
  }
  if (params.action === "uninstall" && params.apply) {
    execFileSync("systemctl", ["--user", "disable", "--now", unitName], { stdio: "inherit" });
    return { platform: process.platform, scriptPath: unitPath, commandHint: uninstallHint, applied: true };
  }
  return {
    platform: process.platform,
    scriptPath: unitPath,
    commandHint: params.action === "uninstall" ? uninstallHint : installHint,
    applied: false,
  };
}
