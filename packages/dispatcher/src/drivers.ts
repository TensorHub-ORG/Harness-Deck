import fs from "node:fs";
import path from "node:path";
import { SandboxProfile, TaskDispatchPayload } from "@harness-deck/protocol";

export type DriverId =
  | "dsh-cli"
  | "claude-code-cli"
  | "codex-cli"
  | "agy-cli"
  | "zcode-cli"
  | "coomi-cli"
  | "custom-cli"
  | "mock-cli";

export interface BuiltCommand {
  command: string;
  args: string[];
  stdinText?: string;
  env?: Record<string, string>;
}

export interface DriverSpec {
  id: DriverId;
  defaultBinary: string;
  aliases: string[];
  supportsResume: boolean;
  buildCommand(params: {
    binary: string;
    prompt: string;
    sandbox: SandboxProfile;
    task: TaskDispatchPayload;
    cwd: string;
    commandTemplate?: string[];
  }): BuiltCommand;
  parseProgressLine?(line: string): { stage?: string; sessionId?: string } | null;
  extractFinalText?(stdout: string): string | null;
}

/**
 * On Windows, npm global CLIs are `.cmd` shims that invoke `node <dp0>\node_modules\...\bin.js`.
 * Spawning `.cmd` via `shell: true` (cmd.exe) corrupts multiline UTF-8 prompts and quotes.
 * Unwrapping the shim directly to `process.execPath` + script avoids cmd.exe completely.
 */
export function unwrapWindowsNpmShim(binary: string): { command: string; prefixArgs: string[] } {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(binary) && fs.existsSync(binary)) {
    try {
      const content = fs.readFileSync(binary, "utf8");
      const match = content.match(/"%dp0%\\([^"]+\.(?:c?m?js))"/i);
      if (match?.[1]) {
        const scriptPath = path.resolve(path.dirname(binary), match[1]);
        if (fs.existsSync(scriptPath)) {
          return { command: process.execPath, prefixArgs: [scriptPath] };
        }
      }
    } catch {
      // Fallback to original binary
    }
  }
  return { command: binary, prefixArgs: [] };
}

export function buildTaskPrompt(task: TaskDispatchPayload, handoffNote?: string): string {
  const lines = [
    `[Harness-Deck Task ${task.task_id}] Project: ${task.project}`,
    `Title: ${task.title}`,
    `Sandbox Profile: ${task.sandbox_profile}`,
    "",
    "Instruction:",
    task.instruction,
  ];
  if (handoffNote) {
    lines.push("", "Additional Context / Previous Feedback:", handoffNote);
  }
  lines.push(
    "",
    "Execution Rules:",
    "- You are a T2 Engineer executing an authorized work order from T1 Secretary (Coomi O1).",
    "- Keep your final answer concise, factual, and plain text (no unnecessary boilerplate).",
    "- Report exact results, file paths, or error messages. Never fabricate output or leak API keys/secrets."
  );
  return lines.join("\n");
}

export const BUILTIN_DRIVERS: Record<DriverId, DriverSpec> = {
  "dsh-cli": {
    id: "dsh-cli",
    defaultBinary: "dsh",
    aliases: ["dsh"],
    supportsResume: true,
    buildCommand({ binary, prompt, sandbox, task, cwd }) {
      const { command, prefixArgs } = unwrapWindowsNpmShim(binary);
      const profile = process.env.DECK_DSH_PROFILE || "headless";
      const args = [...prefixArgs, "--profile", profile];
      if (process.env.DECK_DSH_PATCH && fs.existsSync(process.env.DECK_DSH_PATCH)) {
        args.push("--patch", path.resolve(process.env.DECK_DSH_PATCH));
      }
      args.push("--json", "--approval-policy", "never");
      if (sandbox === "L1_READONLY") {
        args.push("--permission-mode", "read-only");
      } else {
        args.push("--add-dir", cwd);
      }
      if (task.resume_session_id) {
        args.push("--session-id", task.resume_session_id);
      }
      // `-` tells `dsh --profile headless` to read the full UTF-8 multiline task from stdin
      args.push("-");
      return { command, args, stdinText: prompt };
    },
    parseProgressLine(line) {
      try {
        const obj = JSON.parse(line) as { type?: string; phase?: string; sessionId?: string; turn?: number; step?: number };
        if (obj.type === "session" && obj.sessionId) {
          return { stage: "dsh:session_ready", sessionId: obj.sessionId };
        }
        if (obj.type === "status" && obj.phase) {
          return { stage: `dsh:${obj.phase}${obj.step ? `#${obj.step}` : ""}` };
        }
        return null;
      } catch {
        return null;
      }
    },
    extractFinalText(stdout) {
      const texts: string[] = [];
      let finalText: string | null = null;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const obj = JSON.parse(line) as { type?: string; text?: string };
          if (obj.type === "final" && typeof obj.text === "string" && obj.text.trim()) {
            finalText = obj.text.trim();
          } else if (obj.type === "text" && typeof obj.text === "string" && obj.text.trim()) {
            texts.push(obj.text.trim());
          }
        } catch {
          // ignore non-json
        }
      }
      return finalText ?? (texts.length > 0 ? texts.join("\n") : null);
    },
  },
  "claude-code-cli": {
    id: "claude-code-cli",
    defaultBinary: "claude",
    aliases: ["claude", "claude-code"],
    supportsResume: true,
    buildCommand({ binary, prompt, sandbox, task }) {
      const { command, prefixArgs } = unwrapWindowsNpmShim(binary);
      const args = [...prefixArgs, "-p", prompt, "--output-format", "stream-json"];
      if (sandbox === "L1_READONLY") {
        args.push("--permission-mode", "plan");
      } else if (sandbox === "L2_WORKTREE_DEV") {
        args.push("--permission-mode", "acceptEdits");
      }
      if (task.resume_session_id) {
        args.push("--resume", task.resume_session_id);
      }
      return { command, args };
    },
    parseProgressLine(line) {
      try {
        const obj = JSON.parse(line) as { type?: string; session_id?: string; subtype?: string };
        return {
          stage: obj.type ? `claude:${obj.type}${obj.subtype ? `/${obj.subtype}` : ""}` : undefined,
          sessionId: obj.session_id,
        };
      } catch {
        return null;
      }
    },
  },
  "codex-cli": {
    id: "codex-cli",
    defaultBinary: "codex",
    aliases: ["codex"],
    supportsResume: false,
    buildCommand({ binary, prompt, sandbox }) {
      const mode =
        sandbox === "L1_READONLY"
          ? "read-only"
          : sandbox === "L2_WORKTREE_DEV"
            ? "workspace-write"
            : "danger-full-access";
      return {
        command: binary,
        args: ["exec", prompt, "--json", "--sandbox", mode],
      };
    },
    parseProgressLine(line) {
      try {
        const obj = JSON.parse(line) as { type?: string };
        return obj.type ? { stage: `codex:${obj.type}` } : null;
      } catch {
        return null;
      }
    },
  },
  "agy-cli": {
    id: "agy-cli",
    defaultBinary: "agy",
    aliases: ["agy", "antigravity"],
    supportsResume: true,
    buildCommand({ binary, prompt, sandbox, task, cwd }) {
      const args = ["--print", prompt, "--output-format", "text", "--print-timeout", `${task.timeout_sec}s`];
      if (sandbox === "L1_READONLY") {
        args.push("--mode", "plan");
      } else if (sandbox === "L2_WORKTREE_DEV") {
        args.push("--mode", "accept-edits", "--add-dir", cwd);
      } else {
        args.push("--mode", "auto", "--dangerously-skip-permissions", "--add-dir", cwd);
      }
      if (task.resume_session_id) {
        args.push("--conversation", task.resume_session_id);
      }
      return { command: binary, args };
    },
  },
  "zcode-cli": {
    id: "zcode-cli",
    defaultBinary: "zcode",
    aliases: ["zcode"],
    supportsResume: false,
    buildCommand({ binary, prompt }) {
      return { command: binary, args: ["run", prompt] };
    },
  },
  "coomi-cli": {
    id: "coomi-cli",
    defaultBinary: "coomi",
    aliases: ["coomi"],
    supportsResume: false,
    buildCommand({ binary, prompt }) {
      return { command: binary, args: ["run", "--prompt", prompt] };
    },
  },
  "custom-cli": {
    id: "custom-cli",
    defaultBinary: "node",
    aliases: ["custom"],
    supportsResume: false,
    buildCommand({ binary, prompt, cwd, task, commandTemplate }) {
      const tpl = commandTemplate ?? [binary, "{{prompt}}"];
      const expanded = tpl.map((part) =>
        part
          .replaceAll("{{prompt}}", prompt)
          .replaceAll("{{cwd}}", cwd)
          .replaceAll("{{task_id}}", task.task_id)
          .replaceAll("{{project}}", task.project)
      );
      return {
        command: expanded[0] ?? binary,
        args: expanded.slice(1),
      };
    },
  },
  "mock-cli": {
    id: "mock-cli",
    defaultBinary: process.execPath,
    aliases: ["mock"],
    supportsResume: true,
    buildCommand({ task }) {
      const script = [
        `console.log("MOCK_PROGRESS: Analyzing task ${task.task_id} for ${task.project}");`,
        `console.log("MOCK_SUMMARY: Completed mock task '${task.title.replace(/"/g, "'")}' cleanly.");`,
      ].join(" ");
      return {
        command: process.execPath,
        args: ["-e", script],
      };
    },
    parseProgressLine(line) {
      if (line.startsWith("MOCK_PROGRESS:")) {
        return { stage: line.slice("MOCK_PROGRESS:".length).trim() };
      }
      return null;
    },
  },
};

export function resolveDriverSpec(driverNameOrAlias: string): DriverSpec | null {
  if (driverNameOrAlias in BUILTIN_DRIVERS) {
    return BUILTIN_DRIVERS[driverNameOrAlias as DriverId];
  }
  const lower = driverNameOrAlias.toLowerCase();
  for (const spec of Object.values(BUILTIN_DRIVERS)) {
    if (spec.aliases.includes(lower) || spec.defaultBinary === lower) {
      return spec;
    }
  }
  return null;
}
