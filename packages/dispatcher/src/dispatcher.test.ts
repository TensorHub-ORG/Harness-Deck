import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalMailroomClient } from "@harness-deck/mailroom";
import { DeckDispatcher, detectLocalEnvironment } from "./index.js";

test("detectLocalEnvironment scans OS, runtime tools, and agent CLIs cleanly", () => {
  const report = detectLocalEnvironment();
  assert.ok(["windows", "linux", "darwin"].includes(report.platform));
  assert.ok(report.runtime_tools.some((t) => t.name === "git"));
  assert.ok(report.agent_clis.some((t) => t.name === "dsh"));
  assert.ok(report.agent_clis.some((t) => t.name === "claude"));
  assert.ok(report.agent_clis.some((t) => t.name === "codex"));
  assert.ok(report.agent_clis.some((t) => t.name === "agy"));
  assert.ok(report.agent_clis.some((t) => t.name === "zcode"));
});

test("DeckDispatcher executes mock-cli task end-to-end and synthesizes result back to O1", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hdeck-disp-"));
  const repoDir = path.join(tmpDir, "demo-project");
  fs.mkdirSync(repoDir, { recursive: true });

  const client = new LocalMailroomClient(path.join(tmpDir, "mailroom"));
  const dispatcher = new DeckDispatcher({
    client,
    agentId: "dispatcher-test",
    secretaryId: "kumi-o1",
    workstation: {
      node_id: "test-pc",
      platform: "windows",
      max_concurrent_tasks: 2,
      worktree_root: path.join(tmpDir, "worktrees"),
      workspaces: {
        demo: { path: repoDir, git_isolation: "none", default_branch: "main" },
      },
      engineers: {
        mock: { driver: "mock-cli", enabled: true, strengths: ["test"], default_timeout_min: 5 },
      },
    },
    logger: () => {},
  });

  try {
    await dispatcher.registerWorkstation();

    const dispatched = await client.sendEnvelope({
      from: { agent_id: "kumi-o1", role: "secretary", tier: "T1" },
      to: { agent_id: "dispatcher-test", role: "worker", tier: "T2" },
      type: "task.dispatch",
      payload: {
        task_id: "T-777",
        project: "demo",
        title: "Smoke test mock execution",
        instruction: "Run diagnostic check",
        preferred_driver: "mock",
        sandbox_profile: "L1_READONLY",
      },
    });

    await dispatcher.pollOnce();

    const o1Inbox = await client.pullInbox("kumi-o1");
    const resultEnv = o1Inbox.find((e) => e.type === "task.result");
    assert.ok(resultEnv, "Expected task.result envelope back in kumi-o1 inbox");
    assert.equal(resultEnv!.trace_id, dispatched.trace_id);
    assert.equal(resultEnv!.payload.status, "success");
    assert.equal(resultEnv!.payload.synthesized_by_dispatcher, true);
    assert.ok(resultEnv!.attachments.length >= 1, "Expected output log artifact");
  } finally {
    dispatcher.stop();
    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
