import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateScopedToken } from "@harness-deck/protocol";
import { DeckRelayServer, MailroomStore, RemoteMailroomClient } from "./index.js";

test("Local Mailroom enforces T0>T1>T2>T3 RBAC, L3 approval gate, secret scrubbing, and audit trail", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hdeck-mailroom-"));
  const store = new MailroomStore(tmpDir);
  try {
    // T3 (K1) cannot bypass T1 to reach T0 (Boss)
    assert.throws(
      () =>
        store.sendEnvelope({
          from: { agent_id: "kumi-k1", role: "frontline", tier: "T3" },
          to: { agent_id: "boss", role: "boss", tier: "T0" },
          type: "report.digest",
          payload: {
            digest_id: "dig_bad",
            window_start: "2026-11-23T00:00:00Z",
            window_end: "2026-11-23T12:00:00Z",
            items: [{ category: "bug", project: "Coomi", severity: "low", summary: "test" }],
          },
        }),
      /RBAC_SKIP_LEVEL_DENIED/
    );

    // T3 -> T1 report.digest succeeds and forces untrusted_origin=true + scrubs secrets
    const fakeApiKey = ["sk", "proj", "1234567890abcdefghijklmnop"].join("-");
    const digestEnv = store.sendEnvelope({
      from: { agent_id: "kumi-k1", role: "frontline", tier: "T3" },
      to: { agent_id: "kumi-o1", role: "secretary", tier: "T1" },
      type: "report.digest",
      security: { untrusted_origin: false, risk_level: "L1" },
      payload: {
        digest_id: "dig_01",
        window_start: "2026-11-23T00:00:00Z",
        window_end: "2026-11-23T20:00:00Z",
        items: [
          {
            category: "bug",
            project: "Coomi",
            severity: "high",
            summary: `User leaked ${fakeApiKey} in crash log`,
          },
        ],
      },
    });
    assert.equal(digestEnv.security.untrusted_origin, true);
    assert.ok(!JSON.stringify(digestEnv.payload).includes("1234567890abcdef"));

    // L3 task.dispatch denied without T0 approval
    assert.throws(
      () =>
        store.sendEnvelope({
          trace_id: digestEnv.trace_id,
          from: { agent_id: "kumi-o1", role: "secretary", tier: "T1" },
          to: { agent_id: "eng-pc", role: "worker", tier: "T2" },
          type: "task.dispatch",
          security: { risk_level: "L3" },
          payload: {
            task_id: "T-900",
            project: "Coomi",
            title: "Publish production release",
            instruction: "Deploy to production",
            sandbox_profile: "L3_APPROVED_EXEC",
          },
        }),
      /APPROVAL_REQUIRED/
    );

    // T0 approves short code, then L3 task.dispatch succeeds
    const apr = store.createApproval({
      requested_by: "kumi-o1",
      action_summary: "Publish Coomi release",
      task_id: "T-900",
    });
    store.decideApproval({
      idOrShortCode: apr.short_code,
      decision: "approved",
      decided_by: "boss",
    });

    const dispatched = store.sendEnvelope({
      trace_id: digestEnv.trace_id,
      from: { agent_id: "kumi-o1", role: "secretary", tier: "T1" },
      to: { agent_id: "eng-pc", role: "worker", tier: "T2" },
      type: "task.dispatch",
      security: { risk_level: "L3", approval_ref: apr.approval_id },
      payload: {
        task_id: "T-900",
        project: "Coomi",
        title: "Publish production release",
        instruction: "Deploy to production",
        sandbox_profile: "L3_APPROVED_EXEC",
      },
    });
    assert.equal(dispatched.type, "task.dispatch");

    // Full audit trace recorded
    const trace = store.getTrace(digestEnv.trace_id);
    assert.equal(trace.length, 2);
  } finally {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Remote RelayServer + RemoteMailroomClient supports cross-machine HTTP & artifact transfer", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hdeck-relay-"));
  const adminToken = generateScopedToken();
  const o1Token = generateScopedToken();
  const workerToken = generateScopedToken();

  const relay = new DeckRelayServer({ host: "127.0.0.1", port: 0, dataDir: tmpDir, adminToken });
  const { port } = await relay.start();
  try {
    relay.store.registerAgent({ agent_id: "kumi-o1", role: "secretary", tier: "T1", token: o1Token });
    relay.store.registerAgent({ agent_id: "eng-pc", role: "worker", tier: "T2", token: workerToken });

    const o1Client = new RemoteMailroomClient(`http://127.0.0.1:${port}`, o1Token);
    const workerClient = new RemoteMailroomClient(`http://127.0.0.1:${port}`, workerToken);

    const art = await workerClient.uploadArtifact({
      filename: "report.md",
      data: Buffer.from("# Test OK\n"),
      mime_type: "text/markdown",
    });

    await workerClient.sendEnvelope({
      from: { agent_id: "eng-pc", role: "worker", tier: "T2" },
      to: { agent_id: "kumi-o1", role: "secretary", tier: "T1" },
      type: "notify.secretary",
      payload: { title: "Build Done", summary: "All unit tests passed." },
      attachments: [art],
    });

    const inbox = await o1Client.pullInbox("kumi-o1");
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.attachments[0]!.filename, "report.md");

    const downloaded = await o1Client.downloadArtifact(art.artifact_id);
    assert.equal(downloaded?.data.toString("utf8"), "# Test OK\n");
  } finally {
    await relay.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
