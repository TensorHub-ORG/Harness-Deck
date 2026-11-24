import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalMailroomClient } from "@harness-deck/mailroom";
import { BUILTIN_DRIVERS, DeckDispatcher, buildTaskPrompt, detectLocalEnvironment } from "./index.js";

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

test("DeckDispatcher materializes inbound attachments and injects --add-dir for dsh/agy", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hdeck-att-"));
  const repoDir = path.join(tmpDir, "demo-project");
  fs.mkdirSync(repoDir, { recursive: true });
  const worktreeRoot = path.join(tmpDir, "worktrees");

  const client = new LocalMailroomClient(path.join(tmpDir, "mailroom"));
  const dispatcher = new DeckDispatcher({
    client,
    agentId: "dispatcher-att",
    secretaryId: "kumi-o1",
    workstation: {
      node_id: "test-att",
      platform: "windows",
      max_concurrent_tasks: 2,
      worktree_root: worktreeRoot,
      workspaces: {
        demo: { path: repoDir, git_isolation: "none", default_branch: "main" },
      },
      engineers: {
        inspect: {
          driver: "custom-cli",
          enabled: true,
          strengths: ["inspect"],
          default_timeout_min: 5,
          command_template: [
            process.execPath,
            "-e",
            "const fs=require('node:fs');const dir=process.env.DECK_INPUT_DIR;const files=fs.readdirSync(dir);console.log('FOUND_INPUTS:'+files.join(','));",
          ],
        },
      },
    },
    logger: () => {},
  });

  try {
    await dispatcher.registerWorkstation();
    const uploaded = await client.uploadArtifact({
      filename: "paper-notes.txt",
      data: Buffer.from("UltraCausal key lemma", "utf8"),
      mime_type: "text/plain",
    });

    await client.sendEnvelope({
      from: { agent_id: "kumi-o1", role: "secretary", tier: "T1" },
      to: { agent_id: "dispatcher-att", role: "worker", tier: "T2" },
      type: "task.dispatch",
      attachments: [uploaded],
      payload: {
        task_id: "T-ATT-1",
        project: "demo",
        title: "Read boss uploaded attachment",
        instruction: "Inspect attached file",
        preferred_driver: "inspect",
        sandbox_profile: "L1_READONLY",
      },
    });

    await dispatcher.pollOnce();

    const o1Inbox = await client.pullInbox("kumi-o1");
    const resultEnv = o1Inbox.find((e) => e.type === "task.result");
    assert.ok(resultEnv);
    assert.equal(resultEnv!.payload.status, "success");
    assert.ok(String(resultEnv!.payload.summary).includes("FOUND_INPUTS:paper-notes.txt"));

    // Verify prompt and driver extraDirs injection for dsh-cli and agy-cli
    const fakeTask = {
      task_id: "T-ATT-1",
      project: "demo",
      title: "t",
      instruction: "read",
      fallback_drivers: ["dsh"],
      sandbox_profile: "L1_READONLY" as const,
      timeout_sec: 120,
      max_retries: 1,
    };
    const prompt = buildTaskPrompt(fakeTask, {
      inputFiles: [
        { filename: "paper-notes.txt", localPath: "/tmp/in/paper-notes.txt", mimeType: "text/plain", sizeBytes: 21 },
      ],
    });
    assert.ok(prompt.includes("paper-notes.txt"));
    const dshCmd = BUILTIN_DRIVERS["dsh-cli"].buildCommand({
      binary: "dsh",
      prompt,
      sandbox: "L1_READONLY",
      task: fakeTask,
      cwd: repoDir,
      extraDirs: ["/tmp/in"],
    });
    assert.ok(dshCmd.args.includes("--add-dir") && dshCmd.args.includes("/tmp/in"));
    const agyCmd = BUILTIN_DRIVERS["agy-cli"].buildCommand({
      binary: "agy",
      prompt,
      sandbox: "L1_READONLY",
      task: fakeTask,
      cwd: repoDir,
      extraDirs: ["/tmp/in"],
    });
    assert.ok(agyCmd.args.includes("--add-dir") && agyCmd.args.includes("/tmp/in"));
  } finally {
    dispatcher.stop();
    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("DeckDispatcher stops running task on task.cancel and reports cancelled status", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hdeck-cancel-"));
  const repoDir = path.join(tmpDir, "demo-project");
  fs.mkdirSync(repoDir, { recursive: true });

  const client = new LocalMailroomClient(path.join(tmpDir, "mailroom"));
  const dispatcher = new DeckDispatcher({
    client,
    agentId: "dispatcher-cancel",
    secretaryId: "kumi-o1",
    workstation: {
      node_id: "test-cancel",
      platform: "windows",
      max_concurrent_tasks: 2,
      worktree_root: path.join(tmpDir, "worktrees"),
      workspaces: {
        demo: { path: repoDir, git_isolation: "none", default_branch: "main" },
      },
      engineers: {
        sleeper: {
          driver: "custom-cli",
          enabled: true,
          strengths: ["sleep"],
          default_timeout_min: 5,
          command_template: [process.execPath, "-e", "setTimeout(() => console.log('done'), 15000);"],
        },
      },
    },
    logger: () => {},
  });

  try {
    await dispatcher.registerWorkstation();
    const dispatchEnv = await client.sendEnvelope({
      from: { agent_id: "kumi-o1", role: "secretary", tier: "T1" },
      to: { agent_id: "dispatcher-cancel", role: "worker", tier: "T2" },
      type: "task.dispatch",
      payload: {
        task_id: "T-CANCEL-1",
        project: "demo",
        title: "Long running sleeper",
        instruction: "Wait",
        preferred_driver: "sleeper",
        sandbox_profile: "L1_READONLY",
      },
    });

    // Run dispatch in background, cancel shortly after start
    const execPromise = dispatcher.handleEnvelope(dispatchEnv);
    await new Promise((r) => setTimeout(r, 350));

    const cancelEnv = await client.sendEnvelope({
      from: { agent_id: "kumi-o1", role: "secretary", tier: "T1" },
      to: { agent_id: "dispatcher-cancel", role: "worker", tier: "T2" },
      type: "task.cancel",
      payload: {
        task_id: "T-CANCEL-1",
        reason: "Boss requested stop",
      },
    });
    await dispatcher.handleEnvelope(cancelEnv);
    await execPromise;

    const o1Inbox = await client.pullInbox("kumi-o1");
    const resultEnv = o1Inbox.find((e) => e.type === "task.result");
    assert.ok(resultEnv, "Expected cancelled task.result envelope");
    assert.equal(resultEnv!.payload.status, "cancelled");
    assert.ok(String(resultEnv!.payload.summary).includes("Boss requested stop"));
  } finally {
    dispatcher.stop();
    client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
