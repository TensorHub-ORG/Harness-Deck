import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILTIN_DRIVERS, DriverId } from "./drivers.js";

export interface DetectedTool {
  name: string;
  driver?: DriverId;
  installed: boolean;
  path?: string;
  version?: string;
}

export interface EnvironmentReport {
  platform: "windows" | "linux" | "darwin";
  arch: string;
  hostname: string;
  node_version: string;
  runtime_tools: DetectedTool[];
  agent_clis: DetectedTool[];
  scanned_at: string;
}

function locateBinary(bin: string): string | undefined {
  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const out = execFileSync(cmd, [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    const candidates = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (process.platform === "win32") {
      // Prefer .exe / .cmd / .bat over extensionless POSIX shims on Windows
      const preferred = candidates.find((c) => /\.(exe|cmd|bat)$/i.test(c));
      return preferred ?? candidates[0];
    }
    return candidates[0];
  } catch {
    // Fallback to common user-local install directories (e.g. Windows user PATH not inherited by shell)
    if (process.platform === "win32") {
      const home = os.homedir();
      const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
      const fallbackDirs = [
        path.join(localAppData, "agy", "bin"),
        path.join(localAppData, "Programs", "OpenAI", "Codex", "bin"),
        path.join(home, ".local", "bin"),
        path.join(home, ".cargo", "bin"),
      ];
      for (const dir of fallbackDirs) {
        for (const ext of [".exe", ".cmd", ".bat", ""]) {
          const full = path.join(dir, `${bin}${ext}`);
          if (fs.existsSync(full)) return full;
        }
      }
    }
    return undefined;
  }
}

function getVersion(binPath: string, name: string): string | undefined {
  const flags = name === "ssh" ? ["-V"] : ["--version", "-v"];
  const needsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(binPath);
  for (const flag of flags) {
    try {
      const out = execFileSync(binPath, [flag], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: needsShell,
        timeout: 4000,
      }).trim();
      const first = out.split(/\r?\n/)[0]?.trim();
      if (first) return first.slice(0, 80);
    } catch (err) {
      // OpenSSH (`ssh -V`) writes version info to stderr even on exit 0/1
      const e = err as { stderr?: string | Buffer; stdout?: string | Buffer };
      const combined = `${e.stdout?.toString("utf8") ?? ""}\n${e.stderr?.toString("utf8") ?? ""}`.trim();
      const line = combined.split(/\r?\n/).find((l) => /OpenSSH|version|\d+\.\d+/i.test(l));
      if (line) return line.trim().slice(0, 80);
    }
  }
  return undefined;
}

function probe(name: string, binary: string, driver?: DriverId): DetectedTool {
  const binPath = locateBinary(binary);
  if (!binPath) return { name, driver, installed: false };
  return {
    name,
    driver,
    installed: true,
    path: binPath,
    version: getVersion(binPath, name),
  };
}

export function detectLocalEnvironment(): EnvironmentReport {
  const platform =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";

  const runtime_tools: DetectedTool[] = [
    probe("git", "git"),
    probe("pnpm", "pnpm"),
    probe("docker", "docker"),
    probe("ssh", "ssh"),
    probe("scp", "scp"),
    probe("cargo", "cargo"),
  ];

  const cliCandidates: Array<{ name: string; driver: DriverId }> = [
    { name: "dsh", driver: "dsh-cli" },
    { name: "claude", driver: "claude-code-cli" },
    { name: "codex", driver: "codex-cli" },
    { name: "agy", driver: "agy-cli" },
    { name: "zcode", driver: "zcode-cli" },
    { name: "coomi", driver: "coomi-cli" },
  ];

  const agent_clis: DetectedTool[] = cliCandidates.map(({ name, driver }) =>
    probe(name, BUILTIN_DRIVERS[driver].defaultBinary, driver)
  );

  return {
    platform,
    arch: os.arch(),
    hostname: os.hostname(),
    node_version: process.version,
    runtime_tools,
    agent_clis,
    scanned_at: new Date().toISOString(),
  };
}
