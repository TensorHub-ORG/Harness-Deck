import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SshDeployOptions {
  host: string;
  port: number;
  user: string;
  keyPath?: string;
  remoteDir: string;
  scope: "o1_only" | "o1_and_k1";
  relayPort: number;
  envFilePath: string;
  repoRoot: string;
  runtime?: "auto" | "docker" | "native";
  withQqBridge?: boolean;
  dryRun?: boolean;
}

function expandHomePath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return path.resolve(p);
}

function buildSshBaseArgs(opts: SshDeployOptions): string[] {
  const args = [
    "-p",
    String(opts.port),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  if (opts.keyPath) {
    args.push("-i", expandHomePath(opts.keyPath));
  }
  return args;
}

function buildScpBaseArgs(opts: SshDeployOptions): string[] {
  const args = ["-P", String(opts.port), "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];
  if (opts.keyPath) {
    args.push("-i", expandHomePath(opts.keyPath));
  }
  return args;
}

export function runRemoteSshDeploy(opts: SshDeployOptions): {
  dry_run: boolean;
  target: string;
  remote_dir: string;
  commands: string[];
  relay_url: string;
  napcat_o1_webui: string;
  napcat_k1_webui?: string;
  ssh_tunnel_hint: string;
} {
  const target = `${opts.user}@${opts.host}`;
  const sshArgs = buildSshBaseArgs(opts);
  const scpArgs = buildScpBaseArgs(opts);
  const remoteDeploySrc = path.resolve(opts.repoRoot, "deploy", "remote");
  const composeFile = path.join(remoteDeploySrc, "docker-compose.vps.yml");
  const setupDockerScript = path.join(remoteDeploySrc, "setup-vps.sh");
  const setupNativeScript = path.join(remoteDeploySrc, "setup-vps-native.sh");
  const relayDockerfile = path.join(remoteDeploySrc, "Dockerfile.deck-runtime");
  const napcatTemplate = path.resolve(opts.repoRoot, "deploy", "napcat", "onebot11.template.json");

  const profileFlag = opts.scope === "o1_and_k1" ? "--profile k1" : "";
  const nativeQqFlag = opts.withQqBridge ? "--with-qq-bridge" : "";
  const requestedRuntime = opts.runtime ?? "auto";
  const tarballName = "harness-deck-runtime.tar.gz";
  const tmpTarball = path.join(os.tmpdir(), tarballName);
  const tarEntries = [
    "package.json",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "protocol",
    "packages",
    "mcps",
    "adapters",
    "skills",
  ];

  const remoteRunSnippet =
    requestedRuntime === "native"
      ? `./setup-vps-native.sh ${nativeQqFlag} ${profileFlag}`.trim()
      : requestedRuntime === "docker"
        ? `./setup-vps.sh ${profileFlag}`.trim()
        : `if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then ./setup-vps.sh ${profileFlag}; else ./setup-vps-native.sh ${nativeQqFlag} ${profileFlag}; fi`;

  const commands = [
    `tar -czf "${tmpTarball}" --exclude=node_modules --exclude=.deck --exclude=.env ${tarEntries.join(" ")}`,
    `ssh ${sshArgs.join(" ")} ${target} "mkdir -p ${opts.remoteDir}/napcat-o1/config ${opts.remoteDir}/napcat-k1/config ${opts.remoteDir}/data"`,
    `scp ${scpArgs.join(" ")} "${tmpTarball}" "${composeFile}" "${setupDockerScript}" "${setupNativeScript}" "${relayDockerfile}" "${napcatTemplate}" "${opts.envFilePath}" ${target}:${opts.remoteDir}/`,
    `ssh ${sshArgs.join(" ")} ${target} "cd ${opts.remoteDir} && tar -xzf ${tarballName} && rm -f ${tarballName} && sed -i 's/\\r$//' setup-vps.sh setup-vps-native.sh && chmod +x setup-vps.sh setup-vps-native.sh && ${remoteRunSnippet}"`,
  ];

  const keyHint = opts.keyPath ? `-i "${opts.keyPath}" ` : "";
  const summary = {
    dry_run: Boolean(opts.dryRun),
    runtime: requestedRuntime,
    target,
    remote_dir: opts.remoteDir,
    commands,
    relay_url: `http://127.0.0.1:${opts.relayPort}`,
    napcat_o1_webui: `http://127.0.0.1:6099/webui`,
    napcat_k1_webui: opts.scope === "o1_and_k1" ? `http://127.0.0.1:6100/webui` : undefined,
    ssh_tunnel_hint: `ssh -N -p ${opts.port} ${keyHint}-L ${opts.relayPort}:127.0.0.1:${opts.relayPort} ${target}`,
  };

  if (opts.dryRun) {
    return summary;
  }

  // 1. Pack clean runtime archive (no node_modules, no local .deck state)
  execFileSync(
    "tar",
    [
      "-czf",
      tmpTarball,
      "--exclude=node_modules",
      "--exclude=.deck",
      "--exclude=.env",
      ...tarEntries.filter((e) => fs.existsSync(path.join(opts.repoRoot, e))),
    ],
    { cwd: opts.repoRoot, stdio: "inherit", timeout: 60_000 }
  );

  try {
    // 2. Preflight SSH connectivity check
    execFileSync("ssh", [...sshArgs, target, "echo SSH_PREFLIGHT_OK"], {
      stdio: "inherit",
      timeout: 20_000,
    });

    // 3. Create remote directories
    execFileSync(
      "ssh",
      [
        ...sshArgs,
        target,
        `mkdir -p ${opts.remoteDir}/napcat-o1/config ${opts.remoteDir}/napcat-k1/config ${opts.remoteDir}/data`,
      ],
      { stdio: "inherit", timeout: 20_000 }
    );

    // 4. Upload runtime archive + deployment scripts + rendered .env
    const filesToCopy = [
      tmpTarball,
      composeFile,
      setupDockerScript,
      setupNativeScript,
      relayDockerfile,
      napcatTemplate,
    ].filter((f) => fs.existsSync(f));
    if (fs.existsSync(opts.envFilePath)) {
      filesToCopy.push(opts.envFilePath);
    }
    execFileSync("scp", [...scpArgs, ...filesToCopy, `${target}:${opts.remoteDir}/`], {
      stdio: "inherit",
      timeout: 120_000,
    });

    // 5. Extract and execute appropriate bootstrap script (Docker OR Native systemd)
    execFileSync(
      "ssh",
      [
        ...sshArgs,
        target,
        `cd ${opts.remoteDir} && tar -xzf ${tarballName} && rm -f ${tarballName} && sed -i 's/\\r$//' setup-vps.sh setup-vps-native.sh && chmod +x setup-vps.sh setup-vps-native.sh && ${remoteRunSnippet}`,
      ],
      { stdio: "inherit", timeout: 240_000 }
    );
  } finally {
    fs.rmSync(tmpTarball, { force: true });
  }

  return summary;
}
