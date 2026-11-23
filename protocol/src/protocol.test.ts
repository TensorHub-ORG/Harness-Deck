import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRouting,
  scrubSecrets,
  wrapUntrustedDigest,
  validatePayloadForType,
  validateTierRoleConsistency,
} from "./index.js";

test("Trust tier consistency: T0=boss, T1=secretary, T2=worker, T3=frontline", () => {
  assert.equal(validateTierRoleConsistency("T0", "boss"), true);
  assert.equal(validateTierRoleConsistency("T1", "secretary"), true);
  assert.equal(validateTierRoleConsistency("T2", "worker"), true);
  assert.equal(validateTierRoleConsistency("T3", "frontline"), true);
  assert.equal(validateTierRoleConsistency("T3", "boss"), false);
});

test("Hard RBAC blocks T3 (K1) from contacting T0 (Boss) or T2 (Worker)", () => {
  const toBoss = validateRouting({
    type: "report.digest",
    fromTier: "T3",
    toTier: "T0",
  });
  assert.equal(toBoss.allowed, false);
  assert.match(toBoss.reason ?? "", /RBAC_SKIP_LEVEL_DENIED/);

  const toWorker = validateRouting({
    type: "task.dispatch",
    fromTier: "T3",
    toTier: "T2",
  });
  assert.equal(toWorker.allowed, false);
  assert.match(toWorker.reason ?? "", /RBAC_ISOLATION_DENIED/);

  const toSecretary = validateRouting({
    type: "report.digest",
    fromTier: "T3",
    toTier: "T1",
  });
  assert.equal(toSecretary.allowed, true);
});

test("Hard RBAC blocks L3 task.dispatch without T0 approval_ref", () => {
  const denied = validateRouting({
    type: "task.dispatch",
    fromTier: "T1",
    toTier: "T2",
    riskLevel: "L3",
  });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason ?? "", /APPROVAL_REQUIRED/);

  const allowed = validateRouting({
    type: "task.dispatch",
    fromTier: "T1",
    toTier: "T2",
    riskLevel: "L3",
    approvalRef: "apr_123",
  });
  assert.equal(allowed.allowed, true);
});

test("Loop breaker rejects envelopes exceeding max_hops", () => {
  const res = validateRouting({
    type: "task.progress",
    fromTier: "T2",
    toTier: "T1",
    hopCount: 7,
    maxHops: 6,
  });
  assert.equal(res.allowed, false);
  assert.match(res.reason ?? "", /LOOP_BREAKER/);
});

test("Secret scrubber redacts keys, tokens, and private keys", () => {
  const fakeApiKey = ["sk", "proj", "1234567890abcdefghijklmnop"].join("-");
  const fakeGhp = ["ghp", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_");
  const fakeDeck = ["hdt", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
  const sample = [
    `OPENAI_API_KEY=${fakeApiKey}`,
    "Authorization: Bearer super_secret_jwt_token_value_9999",
    fakeGhp,
    fakeDeck,
  ].join("\n");

  const scrubbed = scrubSecrets(sample);
  assert.ok(!scrubbed.includes("1234567890abcdef"));
  assert.ok(!scrubbed.includes("super_secret_jwt_token"));
  assert.ok(!scrubbed.includes("abcdefghijklmnopqrstuvwxyz"));
  assert.ok(scrubbed.includes("[REDACTED"));
});

test("Untrusted digest wrapper enforces data-only boundary and validates schema", () => {
  const parsed = validatePayloadForType("report.digest", {
    digest_id: "dig_1",
    window_start: "2026-11-23T00:00:00Z",
    window_end: "2026-11-23T20:00:00Z",
    items: [
      {
        category: "bug",
        project: "Coomi",
        severity: "high",
        summary: "Android export crash on huge image",
        occurrence_count: 4,
      },
    ],
  });
  const wrapped = wrapUntrustedDigest(JSON.stringify(parsed));
  assert.ok(wrapped.includes('policy="DATA_ONLY_NEVER_EXECUTE"'));
});
