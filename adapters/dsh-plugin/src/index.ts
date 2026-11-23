import fs from "node:fs";
import path from "node:path";
import { createMailroomClient } from "@harness-deck/mailroom";
import {
  DeckDispatcher,
  generateMcpServersMap,
  loadWorkstationConfig,
} from "@harness-deck/dispatcher";
import { AgentRole, ROLE_TO_TIER } from "@harness-deck/protocol";

/**
 * Minimal structural typing compatible with DeepSeek Harness (Cordis) Context.
 * Keeps zero hard runtime dependency on dsh while mounting cleanly as a native Cordis plugin.
 */
export interface CordisLikeContext {
  effect?: (callback: () => void | (() => void)) => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  mcp?: {
    registerServer?: (name: string, config: unknown) => void;
  };
  skills?: {
    registerDirectory?: (dirPath: string) => void;
  };
  logger?: (name: string) => { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface DshHarnessDeckConfig {
  repoRoot: string;
  endpoint?: string;
  agentId?: string;
  role?: AgentRole;
  token?: string;
  workstationConfigPath?: string;
  enableBackgroundDispatcher?: boolean;
}

export const name = "harness-deck";

export function apply(ctx: CordisLikeContext, config: DshHarnessDeckConfig): void {
  const log = ctx.logger?.("harness-deck") ?? {
    info: (m: string) => console.error(`[dsh-plugin:harness-deck] ${m}`),
    warn: (m: string) => console.error(`[dsh-plugin:harness-deck][WARN] ${m}`),
  };

  const repoRoot = path.resolve(config.repoRoot);
  const role: AgentRole = config.role ?? "worker";
  const tier = ROLE_TO_TIER[role];
  const endpoint = config.endpoint ?? process.env.DECK_ENDPOINT ?? "file://./.deck/mailroom";
  const token = config.token ?? process.env.DECK_TOKEN_ENGINEER ?? process.env.DECK_AGENT_TOKEN ?? "";

  // 1. Register Harness-Deck bundled skills into dsh
  const skillsDir = path.join(repoRoot, "skills");
  if (fs.existsSync(skillsDir) && ctx.skills?.registerDirectory) {
    ctx.skills.registerDirectory(skillsDir);
    log.info(`Registered Harness-Deck skills from ${skillsDir}`);
  }

  // 2. Register modular Harness-Deck MCP servers into dsh MCP manager
  const mcpMap = generateMcpServersMap({
    repoRoot,
    endpoint,
    agentId: config.agentId ?? "dsh-engineer",
    role,
    tier,
    token,
    includeDispatch: role === "worker" || role === "boss",
    includeQq: role === "secretary" || role === "frontline",
    includeKb: true,
  });

  if (ctx.mcp?.registerServer) {
    for (const [serverName, serverCfg] of Object.entries(mcpMap)) {
      ctx.mcp.registerServer(serverName, serverCfg);
    }
    log.info(`Registered ${Object.keys(mcpMap).length} Harness-Deck MCP server(s) into dsh.`);
  }

  // 3. Optionally host DeckDispatcher as a reversible Cordis lifecycle effect
  if (config.enableBackgroundDispatcher) {
    const wsPath = path.resolve(repoRoot, config.workstationConfigPath ?? ".deck/workstation.yaml");
    if (!fs.existsSync(wsPath)) {
      log.warn(`Workstation config not found at ${wsPath}; skipping background dispatcher.`);
      return;
    }

    const startDispatcher = () => {
      const client = createMailroomClient(endpoint, token);
      const workstation = loadWorkstationConfig(wsPath);
      const dispatcher = new DeckDispatcher({
        client,
        workstation,
        logger: (m) => log.info(m),
      });
      void dispatcher.start();
      return () => {
        dispatcher.stop();
        client.close();
      };
    };

    if (ctx.effect) {
      ctx.effect(startDispatcher);
    } else {
      startDispatcher();
    }
  }
}

export default { name, apply };
