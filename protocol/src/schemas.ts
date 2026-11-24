import { z } from "zod";
import {
  AgentRoleSchema,
  EnvelopeTypeSchema,
  RiskLevelSchema,
  SandboxProfileSchema,
  TrustTierSchema,
} from "./tiers.js";

export const PROTOCOL_VERSION = "1.0" as const;

export const AgentIdentitySchema = z.object({
  agent_id: z.string().min(1).max(64),
  role: AgentRoleSchema,
  tier: TrustTierSchema,
});
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

export const ArtifactRefSchema = z.object({
  artifact_id: z.string().min(1),
  filename: z.string().min(1),
  mime_type: z.string().default("application/octet-stream"),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string().min(16),
  expires_at: z.string().optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const SecurityMetaSchema = z.object({
  untrusted_origin: z.boolean().default(false),
  risk_level: RiskLevelSchema.default("L1"),
  approval_ref: z.string().optional(),
});
export type SecurityMeta = z.infer<typeof SecurityMetaSchema>;

// --- Specific Payload Schemas ---

export const CommunityFeedbackItemSchema = z.object({
  category: z.enum(["bug", "feature", "question", "community_fork", "outage", "other"]),
  project: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "urgent"]),
  summary: z.string().min(1).max(600),
  occurrence_count: z.number().int().positive().default(1),
  sample_quotes: z.array(z.string().max(300)).max(5).default([]),
  source_group_id: z.string().optional(),
  source_user_hints: z.array(z.string().max(64)).max(10).default([]),
});
export type CommunityFeedbackItem = z.infer<typeof CommunityFeedbackItemSchema>;

/**
 * Strict schema for T3 (K1) -> T1 (O1) escalation digests.
 * Prohibits arbitrary executable command fields to prevent group prompt injection.
 */
export const CommunityDigestPayloadSchema = z.object({
  digest_id: z.string().min(1),
  window_start: z.string(),
  window_end: z.string(),
  priority: z.enum(["normal", "urgent"]).default("normal"),
  total_messages_reviewed: z.number().int().nonnegative().default(0),
  items: z.array(CommunityFeedbackItemSchema).min(1).max(50),
});
export type CommunityDigestPayload = z.infer<typeof CommunityDigestPayloadSchema>;

export const QaEscalationPayloadSchema = z.object({
  question_id: z.string().min(1),
  project: z.string().min(1),
  question_summary: z.string().min(1).max(600),
  source_group_id: z.string().optional(),
  asker_hint: z.string().max(64).optional(),
  kb_hits_checked: z.number().int().nonnegative().default(0),
});
export type QaEscalationPayload = z.infer<typeof QaEscalationPayloadSchema>;

export const DirectivePayloadSchema = z.object({
  directive_id: z.string().min(1),
  kind: z.enum(["focus_topic", "group_followup", "qa_answer", "kb_refresh"]),
  project: z.string().optional(),
  target_group_ids: z.array(z.string()).default([]),
  content: z.string().min(1).max(2000),
  mention_hints: z.array(z.string()).default([]),
  expires_at: z.string().optional(),
});
export type DirectivePayload = z.infer<typeof DirectivePayloadSchema>;

export const TaskStatusSchema = z.enum([
  "DRAFT",
  "PENDING_APPROVAL",
  "QUEUED",
  "CLAIMED",
  "RUNNING",
  "WAITING_INPUT",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskDispatchPayloadSchema = z.object({
  task_id: z.string().min(1),
  project: z.string().min(1),
  title: z.string().min(1).max(200),
  instruction: z.string().min(1).max(8000),
  preferred_driver: z.string().optional(),
  fallback_drivers: z.array(z.string()).default(["dsh", "claude", "codex"]),
  sandbox_profile: SandboxProfileSchema.default("L1_READONLY"),
  timeout_sec: z.number().int().min(30).max(7200).default(1200),
  rework_of_task_id: z.string().optional(),
  existing_branch: z.string().optional(),
  resume_session_id: z.string().optional(),
  expires_at: z.string().optional(),
  max_retries: z.number().int().min(0).max(3).default(2),
});
export type TaskDispatchPayload = z.infer<typeof TaskDispatchPayloadSchema>;

export const TaskProgressPayloadSchema = z.object({
  task_id: z.string().min(1),
  driver: z.string().min(1),
  stage: z.string().min(1).max(200),
  percent: z.number().min(0).max(100).optional(),
  detail: z.string().max(1000).optional(),
  elapsed_sec: z.number().int().nonnegative().optional(),
  heartbeat: z.boolean().optional(),
});
export type TaskProgressPayload = z.infer<typeof TaskProgressPayloadSchema>;

export const TaskQuestionPayloadSchema = z.object({
  task_id: z.string().min(1),
  question_id: z.string().min(1),
  question: z.string().min(1).max(1000),
  options: z.array(z.string().max(200)).max(5).default([]),
  resume_session_id: z.string().optional(),
});
export type TaskQuestionPayload = z.infer<typeof TaskQuestionPayloadSchema>;

export const TaskAnswerPayloadSchema = z.object({
  task_id: z.string().min(1),
  question_id: z.string().min(1),
  answer: z.string().min(1).max(2000),
});
export type TaskAnswerPayload = z.infer<typeof TaskAnswerPayloadSchema>;

export const TaskResultPayloadSchema = z.object({
  task_id: z.string().min(1),
  driver: z.string().min(1),
  status: z.enum(["success", "partial", "failed", "cancelled"]),
  summary: z.string().min(1).max(4000),
  branch: z.string().optional(),
  worktree_path: z.string().optional(),
  diff_stat: z.string().max(2000).optional(),
  verification: z.string().max(1000).optional(),
  needs_human_review: z.boolean().default(true),
  exit_code: z.number().int().optional(),
  session_id: z.string().optional(),
  synthesized_by_dispatcher: z.boolean().default(false),
});
export type TaskResultPayload = z.infer<typeof TaskResultPayloadSchema>;

export const TaskCancelPayloadSchema = z.object({
  task_id: z.string().min(1),
  reason: z.string().max(500).default("Cancelled by T0/T1"),
});
export type TaskCancelPayload = z.infer<typeof TaskCancelPayloadSchema>;

export const NotifySecretaryPayloadSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(4000),
  project: z.string().optional(),
  suggested_action: z.string().max(500).optional(),
  deliver_to_boss: z.boolean().default(true),
});
export type NotifySecretaryPayload = z.infer<typeof NotifySecretaryPayloadSchema>;

export const ApprovalRequestPayloadSchema = z.object({
  approval_id: z.string().min(1),
  short_code: z.string().min(2).max(16),
  task_id: z.string().optional(),
  action_summary: z.string().min(1).max(1000),
  risk_level: RiskLevelSchema.default("L3"),
  expires_at: z.string(),
});
export type ApprovalRequestPayload = z.infer<typeof ApprovalRequestPayloadSchema>;

export const ApprovalDecisionPayloadSchema = z.object({
  approval_id: z.string().min(1),
  short_code: z.string().min(2).max(16),
  decision: z.enum(["approved", "rejected"]),
  comment: z.string().max(500).optional(),
});
export type ApprovalDecisionPayload = z.infer<typeof ApprovalDecisionPayloadSchema>;

export const DeckEnvelopeSchema = z.object({
  protocol_version: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  id: z.string().min(1),
  trace_id: z.string().min(1),
  idempotency_key: z.string().optional(),
  timestamp: z.string(),
  from: AgentIdentitySchema,
  to: AgentIdentitySchema,
  type: EnvelopeTypeSchema,
  security: SecurityMetaSchema.default({ untrusted_origin: false, risk_level: "L1" }),
  payload: z.record(z.unknown()),
  attachments: z.array(ArtifactRefSchema).default([]),
  hop_count: z.number().int().nonnegative().default(0),
  max_hops: z.number().int().positive().max(12).default(6),
});
export type DeckEnvelope = z.infer<typeof DeckEnvelopeSchema>;

export function validatePayloadForType(type: z.infer<typeof EnvelopeTypeSchema>, payload: unknown) {
  switch (type) {
    case "report.digest":
      return CommunityDigestPayloadSchema.parse(payload);
    case "qa.escalation":
      return QaEscalationPayloadSchema.parse(payload);
    case "directive":
      return DirectivePayloadSchema.parse(payload);
    case "task.dispatch":
      return TaskDispatchPayloadSchema.parse(payload);
    case "task.progress":
      return TaskProgressPayloadSchema.parse(payload);
    case "task.question":
      return TaskQuestionPayloadSchema.parse(payload);
    case "task.answer":
      return TaskAnswerPayloadSchema.parse(payload);
    case "task.result":
      return TaskResultPayloadSchema.parse(payload);
    case "task.cancel":
      return TaskCancelPayloadSchema.parse(payload);
    case "notify.secretary":
      return NotifySecretaryPayloadSchema.parse(payload);
    case "approval.request":
      return ApprovalRequestPayloadSchema.parse(payload);
    case "approval.decision":
      return ApprovalDecisionPayloadSchema.parse(payload);
  }
}

// --- Configuration Schemas ---

export const WorkspaceEntrySchema = z.object({
  path: z.string().min(1),
  git_isolation: z.enum(["worktree", "none"]).default("worktree"),
  default_branch: z.string().default("main"),
});

export const EngineerEntrySchema = z.object({
  driver: z.enum([
    "dsh-cli",
    "claude-code-cli",
    "codex-cli",
    "agy-cli",
    "zcode-cli",
    "coomi-cli",
    "custom-cli",
    "mock-cli",
  ]),
  enabled: z.boolean().default(true),
  binary: z.string().optional(),
  strengths: z.array(z.string()).default([]),
  default_timeout_min: z.number().int().min(1).max(120).default(20),
  command_template: z.array(z.string()).optional(),
});

export const WorkstationConfigSchema = z.object({
  node_id: z.string().min(1),
  platform: z.enum(["windows", "linux", "darwin"]),
  max_concurrent_tasks: z.number().int().min(1).max(8).default(2),
  worktree_root: z.string().default(".deck/worktrees"),
  workspaces: z.record(WorkspaceEntrySchema).default({}),
  engineers: z.record(EngineerEntrySchema).default({}),
});
export type WorkstationConfig = z.infer<typeof WorkstationConfigSchema>;

export const InstallStateSchema = z.object({
  version: z.literal("1.0").default("1.0"),
  updated_at: z.string(),
  completed_steps: z.array(z.string()).default([]),
  deployment_scope: z.enum(["o1_only", "o1_and_k1"]).optional(),
  qq_deploy_target: z.enum(["local", "remote_ssh"]).optional(),
  remote_ssh: z
    .object({
      host: z.string(),
      port: z.number().int().default(22),
      user: z.string(),
      key_path: z.string().optional(),
      remote_dir: z.string().default("/opt/harness-deck"),
      relay_url: z.string().optional(),
    })
    .optional(),
  boss_qq_list: z.array(z.string()).default([]),
  community_group_list: z.array(z.string()).default([]),
  selected_engineers: z.array(z.string()).default([]),
  allowlisted_workspaces: z.record(z.string()).default({}),
  l3_require_approval: z.boolean().default(true),
});
export type InstallState = z.infer<typeof InstallStateSchema>;
