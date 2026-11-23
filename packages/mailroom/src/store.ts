import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AgentIdentity,
  AgentRole,
  ArtifactRef,
  DeckEnvelope,
  DeckEnvelopeSchema,
  EnvelopeType,
  RiskLevel,
  TaskStatus,
  TrustTier,
  generateApprovalShortCode,
  generateEnvelopeId,
  generateId,
  generateTraceId,
  hashToken,
  scrubObjectStrings,
  scrubSecrets,
  sha256Buffer,
  validatePayloadForType,
  validateRouting,
  validateTierRoleConsistency,
} from "@harness-deck/protocol";

export interface RegisteredAgent {
  agent_id: string;
  role: AgentRole;
  tier: TrustTier;
  reports_to: string | null;
  display_name: string;
  metadata: Record<string, unknown>;
  last_heartbeat: string;
  online: boolean;
}

export interface ApprovalRecord {
  approval_id: string;
  short_code: string;
  task_id: string | null;
  requested_by: string;
  action_summary: string;
  risk_level: RiskLevel;
  status: "pending" | "approved" | "rejected" | "expired";
  decided_by: string | null;
  decision_comment: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

export interface TaskRecord {
  task_id: string;
  trace_id: string;
  project: string;
  title: string;
  status: TaskStatus;
  risk_level: RiskLevel;
  assigned_to: string | null;
  driver: string | null;
  branch: string | null;
  approval_id: string | null;
  created_at: string;
  updated_at: string;
  result_json: string | null;
}

export interface KbDocRecord {
  doc_id: string;
  project: string;
  title: string;
  content: string;
  tags: string[];
  updated_at: string;
}

export interface FeedbackRecord {
  feedback_id: string;
  project: string;
  category: "bug" | "feature" | "question" | "community_fork" | "outage" | "other";
  severity: "low" | "medium" | "high" | "urgent";
  summary: string;
  quote: string;
  source_group_id: string | null;
  source_user_hint: string | null;
  escalated_digest_id: string | null;
  created_at: string;
}

export interface SendEnvelopeInput {
  trace_id?: string;
  idempotency_key?: string;
  from: AgentIdentity;
  to: AgentIdentity;
  type: EnvelopeType;
  security?: {
    untrusted_origin?: boolean;
    risk_level?: RiskLevel;
    approval_ref?: string;
  };
  payload: Record<string, unknown>;
  attachments?: ArtifactRef[];
  hop_count?: number;
  max_hops?: number;
}

export class MailroomError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = "MailroomError";
  }
}

export class MailroomStore {
  private readonly db: DatabaseSync;
  public readonly baseDir: string;
  public readonly artifactsDir: string;
  public readonly auditDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    this.artifactsDir = path.join(this.baseDir, "artifacts");
    this.auditDir = path.join(this.baseDir, "audit");
    fs.mkdirSync(this.artifactsDir, { recursive: true });
    fs.mkdirSync(this.auditDir, { recursive: true });

    const dbPath = path.join(this.baseDir, "mailroom.sqlite");
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        tier TEXT NOT NULL,
        reports_to TEXT,
        display_name TEXT NOT NULL,
        token_hash TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        last_heartbeat TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS envelopes (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        timestamp TEXT NOT NULL,
        from_agent_id TEXT NOT NULL,
        from_role TEXT NOT NULL,
        from_tier TEXT NOT NULL,
        to_agent_id TEXT NOT NULL,
        to_role TEXT NOT NULL,
        to_tier TEXT NOT NULL,
        type TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        acked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_envelopes_inbox ON envelopes(to_agent_id, acked_at, timestamp);
      CREATE INDEX IF NOT EXISTS idx_envelopes_trace ON envelopes(trace_id, timestamp);

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        project TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        assigned_to TEXT,
        driver TEXT,
        branch TEXT,
        approval_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        result_json TEXT
      );

      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        short_code TEXT UNIQUE NOT NULL,
        task_id TEXT,
        requested_by TEXT NOT NULL,
        action_summary TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        status TEXT NOT NULL,
        decided_by TEXT,
        decision_comment TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        disk_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kb_docs (
        doc_id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feedback_entries (
        feedback_id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        quote TEXT NOT NULL,
        source_group_id TEXT,
        source_user_hint TEXT,
        escalated_digest_id TEXT,
        created_at TEXT NOT NULL
      );
    `);

    // Safe idempotent migration for existing SQLite databases created before metadata_json existed
    const approvalCols = this.db.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>;
    if (!approvalCols.some((c) => c.name === "metadata_json")) {
      this.db.exec("ALTER TABLE approvals ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';");
    }
  }

  public close(): void {
    this.db.close();
  }

  public registerAgent(params: {
    agent_id: string;
    role: AgentRole;
    tier: TrustTier;
    reports_to?: string | null;
    display_name?: string;
    token?: string;
    metadata?: Record<string, unknown>;
  }): RegisteredAgent {
    if (!validateTierRoleConsistency(params.tier, params.role)) {
      throw new MailroomError(
        "INVALID_IDENTITY",
        `Role "${params.role}" is inconsistent with tier "${params.tier}".`
      );
    }
    const now = new Date().toISOString();
    const tokenHash = params.token ? hashToken(params.token) : null;
    const existing = this.db
      .prepare("SELECT token_hash FROM agents WHERE agent_id = ?")
      .get(params.agent_id) as { token_hash: string | null } | undefined;

    this.db
      .prepare(
        `INSERT INTO agents (agent_id, role, tier, reports_to, display_name, token_hash, metadata_json, last_heartbeat)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           role = excluded.role,
           tier = excluded.tier,
           reports_to = excluded.reports_to,
           display_name = excluded.display_name,
           token_hash = COALESCE(excluded.token_hash, agents.token_hash),
           metadata_json = excluded.metadata_json,
           last_heartbeat = excluded.last_heartbeat`
      )
      .run(
        params.agent_id,
        params.role,
        params.tier,
        params.reports_to ?? null,
        params.display_name ?? params.agent_id,
        tokenHash ?? existing?.token_hash ?? null,
        JSON.stringify(params.metadata ?? {}),
        now
      );

    return {
      agent_id: params.agent_id,
      role: params.role,
      tier: params.tier,
      reports_to: params.reports_to ?? null,
      display_name: params.display_name ?? params.agent_id,
      metadata: params.metadata ?? {},
      last_heartbeat: now,
      online: true,
    };
  }

  public authenticateToken(token: string): RegisteredAgent | null {
    const hashed = hashToken(token);
    const row = this.db
      .prepare("SELECT * FROM agents WHERE token_hash = ?")
      .get(hashed) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToAgent(row);
  }

  public heartbeat(agentId: string, metadata?: Record<string, unknown>): void {
    const now = new Date().toISOString();
    if (metadata) {
      this.db
        .prepare("UPDATE agents SET last_heartbeat = ?, metadata_json = ? WHERE agent_id = ?")
        .run(now, JSON.stringify(metadata), agentId);
    } else {
      this.db.prepare("UPDATE agents SET last_heartbeat = ? WHERE agent_id = ?").run(now, agentId);
    }
  }

  public listAgents(onlineTtlSec = 180): RegisteredAgent[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY tier ASC, agent_id ASC").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => this.rowToAgent(row, onlineTtlSec));
  }

  private rowToAgent(row: Record<string, unknown>, onlineTtlSec = 180): RegisteredAgent {
    const lastHb = String(row.last_heartbeat);
    const ageSec = (Date.now() - Date.parse(lastHb)) / 1000;
    return {
      agent_id: String(row.agent_id),
      role: String(row.role) as AgentRole,
      tier: String(row.tier) as TrustTier,
      reports_to: row.reports_to ? String(row.reports_to) : null,
      display_name: String(row.display_name),
      metadata: JSON.parse(String(row.metadata_json || "{}")) as Record<string, unknown>,
      last_heartbeat: lastHb,
      online: ageSec <= onlineTtlSec,
    };
  }

  public sendEnvelope(input: SendEnvelopeInput): DeckEnvelope {
    // 1. Validate identity tier/role consistency
    if (!validateTierRoleConsistency(input.from.tier, input.from.role)) {
      throw new MailroomError(
        "INVALID_SENDER_IDENTITY",
        `Sender role "${input.from.role}" does not match tier "${input.from.tier}".`
      );
    }
    if (!validateTierRoleConsistency(input.to.tier, input.to.role)) {
      throw new MailroomError(
        "INVALID_RECIPIENT_IDENTITY",
        `Recipient role "${input.to.role}" does not match tier "${input.to.tier}".`
      );
    }

    // 2. Idempotency check
    if (input.idempotency_key) {
      const existing = this.db
        .prepare("SELECT envelope_json FROM envelopes WHERE idempotency_key = ?")
        .get(input.idempotency_key) as { envelope_json: string } | undefined;
      if (existing) {
        return JSON.parse(existing.envelope_json) as DeckEnvelope;
      }
    }

    // 3. Hard RBAC routing & loop-breaker validation
    const riskLevel: RiskLevel = input.security?.risk_level ?? "L1";
    const routing = validateRouting({
      type: input.type,
      fromTier: input.from.tier,
      toTier: input.to.tier,
      riskLevel,
      approvalRef: input.security?.approval_ref,
      hopCount: input.hop_count ?? 0,
      maxHops: input.max_hops ?? 6,
    });
    if (!routing.allowed) {
      throw new MailroomError("RBAC_DENIED", routing.reason ?? "Routing denied.", 403);
    }

    // 4. Verify L3 approval token actually exists & is approved by T0
    if (input.type === "task.dispatch" && riskLevel === "L3") {
      const approvalRef = input.security?.approval_ref;
      const approval = approvalRef ? this.getApproval(approvalRef) : null;
      if (!approval || approval.status !== "approved") {
        throw new MailroomError(
          "APPROVAL_INVALID",
          `L3 task.dispatch requires an approved T0 approval record (got "${approvalRef ?? "none"}").`,
          403
        );
      }
    }

    // 5. Validate typed payload + scrub secrets from all outbound text fields
    const validatedPayload = validatePayloadForType(input.type, input.payload);
    const scrubbedPayload = scrubObjectStrings(validatedPayload) as Record<string, unknown>;

    // 6. Force untrusted_origin=true whenever source is T3 (public community frontline)
    const forceUntrusted = input.from.tier === "T3";

    const envelope = DeckEnvelopeSchema.parse({
      protocol_version: "1.0",
      id: generateEnvelopeId(),
      trace_id: input.trace_id ?? generateTraceId(),
      idempotency_key: input.idempotency_key,
      timestamp: new Date().toISOString(),
      from: input.from,
      to: input.to,
      type: input.type,
      security: {
        untrusted_origin: forceUntrusted ? true : Boolean(input.security?.untrusted_origin),
        risk_level: riskLevel,
        approval_ref: input.security?.approval_ref,
      },
      payload: scrubbedPayload,
      attachments: input.attachments ?? [],
      hop_count: input.hop_count ?? 0,
      max_hops: input.max_hops ?? 6,
    });

    this.db
      .prepare(
        `INSERT INTO envelopes (
          id, trace_id, idempotency_key, timestamp,
          from_agent_id, from_role, from_tier,
          to_agent_id, to_role, to_tier,
          type, envelope_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        envelope.id,
        envelope.trace_id,
        envelope.idempotency_key ?? null,
        envelope.timestamp,
        envelope.from.agent_id,
        envelope.from.role,
        envelope.from.tier,
        envelope.to.agent_id,
        envelope.to.role,
        envelope.to.tier,
        envelope.type,
        JSON.stringify(envelope)
      );

    this.syncTaskProjection(envelope);
    this.appendAudit(envelope);

    return envelope;
  }

  private syncTaskProjection(env: DeckEnvelope): void {
    const now = env.timestamp;
    if (env.type === "task.dispatch") {
      const p = env.payload as {
        task_id: string;
        project: string;
        title: string;
        preferred_driver?: string;
        existing_branch?: string;
      };
      this.db
        .prepare(
          `INSERT INTO tasks (task_id, trace_id, project, title, status, risk_level, assigned_to, driver, branch, approval_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             status = 'QUEUED',
             assigned_to = excluded.assigned_to,
             driver = COALESCE(excluded.driver, tasks.driver),
             updated_at = excluded.updated_at`
        )
        .run(
          p.task_id,
          env.trace_id,
          p.project,
          p.title,
          env.security.risk_level,
          env.to.agent_id,
          p.preferred_driver ?? null,
          p.existing_branch ?? null,
          env.security.approval_ref ?? null,
          now,
          now
        );
    } else if (env.type === "task.progress") {
      const p = env.payload as { task_id: string; driver?: string };
      this.db
        .prepare("UPDATE tasks SET status = 'RUNNING', driver = COALESCE(?, driver), updated_at = ? WHERE task_id = ?")
        .run(p.driver ?? null, now, p.task_id);
    } else if (env.type === "task.question") {
      const p = env.payload as { task_id: string };
      this.db
        .prepare("UPDATE tasks SET status = 'WAITING_INPUT', updated_at = ? WHERE task_id = ?")
        .run(now, p.task_id);
    } else if (env.type === "task.answer") {
      const p = env.payload as { task_id: string };
      this.db
        .prepare("UPDATE tasks SET status = 'RUNNING', updated_at = ? WHERE task_id = ?")
        .run(now, p.task_id);
    } else if (env.type === "task.result") {
      const p = env.payload as {
        task_id: string;
        status: string;
        driver?: string;
        branch?: string;
      };
      const mappedStatus: TaskStatus =
        p.status === "success" || p.status === "partial"
          ? "COMPLETED"
          : p.status === "cancelled"
            ? "CANCELLED"
            : "FAILED";
      this.db
        .prepare(
          "UPDATE tasks SET status = ?, driver = COALESCE(?, driver), branch = COALESCE(?, branch), updated_at = ?, result_json = ? WHERE task_id = ?"
        )
        .run(mappedStatus, p.driver ?? null, p.branch ?? null, now, JSON.stringify(env.payload), p.task_id);
    } else if (env.type === "task.cancel") {
      const p = env.payload as { task_id: string };
      this.db
        .prepare("UPDATE tasks SET status = 'CANCELLED', updated_at = ? WHERE task_id = ?")
        .run(now, p.task_id);
    }
  }

  private appendAudit(env: DeckEnvelope): void {
    const safeTrace = env.trace_id.replace(/[^A-Za-z0-9_-]/g, "_");
    const filePath = path.join(this.auditDir, `${safeTrace}.jsonl`);
    fs.appendFileSync(filePath, `${JSON.stringify(env)}\n`, "utf8");
  }

  public pullInbox(agentId: string, options?: { types?: EnvelopeType[]; limit?: number }): DeckEnvelope[] {
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
    const rows = this.db
      .prepare(
        `SELECT envelope_json FROM envelopes
         WHERE to_agent_id = ? AND acked_at IS NULL
         ORDER BY timestamp ASC
         LIMIT ?`
      )
      .all(agentId, limit) as Array<{ envelope_json: string }>;

    const envelopes = rows.map((r) => JSON.parse(r.envelope_json) as DeckEnvelope);
    if (options?.types && options.types.length > 0) {
      return envelopes.filter((e) => options.types!.includes(e.type));
    }
    return envelopes;
  }

  public ackEnvelope(envelopeId: string, agentId: string): boolean {
    const now = new Date().toISOString();
    const res = this.db
      .prepare("UPDATE envelopes SET acked_at = ? WHERE id = ? AND to_agent_id = ? AND acked_at IS NULL")
      .run(now, envelopeId, agentId);
    return Number(res.changes) > 0;
  }

  public getTrace(traceId: string): DeckEnvelope[] {
    const rows = this.db
      .prepare("SELECT envelope_json FROM envelopes WHERE trace_id = ? ORDER BY timestamp ASC")
      .all(traceId) as Array<{ envelope_json: string }>;
    return rows.map((r) => JSON.parse(r.envelope_json) as DeckEnvelope);
  }

  public getTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      task_id: String(row.task_id),
      trace_id: String(row.trace_id),
      project: String(row.project),
      title: String(row.title),
      status: String(row.status) as TaskStatus,
      risk_level: String(row.risk_level) as RiskLevel,
      assigned_to: row.assigned_to ? String(row.assigned_to) : null,
      driver: row.driver ? String(row.driver) : null,
      branch: row.branch ? String(row.branch) : null,
      approval_id: row.approval_id ? String(row.approval_id) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      result_json: row.result_json ? String(row.result_json) : null,
    };
  }

  public listTasks(limit = 30): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      task_id: String(row.task_id),
      trace_id: String(row.trace_id),
      project: String(row.project),
      title: String(row.title),
      status: String(row.status) as TaskStatus,
      risk_level: String(row.risk_level) as RiskLevel,
      assigned_to: row.assigned_to ? String(row.assigned_to) : null,
      driver: row.driver ? String(row.driver) : null,
      branch: row.branch ? String(row.branch) : null,
      approval_id: row.approval_id ? String(row.approval_id) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      result_json: row.result_json ? String(row.result_json) : null,
    }));
  }

  // --- L3 Approvals ---

  public createApproval(params: {
    requested_by: string;
    action_summary: string;
    task_id?: string;
    risk_level?: RiskLevel;
    ttl_minutes?: number;
    metadata?: Record<string, unknown>;
  }): ApprovalRecord {
    const now = new Date();
    const expires = new Date(now.getTime() + (params.ttl_minutes ?? 60) * 60_000);
    const cleanMeta = scrubObjectStrings(params.metadata ?? {}) as Record<string, unknown>;
    const record: ApprovalRecord = {
      approval_id: generateId("apr"),
      short_code: generateApprovalShortCode(),
      task_id: params.task_id ?? null,
      requested_by: params.requested_by,
      action_summary: scrubSecrets(params.action_summary),
      risk_level: params.risk_level ?? "L3",
      status: "pending",
      decided_by: null,
      decision_comment: null,
      metadata: cleanMeta,
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
      decided_at: null,
    };

    this.db
      .prepare(
        `INSERT INTO approvals (
          approval_id, short_code, task_id, requested_by, action_summary,
          risk_level, status, metadata_json, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.approval_id,
        record.short_code,
        record.task_id,
        record.requested_by,
        record.action_summary,
        record.risk_level,
        record.status,
        JSON.stringify(cleanMeta),
        record.created_at,
        record.expires_at
      );

    return record;
  }

  public getApproval(idOrShortCode: string): ApprovalRecord | null {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE approval_id = ? OR short_code = ? OR task_id = ?")
      .get(idOrShortCode, idOrShortCode, idOrShortCode) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToApproval(row);
  }

  public listApprovals(status?: "pending" | "approved" | "rejected"): ApprovalRecord[] {
    // Automatically sweep stale expired pending approvals so secretaries never offer expired codes
    const nowIso = new Date().toISOString();
    this.db
      .prepare("UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?")
      .run(nowIso);

    const rows = status
      ? (this.db
          .prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 50")
          .all(status) as Array<Record<string, unknown>>)
      : (this.db
          .prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 50")
          .all() as Array<Record<string, unknown>>);
    return rows.map((r) => this.rowToApproval(r));
  }

  public decideApproval(params: {
    idOrShortCode: string;
    decision: "approved" | "rejected";
    decided_by: string;
    comment?: string;
  }): ApprovalRecord {
    const record = this.getApproval(params.idOrShortCode);
    if (!record) {
      throw new MailroomError("APPROVAL_NOT_FOUND", `Approval "${params.idOrShortCode}" not found.`, 404);
    }
    if (record.status !== "pending") {
      throw new MailroomError(
        "APPROVAL_ALREADY_DECIDED",
        `Approval "${record.short_code}" is already "${record.status}".`
      );
    }
    if (Date.now() > Date.parse(record.expires_at)) {
      this.db.prepare("UPDATE approvals SET status = 'expired' WHERE approval_id = ?").run(record.approval_id);
      throw new MailroomError("APPROVAL_EXPIRED", `Approval "${record.short_code}" has expired.`);
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE approvals SET status = ?, decided_by = ?, decision_comment = ?, decided_at = ? WHERE approval_id = ?"
      )
      .run(params.decision, params.decided_by, params.comment ?? null, now, record.approval_id);

    return this.getApproval(record.approval_id)!;
  }

  private rowToApproval(row: Record<string, unknown>): ApprovalRecord {
    return {
      approval_id: String(row.approval_id),
      short_code: String(row.short_code),
      task_id: row.task_id ? String(row.task_id) : null,
      requested_by: String(row.requested_by),
      action_summary: String(row.action_summary),
      risk_level: String(row.risk_level) as RiskLevel,
      status: String(row.status) as ApprovalRecord["status"],
      decided_by: row.decided_by ? String(row.decided_by) : null,
      decision_comment: row.decision_comment ? String(row.decision_comment) : null,
      metadata: JSON.parse(String(row.metadata_json || "{}")) as Record<string, unknown>,
      created_at: String(row.created_at),
      expires_at: String(row.expires_at),
      decided_at: row.decided_at ? String(row.decided_at) : null,
    };
  }

  // --- Artifact Relay ---

  public saveArtifact(params: {
    filename: string;
    data: Buffer;
    mime_type?: string;
    ttl_hours?: number;
  }): ArtifactRef {
    const safeName = path.basename(params.filename).replace(/[^A-Za-z0-9._-]/g, "_");
    const artifactId = generateId("art");
    const sha256 = sha256Buffer(params.data);
    const now = new Date();
    const expires = new Date(now.getTime() + (params.ttl_hours ?? 168) * 3600_000);
    const diskPath = path.join(this.artifactsDir, `${artifactId}_${safeName}`);
    fs.writeFileSync(diskPath, params.data);

    this.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, filename, mime_type, size_bytes, sha256, disk_path, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artifactId,
        safeName,
        params.mime_type ?? "application/octet-stream",
        params.data.byteLength,
        sha256,
        diskPath,
        now.toISOString(),
        expires.toISOString()
      );

    return {
      artifact_id: artifactId,
      filename: safeName,
      mime_type: params.mime_type ?? "application/octet-stream",
      size_bytes: params.data.byteLength,
      sha256,
      expires_at: expires.toISOString(),
    };
  }

  public getArtifact(artifactId: string): { meta: ArtifactRef; data: Buffer; disk_path: string } | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE artifact_id = ?").get(artifactId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const diskPath = String(row.disk_path);
    if (!fs.existsSync(diskPath)) return null;
    const data = fs.readFileSync(diskPath);
    return {
      meta: {
        artifact_id: String(row.artifact_id),
        filename: String(row.filename),
        mime_type: String(row.mime_type),
        size_bytes: Number(row.size_bytes),
        sha256: String(row.sha256),
        expires_at: String(row.expires_at),
      },
      data,
      disk_path: diskPath,
    };
  }

  public cleanupExpiredArtifacts(): number {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare("SELECT artifact_id, disk_path FROM artifacts WHERE expires_at < ?")
      .all(now) as Array<{ artifact_id: string; disk_path: string }>;
    for (const r of rows) {
      if (fs.existsSync(r.disk_path)) {
        fs.rmSync(r.disk_path, { force: true });
      }
      this.db.prepare("DELETE FROM artifacts WHERE artifact_id = ?").run(r.artifact_id);
    }
    return rows.length;
  }

  // --- Lightweight Knowledge Base & Community Feedback Ledger ---

  public upsertKbDoc(params: {
    doc_id?: string;
    project: string;
    title: string;
    content: string;
    tags?: string[];
  }): KbDocRecord {
    const docId = params.doc_id ?? generateId("kb");
    const now = new Date().toISOString();
    const cleanContent = scrubSecrets(params.content);
    this.db
      .prepare(
        `INSERT INTO kb_docs (doc_id, project, title, content, tags_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(doc_id) DO UPDATE SET
           project = excluded.project,
           title = excluded.title,
           content = excluded.content,
           tags_json = excluded.tags_json,
           updated_at = excluded.updated_at`
      )
      .run(docId, params.project, params.title, cleanContent, JSON.stringify(params.tags ?? []), now);

    return {
      doc_id: docId,
      project: params.project,
      title: params.title,
      content: cleanContent,
      tags: params.tags ?? [],
      updated_at: now,
    };
  }

  public searchKb(query: string, project?: string, limit = 5): KbDocRecord[] {
    const tokens = query
      .toLowerCase()
      .split(/[\s,.;:!?/\\]+/)
      .filter((t) => t.length >= 2);
    const rows = project
      ? (this.db.prepare("SELECT * FROM kb_docs WHERE project = ?").all(project) as Array<Record<string, unknown>>)
      : (this.db.prepare("SELECT * FROM kb_docs").all() as Array<Record<string, unknown>>);

    const scored = rows
      .map((row) => {
        const title = String(row.title);
        const content = String(row.content);
        const hay = `${title}\n${content}`.toLowerCase();
        let score = 0;
        if (hay.includes(query.toLowerCase())) score += 5;
        for (const t of tokens) {
          if (title.toLowerCase().includes(t)) score += 3;
          if (content.toLowerCase().includes(t)) score += 1;
        }
        return {
          score,
          doc: {
            doc_id: String(row.doc_id),
            project: String(row.project),
            title,
            content,
            tags: JSON.parse(String(row.tags_json || "[]")) as string[],
            updated_at: String(row.updated_at),
          },
        };
      })
      .filter((s) => s.score > 0 || tokens.length === 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map((s) => s.doc);
  }

  public recordFeedback(params: {
    project: string;
    category: FeedbackRecord["category"];
    severity: FeedbackRecord["severity"];
    summary: string;
    quote?: string;
    source_group_id?: string;
    source_user_hint?: string;
  }): FeedbackRecord {
    const record: FeedbackRecord = {
      feedback_id: generateId("fb"),
      project: params.project,
      category: params.category,
      severity: params.severity,
      summary: scrubSecrets(params.summary),
      quote: scrubSecrets(params.quote ?? ""),
      source_group_id: params.source_group_id ?? null,
      source_user_hint: params.source_user_hint ?? null,
      escalated_digest_id: null,
      created_at: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO feedback_entries (
          feedback_id, project, category, severity, summary, quote,
          source_group_id, source_user_hint, escalated_digest_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(
        record.feedback_id,
        record.project,
        record.category,
        record.severity,
        record.summary,
        record.quote,
        record.source_group_id,
        record.source_user_hint,
        record.created_at
      );

    return record;
  }

  public listPendingFeedback(project?: string, limit = 50): FeedbackRecord[] {
    const rows = project
      ? (this.db
          .prepare(
            "SELECT * FROM feedback_entries WHERE escalated_digest_id IS NULL AND project = ? ORDER BY created_at ASC LIMIT ?"
          )
          .all(project, limit) as Array<Record<string, unknown>>)
      : (this.db
          .prepare("SELECT * FROM feedback_entries WHERE escalated_digest_id IS NULL ORDER BY created_at ASC LIMIT ?")
          .all(limit) as Array<Record<string, unknown>>);

    return rows.map((row) => ({
      feedback_id: String(row.feedback_id),
      project: String(row.project),
      category: String(row.category) as FeedbackRecord["category"],
      severity: String(row.severity) as FeedbackRecord["severity"],
      summary: String(row.summary),
      quote: String(row.quote),
      source_group_id: row.source_group_id ? String(row.source_group_id) : null,
      source_user_hint: row.source_user_hint ? String(row.source_user_hint) : null,
      escalated_digest_id: row.escalated_digest_id ? String(row.escalated_digest_id) : null,
      created_at: String(row.created_at),
    }));
  }

  public markFeedbackEscalated(feedbackIds: string[], digestId: string): void {
    const stmt = this.db.prepare("UPDATE feedback_entries SET escalated_digest_id = ? WHERE feedback_id = ?");
    for (const id of feedbackIds) {
      stmt.run(digestId, id);
    }
  }
}
