import path from "node:path";

export interface McpClientSnippetOptions {
  repoRoot: string;
  endpoint: string;
  agentId: string;
  role: "boss" | "secretary" | "worker" | "frontline";
  tier: "T0" | "T1" | "T2" | "T3";
  token: string;
  includeDispatch?: boolean;
  includeQq?: boolean;
  includeKb?: boolean;
}

export function generateMcpServersMap(opts: McpClientSnippetOptions): Record<string, unknown> {
  const root = path.resolve(opts.repoRoot);
  const sharedEnv: Record<string, string> = {
    DECK_ENDPOINT: opts.endpoint,
    DECK_AGENT_ID: opts.agentId,
    DECK_AGENT_ROLE: opts.role,
    DECK_AGENT_TIER: opts.tier,
    DECK_AGENT_TOKEN: opts.token,
  };

  const servers: Record<string, unknown> = {
    "harness-deck-comm": {
      command: "node",
      args: ["--no-warnings", path.join(root, "mcps", "deck-comm", "dist", "index.js")],
      env: sharedEnv,
    },
  };

  if (opts.includeDispatch) {
    servers["harness-deck-dispatch"] = {
      command: "node",
      args: ["--no-warnings", path.join(root, "mcps", "deck-dispatch", "dist", "index.js")],
      env: sharedEnv,
    };
  }

  if (opts.includeQq) {
    servers["harness-deck-qq"] = {
      command: "node",
      args: ["--no-warnings", path.join(root, "mcps", "deck-qq", "dist", "index.js")],
      env: sharedEnv,
    };
  }

  if (opts.includeKb) {
    servers["harness-deck-kb"] = {
      command: "node",
      args: ["--no-warnings", path.join(root, "mcps", "deck-kb", "dist", "index.js")],
      env: sharedEnv,
    };
  }

  return servers;
}
