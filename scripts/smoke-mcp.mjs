#!/usr/bin/env node
/**
 * Real MCP JSON-RPC stdio smoke test:
 * Spawns deck-comm, deck-dispatch, and deck-kb MCP servers,
 * sends standard MCP `initialize` + `tools/list` JSON-RPC messages,
 * and verifies role-based tool scoping (T2 worker vs T3 frontline!).
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";

async function queryMcpTools(scriptPath, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", scriptPath], {
      env: { ...process.env, ...envOverrides },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    const responses = new Map();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timeout waiting for MCP response from ${scriptPath}`));
    }, 10_000);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined) responses.set(msg.id, msg);
          if (responses.has(2)) {
            clearTimeout(timer);
            child.kill();
            resolve(responses.get(2).result.tools.map((t) => t.name));
          }
        } catch {
          // ignore non-json
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    const initReq = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "harness-deck-smoke", version: "1.0.0" },
      },
    };
    const initializedNotif = { jsonrpc: "2.0", method: "notifications/initialized" };
    const listReq = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

    child.stdin.write(`${JSON.stringify(initReq)}\n`);
    child.stdin.write(`${JSON.stringify(initializedNotif)}\n`);
    child.stdin.write(`${JSON.stringify(listReq)}\n`);
  });
}

const root = process.cwd();

// 1. Verify T2 Engineer gets worker tools & NOT T1 dispatch tools
const t2Tools = await queryMcpTools(path.join(root, "mcps/deck-comm/dist/index.js"), {
  DECK_AGENT_ID: "eng-test",
  DECK_AGENT_ROLE: "worker",
  DECK_AGENT_TIER: "T2",
});
assert.ok(t2Tools.includes("deck_notify_secretary"));
assert.ok(t2Tools.includes("deck_submit_result"));
assert.ok(!t2Tools.includes("deck_dispatch_task"), "T2 must NOT see T1 dispatch tool");
console.log(`[PASS] deck-comm (T2 worker): ${t2Tools.length} tools`);

// 2. Verify T3 Frontline (K1) ONLY gets escalate/digest tools & NOT dispatch/boss tools
const t3Tools = await queryMcpTools(path.join(root, "mcps/deck-comm/dist/index.js"), {
  DECK_AGENT_ID: "kumi-k1",
  DECK_AGENT_ROLE: "frontline",
  DECK_AGENT_TIER: "T3",
});
assert.ok(t3Tools.includes("deck_submit_digest"));
assert.ok(t3Tools.includes("deck_escalate_qa"));
assert.ok(!t3Tools.includes("deck_dispatch_task"), "T3 must NOT see dispatch tool");
assert.ok(!t3Tools.includes("deck_decide_approval"), "T3 must NOT see T0 approval tool");
console.log(`[PASS] deck-comm (T3 frontline K1): ${t3Tools.length} tools`);

// 3. Verify T1 Secretary (O1) gets dispatch, directive, and approval request tools
const t1Tools = await queryMcpTools(path.join(root, "mcps/deck-comm/dist/index.js"), {
  DECK_AGENT_ID: "kumi-o1",
  DECK_AGENT_ROLE: "secretary",
  DECK_AGENT_TIER: "T1",
});
assert.ok(t1Tools.includes("deck_dispatch_task"));
assert.ok(t1Tools.includes("deck_send_directive"));
assert.ok(t1Tools.includes("deck_request_approval"));
console.log(`[PASS] deck-comm (T1 secretary O1): ${t1Tools.length} tools`);

// 4. Verify deck-dispatch MCP
const dispTools = await queryMcpTools(path.join(root, "mcps/deck-dispatch/dist/index.js"));
assert.ok(dispTools.includes("dispatch_scan_environment"));
assert.ok(dispTools.includes("dispatch_generate_mcp_config"));
console.log(`[PASS] deck-dispatch: ${dispTools.length} tools`);

// 5. Verify deck-kb MCP read-only isolation for T3 K1
const kbT3Tools = await queryMcpTools(path.join(root, "mcps/deck-kb/dist/index.js"), {
  DECK_AGENT_TIER: "T3",
});
assert.ok(kbT3Tools.includes("kb_search"));
assert.ok(kbT3Tools.includes("feedback_record"));
assert.ok(!kbT3Tools.includes("kb_ingest_doc"), "T3 K1 must have read-only KB access");
console.log(`[PASS] deck-kb (T3 read-only KB): ${kbT3Tools.length} tools`);

// 6. Verify deck-qq MCP private DM block for T3 K1
const qqT3Tools = await queryMcpTools(path.join(root, "mcps/deck-qq/dist/index.js"), {
  DECK_AGENT_TIER: "T3",
});
assert.ok(qqT3Tools.includes("qq_send_group_message"));
assert.ok(!qqT3Tools.includes("qq_send_private_message"), "T3 K1 must NOT see private Boss DM tool");
console.log(`[PASS] deck-qq (T3 group-only): ${qqT3Tools.length} tools`);

console.log("\nALL 6 MCP JSON-RPC ROLE-SCOPING SMOKE TESTS PASSED!");
