import { ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  DeckEnvelope,
  TaskDispatchPayload,
  TaskDispatchPayloadSchema,
  WorkstationConfig,
  WorkstationConfigSchema,
  scrubSecrets,
} from "@harness-deck/protocol";
import { MailroomClient } from "@harness-deck/mailroom";
import { BUILTIN_DRIVERS, DriverId, buildTaskPrompt, resolveDriverSpec } from "./drivers.js";
import { WorktreeManager } from "./worktree.js";

export function loadWorkstationConfig(configPath: string): WorkstationConfig {
  const raw = fs.readFileSync(path.resolve(configPath), "utf8");
  const parsed = YAML.parse(raw);
  return WorkstationConfigSchema.parse(parsed);
}

export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
      });
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already exited
        }
      }, 3000);
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
}

export interface DispatcherOptions {
  client: MailroomClient;
  workstation: WorkstationConfig;
  agentId?: string;
  secretaryId?: string;
  pollIntervalMs?: number;
  logger?: (msg: string) => void;
}

/**
 * Deck Dispatcher (Desktop Foreman — T2 Worker):
 * - Registers workstation capabilities & allowlisted workspaces with Mailroom
 * - Receives `task.dispatch` & `task.cancel` over outbound WebSocket or local polling
 * - Creates isolated `git worktree` per L2/L3 task
 * - Supervises CLI engineers (dsh / claude / codex / agy / zcode / coomi / custom / mock)
 * - Guarantees result delivery via Dual-Insurance Fallback (active MCP OR auto-synthesized capture)
 */
export class DeckDispatcher {
  private readonly agentId: string;
  private readonly secretaryId: string;
  private readonly worktrees: WorktreeManager;
  private readonly activeChildren = new Map<string, ChildProcess>();
  private readonly runningTasks = new Set<string>();
  private readonly processingEnvelopeIds = new Set<string>();
  private readonly log: (msg: string) => void;
  private pollTimer: NodeJS.Timeout | null = null;
  private hbTimer: NodeJS.Timeout | null = null;
  private unsubscribeWs: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly options: DispatcherOptions) {
    this.agentId = options.agentId ?? `dispatcher-${options.workstation.node_id}`;
    this.secretaryId = options.secretaryId ?? "kumi-o1";
    this.worktrees = new WorktreeManager(options.workstation.worktree_root);
    this.log = options.logger ?? ((msg) => console.error(`[dispatcher] ${msg}`));
  }

  public async start(): Promise<void> {
    this.stopped = false;
    await this.registerWorkstation();

    if (this.options.client.subscribeEnvelopes) {
      this.unsubscribeWs = this.options.client.subscribeEnvelopes(this.agentId, (env) => {
        void this.handleEnvelope(env);
      });
    }

    const pollMs = this.options.pollIntervalMs ?? 2500;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, pollMs);

    this.hbTimer = setInterval(() => {
      void this.options.client.heartbeat(this.agentId, this.buildMetadata());
    }, 30_000);

    await this.pollOnce();
    this.log(`Started node "${this.agentId}" (mode=${this.options.client.mode}).`);
  }

  public stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.unsubscribeWs) this.unsubscribeWs();
    for (const child of this.activeChildren.values()) {
      killProcessTree(child);
    }
    this.activeChildren.clear();
  }

  private buildMetadata(): Record<string, unknown> {
    return {
      node_id: this.options.workstation.node_id,
      platform: this.options.workstation.platform,
      workspaces: Object.keys(this.options.workstation.workspaces),
      engineers: Object.entries(this.options.workstation.engineers)
        .filter(([, cfg]) => cfg.enabled)
        .map(([name, cfg]) => ({ name, driver: cfg.driver, strengths: cfg.strengths })),
      active_tasks: Array.from(this.runningTasks),
      max_concurrent_tasks: this.options.workstation.max_concurrent_tasks,
    };
  }

  public async registerWorkstation(): Promise<void> {
    await this.options.client.registerAgent({
      agent_id: this.agentId,
      role: "worker",
      tier: "T2",
      reports_to: this.secretaryId,
      display_name: `Desktop Foreman (${this.options.workstation.node_id})`,
      metadata: this.buildMetadata(),
    });
  }

  public async pollOnce(): Promise<number> {
    if (this.stopped) return 0;
    const inbox = await this.options.client.pullInbox(this.agentId, {
      types: ["task.dispatch", "task.cancel", "task.answer"],
      limit: 10,
    });
    let handled = 0;
    for (const env of inbox) {
      await this.handleEnvelope(env);
      handled += 1;
    }
    return handled;
  }

  private selectEngineer(task: TaskDispatchPayload): {
    name: string;
    driver: DriverId;
    binary?: string;
    commandTemplate?: string[];
  } | null {
    const enabled = Object.entries(this.options.workstation.engineers).filter(([, c]) => c.enabled);
    if (enabled.length === 0) return null;

    const candidates = [task.preferred_driver, ...task.fallback_drivers].filter(Boolean) as string[];
    for (const cand of candidates) {
      const spec = resolveDriverSpec(cand);
      const exact = enabled.find(([name, cfg]) => name === cand || (spec && cfg.driver === spec.id));
      if (exact) {
        return {
          name: exact[0],
          driver: exact[1].driver,
          binary: exact[1].binary,
          commandTemplate: exact[1].command_template,
        };
      }
    }

    const first = enabled[0]!;
    return {
      name: first[0],
      driver: first[1].driver,
      binary: first[1].binary,
      commandTemplate: first[1].command_template,
    };
  }

  public async handleEnvelope(env: DeckEnvelope): Promise<void> {
    if (this.processingEnvelopeIds.has(env.id)) return;
    this.processingEnvelopeIds.add(env.id);
    try {
      await this.handleEnvelopeInner(env);
    } finally {
      this.processingEnvelopeIds.delete(env.id);
    }
  }

  private async handleEnvelopeInner(env: DeckEnvelope): Promise<void> {
    if (env.type === "task.cancel") {
      const taskId = String(env.payload.task_id ?? "");
      const child = this.activeChildren.get(taskId);
      if (child) {
        this.log(`Cancelling running task ${taskId}`);
        killProcessTree(child);
        this.activeChildren.delete(taskId);
      }
      await this.options.client.ackEnvelope(env.id, this.agentId);
      return;
    }

    if (env.type !== "task.dispatch") {
      await this.options.client.ackEnvelope(env.id, this.agentId);
      return;
    }

    if (this.runningTasks.size >= this.options.workstation.max_concurrent_tasks) {
      // Leave unacked in queue until a slot frees up
      return;
    }

    const task = TaskDispatchPayloadSchema.parse(env.payload);
    if (this.runningTasks.has(task.task_id)) return;

    // Check TTL expiration so sleeping PCs do not run stale commands days later
    if (task.expires_at && Date.now() > Date.parse(task.expires_at)) {
      await this.options.client.ackEnvelope(env.id, this.agentId);
      await this.reportResult(env, task, "none", {
        status: "cancelled",
        summary: `Task ${task.task_id} expired before execution (expires_at=${task.expires_at}).`,
        synthesized_by_dispatcher: true,
      });
      return;
    }

    await this.options.client.ackEnvelope(env.id, this.agentId);
    this.runningTasks.add(task.task_id);
    try {
      await this.executeTask(env, task);
    } finally {
      this.runningTasks.delete(task.task_id);
      this.activeChildren.delete(task.task_id);
    }
  }

  private async executeTask(env: DeckEnvelope, task: TaskDispatchPayload): Promise<void> {
    const wsCfg = this.options.workstation.workspaces[task.project];
    if (!wsCfg) {
      await this.reportResult(env, task, "none", {
        status: "failed",
        summary: `WORKSPACE_DENIED: Project "${task.project}" is not in workstation allowlist (${Object.keys(this.options.workstation.workspaces).join(", ") || "empty"}).`,
        synthesized_by_dispatcher: true,
      });
      return;
    }

    const engineer = this.selectEngineer(task);
    if (!engineer) {
      await this.reportResult(env, task, "none", {
        status: "failed",
        summary: "NO_ENGINEER_AVAILABLE: No enabled CLI engineer found in workstation.yaml.",
        synthesized_by_dispatcher: true,
      });
      return;
    }

    const driverSpec = BUILTIN_DRIVERS[engineer.driver];
    const prepared = this.worktrees.prepare({
      repoPath: wsCfg.path,
      taskId: task.task_id,
      sandbox: task.sandbox_profile,
      gitIsolation: wsCfg.git_isolation,
      existingBranch: task.existing_branch,
    });

    await this.options.client.sendEnvelope({
      trace_id: env.trace_id,
      from: { agent_id: this.agentId, role: "worker", tier: "T2" },
      to: { agent_id: env.from.agent_id, role: "secretary", tier: "T1" },
      type: "task.progress",
      payload: {
        task_id: task.task_id,
        driver: engineer.name,
        stage: prepared.isolated
          ? `Prepared isolated git worktree (${prepared.branch}), starting ${engineer.name}`
          : `Starting ${engineer.name} in ${prepared.cwd}`,
        percent: 10,
      },
      hop_count: env.hop_count + 1,
    });

    const prompt = buildTaskPrompt(task);
    const built = driverSpec.buildCommand({
      binary: engineer.binary ?? driverSpec.defaultBinary,
      prompt,
      sandbox: task.sandbox_profile,
      task,
      cwd: prepared.cwd,
      commandTemplate: engineer.commandTemplate,
    });
    this.log(
      `Spawning ${engineer.name} (${task.task_id}) in ${prepared.cwd}: ${built.command} ${built.args
        .map((a) => (a.length > 60 ? `${a.slice(0, 57)}...` : a))
        .join(" ")}`
    );

    let stdoutRaw = "";
    let stderrRaw = "";
    let stdoutLineBuf = "";
    let stderrLineBuf = "";
    let sessionId: string | undefined;
    let lastProgressAt = Date.now();

    const exitCode = await new Promise<number>((resolve) => {
      const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(built.command);
      const hasStdin = built.stdinText !== undefined;
      const child = spawn(built.command, built.args, {
        cwd: prepared.cwd,
        env: {
          ...process.env,
          ...built.env,
          DECK_TASK_ID: task.task_id,
          DECK_TRACE_ID: env.trace_id,
          DECK_SECRETARY_ID: env.from.agent_id,
        },
        stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
        shell: needsShell,
        detached: process.platform !== "win32",
      });

      this.activeChildren.set(task.task_id, child);

      if (hasStdin && child.stdin) {
        child.stdin.write(built.stdinText!, "utf8");
        child.stdin.end();
      }

      const timer = setTimeout(() => {
        stderrRaw += `\n[DISPATCHER] Task timed out after ${task.timeout_sec}s; killing process tree.\n`;
        killProcessTree(child);
      }, task.timeout_sec * 1000);

      const handleProgressLine = (line: string) => {
        if (!line.trim()) return;
        const clean = scrubSecrets(line);
        const parsed = driverSpec.parseProgressLine?.(clean);
        if (parsed?.sessionId) sessionId = parsed.sessionId;
        if (parsed?.stage && Date.now() - lastProgressAt > 15_000) {
          lastProgressAt = Date.now();
          void this.options.client.sendEnvelope({
            trace_id: env.trace_id,
            from: { agent_id: this.agentId, role: "worker", tier: "T2" },
            to: { agent_id: env.from.agent_id, role: "secretary", tier: "T1" },
            type: "task.progress",
            payload: { task_id: task.task_id, driver: engineer.name, stage: parsed.stage },
            hop_count: env.hop_count + 1,
          });
        }
      };

      child.stdout?.on("data", (raw: Buffer) => {
        const chunk = raw.toString("utf8");
        stdoutRaw += chunk;
        stdoutLineBuf += chunk;
        const parts = stdoutLineBuf.split(/\r?\n/);
        stdoutLineBuf = parts.pop() ?? "";
        for (const p of parts) handleProgressLine(p);
      });
      child.stderr?.on("data", (raw: Buffer) => {
        const chunk = raw.toString("utf8");
        stderrRaw += chunk;
        stderrLineBuf += chunk;
        const parts = stderrLineBuf.split(/\r?\n/);
        stderrLineBuf = parts.pop() ?? "";
        for (const p of parts) handleProgressLine(p);
      });
      child.on("error", (err) => {
        stderrRaw += `\n[DISPATCHER_SPAWN_ERROR] ${err.message}\n`;
        clearTimeout(timer);
        resolve(127);
      });
      child.on("close", (code) => {
        if (stdoutLineBuf) handleProgressLine(stdoutLineBuf);
        if (stderrLineBuf) handleProgressLine(stderrLineBuf);
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });

    // Dual-insurance check: did the CLI already submit `task.result` via deck-comm MCP?
    const trace = await this.options.client.getTrace(env.trace_id);
    const alreadySubmitted = trace.some(
      (e) => e.type === "task.result" && String(e.payload.task_id ?? "") === task.task_id
    );
    if (alreadySubmitted) {
      this.log(`Task ${task.task_id} already reported via MCP by ${engineer.name}.`);
      return;
    }

    const diffStat = this.worktrees.collectDiffStat(prepared.cwd);
    const cleanStdout = scrubSecrets(stdoutRaw).trim();
    const cleanStderr = scrubSecrets(stderrRaw).trim();
    const combinedLogParts: string[] = [];
    if (cleanStdout.length > 0) combinedLogParts.push("=== STDOUT ===\n" + cleanStdout);
    if (cleanStderr.length > 0) combinedLogParts.push("=== STDERR ===\n" + cleanStderr);
    const fullLog = combinedLogParts.join("\n\n");

    const attachments = [];
    if (fullLog.length > 0) {
      const logArt = await this.options.client.uploadArtifact({
        filename: `${task.task_id}_${engineer.name}_output.log`,
        data: Buffer.from(fullLog, "utf8"),
        mime_type: "text/plain",
      });
      attachments.push(logArt);
    }

    const extracted = exitCode === 0 ? driverSpec.extractFinalText?.(cleanStdout) : null;
    const primaryText =
      extracted ??
      (exitCode === 0 && cleanStdout.length > 0
        ? cleanStdout
        : [cleanStdout, cleanStderr].filter(Boolean).join("\n") || "(no console output)");
    const tailSummary = primaryText.split(/\r?\n/).slice(-30).join("\n");
    this.log(`Finished ${engineer.name} (${task.task_id}) exit=${exitCode} stdout=${cleanStdout.length}B stderr=${cleanStderr.length}B`);
    await this.reportResult(
      env,
      task,
      engineer.name,
      {
        status: exitCode === 0 ? "success" : "failed",
        summary: scrubSecrets(tailSummary).slice(0, 3800),
        branch: prepared.branch,
        worktree_path: prepared.isolated ? prepared.cwd : undefined,
        diff_stat: diffStat || undefined,
        exit_code: exitCode,
        session_id: sessionId,
        synthesized_by_dispatcher: true,
      },
      attachments
    );
  }

  private async reportResult(
    env: DeckEnvelope,
    task: TaskDispatchPayload,
    driver: string,
    result: {
      status: "success" | "partial" | "failed" | "cancelled";
      summary: string;
      branch?: string;
      worktree_path?: string;
      diff_stat?: string;
      exit_code?: number;
      session_id?: string;
      synthesized_by_dispatcher: boolean;
    },
    attachments: DeckEnvelope["attachments"] = []
  ): Promise<void> {
    await this.options.client.sendEnvelope({
      trace_id: env.trace_id,
      from: { agent_id: this.agentId, role: "worker", tier: "T2" },
      to: { agent_id: env.from.agent_id, role: "secretary", tier: "T1" },
      type: "task.result",
      payload: {
        task_id: task.task_id,
        driver,
        ...result,
      },
      attachments,
      hop_count: env.hop_count + 1,
    });
  }
}
