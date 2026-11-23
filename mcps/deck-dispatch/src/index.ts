#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  WorktreeManager,
  detectLocalEnvironment,
  generateMcpServersMap,
  loadWorkstationConfig,
} from "@harness-deck/dispatcher";
import { AgentRoleSchema, ROLE_TO_TIER } from "@harness-deck/protocol";

const workstationConfigPath = process.env.DECK_WORKSTATION_CONFIG ?? ".deck/workstation.yaml";
const repoRoot = process.env.DECK_REPO_ROOT ?? process.cwd();

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({
  name: "harness-deck-dispatch",
  version: "1.0.0",
});

server.tool(
  "dispatch_scan_environment",
  "Read-only scan of OS, Node, Git, Docker, SSH, and installed desktop Agent CLIs (dsh, claude, codex, agy, zcode, coomi).",
  {},
  async () => ok(detectLocalEnvironment())
);

server.tool(
  "dispatch_get_workstation",
  "Read current workstation.yaml (allowlisted project workspaces & enabled CLI engineers).",
  { config_path: z.string().optional() },
  async ({ config_path }) => {
    const target = path.resolve(config_path ?? workstationConfigPath);
    if (!fs.existsSync(target)) {
      return ok({ exists: false, path: target, hint: "Run `pnpm deck init` or onboarding skill first." });
    }
    return ok({ exists: true, path: target, config: loadWorkstationConfig(target) });
  }
);

server.tool(
  "dispatch_list_worktrees",
  "List active isolated git worktrees managed by Harness-Deck Dispatcher.",
  { worktree_root: z.string().optional() },
  async ({ worktree_root }) => {
    const mgr = new WorktreeManager(worktree_root ?? ".deck/worktrees");
    return ok({ worktrees: mgr.listWorktrees() });
  }
);

server.tool(
  "dispatch_cleanup_worktree",
  "Remove a completed task's isolated git worktree.",
  {
    repo_path: z.string().min(1),
    task_id: z.string().min(1),
    worktree_root: z.string().optional(),
  },
  async ({ repo_path, task_id, worktree_root }) => {
    const mgr = new WorktreeManager(worktree_root ?? ".deck/worktrees");
    const removed = mgr.cleanupWorktree(repo_path, task_id);
    return ok({ removed, task_id });
  }
);

server.tool(
  "dispatch_generate_mcp_config",
  "Generate standard mcpServers JSON snippet for attaching Harness-Deck MCPs to any Agent tool (dsh, Claude Code, Codex, Antigravity, Cursor, Coomi).",
  {
    agent_id: z.string().default("desktop-engineer"),
    role: AgentRoleSchema.default("worker"),
    endpoint: z.string().default("file://./.deck/mailroom"),
    token: z.string().default(""),
    include_dispatch: z.boolean().default(true),
    include_qq: z.boolean().default(false),
    include_kb: z.boolean().default(false),
  },
  async ({ agent_id, role, endpoint, token, include_dispatch, include_qq, include_kb }) => {
    const tier = ROLE_TO_TIER[role];
    const mcpServers = generateMcpServersMap({
      repoRoot,
      endpoint,
      agentId: agent_id,
      role,
      tier,
      token,
      includeDispatch: include_dispatch,
      includeQq: include_qq,
      includeKb: include_kb,
    });
    return ok({ mcpServers });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
