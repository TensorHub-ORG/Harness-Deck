#!/usr/bin/env node
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OneBotClient } from "./onebot.js";

const agentTier = process.env.DECK_AGENT_TIER ?? "T1";
const wsUrl = process.env.NAPCAT_WS_URL ?? process.env.NAPCAT_O1_WS_URL ?? "ws://127.0.0.1:3001";
const accessToken = process.env.NAPCAT_TOKEN ?? process.env.NAPCAT_O1_TOKEN;
const bossQqList = (process.env.DECK_BOSS_QQ_LIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const communityGroupList = (process.env.DECK_COMMUNITY_GROUP_LIST ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const onebot = new OneBotClient({ wsUrl, accessToken });

async function ensureConnected(): Promise<void> {
  if (!onebot.isConnected()) {
    await onebot.connect();
  }
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({
  name: "harness-deck-qq",
  version: "1.0.0",
});

server.tool("qq_health_check", "Check NapCat / OneBot v11 WebSocket connectivity and QQ login status.", {}, async () => {
  try {
    await ensureConnected();
    const info = await onebot.getLoginInfo();
    return ok({ connected: true, ws_url: wsUrl, login_info: info });
  } catch (err) {
    return ok({
      connected: false,
      ws_url: wsUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Only T0/T1 can send private QQ messages/files (strictly blocked for T3 K1!)
if (agentTier === "T0" || agentTier === "T1") {
  server.tool(
    "qq_send_private_message",
    "Send a private QQ message to an allowlisted T0 Boss QQ account (rate-limited & secret-scrubbed).",
    {
      user_id: z.string().min(5),
      message: z.string().min(1),
    },
    async ({ user_id, message }) => {
      if (bossQqList.length > 0 && !bossQqList.includes(user_id)) {
        return ok({ ok: false, error: "ALLOWLIST_DENIED: Recipient is not in DECK_BOSS_QQ_LIST." });
      }
      await ensureConnected();
      const res = await onebot.sendPrivateMessage(user_id, message);
      return ok({ ok: true, res });
    }
  );

  server.tool(
    "qq_send_private_file",
    "Upload a local file (APK, report, log) to an allowlisted T0 Boss QQ chat.",
    {
      user_id: z.string().min(5),
      file_path: z.string().min(1),
      display_name: z.string().optional(),
    },
    async ({ user_id, file_path, display_name }) => {
      if (bossQqList.length > 0 && !bossQqList.includes(user_id)) {
        return ok({ ok: false, error: "ALLOWLIST_DENIED: Recipient is not in DECK_BOSS_QQ_LIST." });
      }
      await ensureConnected();
      const abs = path.resolve(file_path);
      const res = await onebot.uploadPrivateFile(user_id, abs, display_name ?? path.basename(abs));
      return ok({ ok: true, res });
    }
  );
}

server.tool(
  "qq_send_group_message",
  "Send a QQ message to an allowlisted community group (rate-limited & secret-scrubbed).",
  {
    group_id: z.string().min(5),
    message: z.string().min(1),
  },
  async ({ group_id, message }) => {
    if (communityGroupList.length > 0 && !communityGroupList.includes(group_id)) {
      return ok({ ok: false, error: "ALLOWLIST_DENIED: Group is not in DECK_COMMUNITY_GROUP_LIST." });
    }
    await ensureConnected();
    const res = await onebot.sendGroupMessage(group_id, message);
    return ok({ ok: true, res });
  }
);

server.tool("qq_list_groups", "List QQ groups joined by the connected Qmmi/NapCat bot.", {}, async () => {
  await ensureConnected();
  return ok(await onebot.getGroupList());
});

const transport = new StdioServerTransport();
await server.connect(transport);
