import { z } from "zod";

/**
 * Monotonic Trust Tiers (lower number = higher authority & further from untrusted public input):
 *   T0 (Boss) > T1 (Secretary, e.g. Kumi-O1) > T2 (Internal Worker/Engineer) > T3 (Public Frontline, e.g. Kumi-K1)
 *
 * Security Invariant:
 *   T2 and T3 are STRICTLY ISOLATED (no direct messaging; all mediation passes through T1).
 */
export const TrustTierSchema = z.enum(["T0", "T1", "T2", "T3"]);
export type TrustTier = z.infer<typeof TrustTierSchema>;

export const AgentRoleSchema = z.enum(["boss", "secretary", "worker", "frontline"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const RiskLevelSchema = z.enum(["L1", "L2", "L3"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const SandboxProfileSchema = z.enum([
  "L1_READONLY",
  "L2_WORKTREE_DEV",
  "L3_APPROVED_EXEC",
]);
export type SandboxProfile = z.infer<typeof SandboxProfileSchema>;

export const EnvelopeTypeSchema = z.enum([
  "report.digest",
  "qa.escalation",
  "directive",
  "task.dispatch",
  "task.progress",
  "task.question",
  "task.answer",
  "task.result",
  "task.cancel",
  "notify.secretary",
  "approval.request",
  "approval.decision",
]);
export type EnvelopeType = z.infer<typeof EnvelopeTypeSchema>;

export const ROLE_TO_TIER: Record<AgentRole, TrustTier> = {
  boss: "T0",
  secretary: "T1",
  worker: "T2",
  frontline: "T3",
};

export const TIER_RANK: Record<TrustTier, number> = {
  T0: 0,
  T1: 1,
  T2: 2,
  T3: 3,
};

export interface RoutingRule {
  allowedFromTiers: TrustTier[];
  allowedToTiers: TrustTier[];
  forceUntrustedFromT3?: boolean;
  requiresApprovalForL3?: boolean;
}

export const ROUTING_MATRIX: Record<EnvelopeType, RoutingRule> = {
  "report.digest": {
    allowedFromTiers: ["T3", "T2"],
    allowedToTiers: ["T1"],
    forceUntrustedFromT3: true,
  },
  "qa.escalation": {
    allowedFromTiers: ["T3"],
    allowedToTiers: ["T1"],
    forceUntrustedFromT3: true,
  },
  directive: {
    allowedFromTiers: ["T0", "T1"],
    allowedToTiers: ["T3"],
  },
  "task.dispatch": {
    allowedFromTiers: ["T0", "T1"],
    allowedToTiers: ["T2"],
    requiresApprovalForL3: true,
  },
  "task.progress": {
    allowedFromTiers: ["T2"],
    allowedToTiers: ["T1"],
  },
  "task.question": {
    allowedFromTiers: ["T2"],
    allowedToTiers: ["T1"],
  },
  "task.answer": {
    allowedFromTiers: ["T0", "T1"],
    allowedToTiers: ["T2"],
  },
  "task.result": {
    allowedFromTiers: ["T2"],
    allowedToTiers: ["T1"],
  },
  "task.cancel": {
    allowedFromTiers: ["T0", "T1"],
    allowedToTiers: ["T2"],
  },
  "notify.secretary": {
    allowedFromTiers: ["T2"],
    allowedToTiers: ["T1"],
  },
  "approval.request": {
    allowedFromTiers: ["T1"],
    allowedToTiers: ["T0"],
  },
  "approval.decision": {
    allowedFromTiers: ["T0"],
    allowedToTiers: ["T1"],
  },
};

export interface RoutingValidationResult {
  allowed: boolean;
  reason?: string;
}

export function validateTierRoleConsistency(tier: TrustTier, role: AgentRole): boolean {
  return ROLE_TO_TIER[role] === tier;
}

export function validateRouting(params: {
  type: EnvelopeType;
  fromTier: TrustTier;
  toTier: TrustTier;
  riskLevel?: RiskLevel;
  approvalRef?: string;
  hopCount?: number;
  maxHops?: number;
}): RoutingValidationResult {
  const { type, fromTier, toTier, riskLevel, approvalRef, hopCount = 0, maxHops = 6 } = params;

  // Hard invariant 1: Loop breaker
  if (hopCount > maxHops) {
    return {
      allowed: false,
      reason: `LOOP_BREAKER: hop_count (${hopCount}) exceeded max_hops (${maxHops}). Escalate manually to T0.`,
    };
  }

  // Hard invariant 2: T2 (Internal Worker) and T3 (Public Frontline) are strictly isolated
  if ((fromTier === "T2" && toTier === "T3") || (fromTier === "T3" && toTier === "T2")) {
    return {
      allowed: false,
      reason: `RBAC_ISOLATION_DENIED: Direct communication between ${fromTier} and ${toTier} is strictly forbidden. Route through T1 (secretary).`,
    };
  }

  // Hard invariant 3: T3 (Public Frontline) can NEVER directly contact T0 (Boss)
  if (fromTier === "T3" && toTier === "T0") {
    return {
      allowed: false,
      reason: "RBAC_SKIP_LEVEL_DENIED: T3 (frontline) cannot directly contact T0 (boss). Must escalate via T1 (secretary).",
    };
  }

  const rule = ROUTING_MATRIX[type];
  if (!rule.allowedFromTiers.includes(fromTier)) {
    return {
      allowed: false,
      reason: `RBAC_SENDER_DENIED: Tier ${fromTier} is not allowed to send envelope type "${type}".`,
    };
  }

  if (!rule.allowedToTiers.includes(toTier)) {
    return {
      allowed: false,
      reason: `RBAC_RECIPIENT_DENIED: Tier ${toTier} cannot receive envelope type "${type}".`,
    };
  }

  if (rule.requiresApprovalForL3 && riskLevel === "L3" && !approvalRef) {
    return {
      allowed: false,
      reason: "APPROVAL_REQUIRED: L3 task.dispatch requires a valid T0 approval_ref.",
    };
  }

  return { allowed: true };
}
