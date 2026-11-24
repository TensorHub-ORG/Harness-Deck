import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { ArtifactRef, DeckEnvelope, EnvelopeType, RiskLevel } from "@harness-deck/protocol";
import {
  ApprovalRecord,
  FeedbackRecord,
  KbDocRecord,
  MailroomStore,
  RegisteredAgent,
  SendEnvelopeInput,
  TaskRecord,
} from "./store.js";

export interface MailroomClient {
  readonly mode: "local" | "remote";
  registerAgent(params: Parameters<MailroomStore["registerAgent"]>[0]): Promise<RegisteredAgent>;
  heartbeat(agentId: string, metadata?: Record<string, unknown>): Promise<void>;
  listAgents(): Promise<RegisteredAgent[]>;
  sendEnvelope(input: SendEnvelopeInput): Promise<DeckEnvelope>;
  pullInbox(agentId: string, options?: { types?: EnvelopeType[]; limit?: number }): Promise<DeckEnvelope[]>;
  ackEnvelope(envelopeId: string, agentId: string): Promise<boolean>;
  getTrace(traceId: string): Promise<DeckEnvelope[]>;
  listTasks(): Promise<TaskRecord[]>;
  createApproval(params: {
    requested_by: string;
    action_summary: string;
    task_id?: string;
    risk_level?: RiskLevel;
    ttl_minutes?: number;
    metadata?: Record<string, unknown>;
  }): Promise<ApprovalRecord>;
  decideApproval(params: {
    idOrShortCode: string;
    decision: "approved" | "rejected";
    decided_by: string;
    comment?: string;
  }): Promise<ApprovalRecord>;
  listApprovals(status?: "pending" | "approved" | "rejected"): Promise<ApprovalRecord[]>;
  uploadArtifact(params: { filename: string; data: Buffer; mime_type?: string }): Promise<ArtifactRef>;
  downloadArtifact(artifactId: string): Promise<{ meta: ArtifactRef; data: Buffer } | null>;
  upsertKbDoc(params: Parameters<MailroomStore["upsertKbDoc"]>[0]): Promise<KbDocRecord>;
  searchKb(query: string, project?: string, limit?: number): Promise<KbDocRecord[]>;
  recordFeedback(params: Parameters<MailroomStore["recordFeedback"]>[0]): Promise<FeedbackRecord>;
  listPendingFeedback(project?: string): Promise<FeedbackRecord[]>;
  subscribeEnvelopes?(agentId: string, onEnvelope: (env: DeckEnvelope) => void): () => void;
  close(): void;
}

export class LocalMailroomClient implements MailroomClient {
  public readonly mode = "local" as const;
  public readonly store: MailroomStore;

  constructor(dataDir: string) {
    this.store = new MailroomStore(dataDir);
  }

  async registerAgent(params: Parameters<MailroomStore["registerAgent"]>[0]): Promise<RegisteredAgent> {
    return this.store.registerAgent(params);
  }
  async heartbeat(agentId: string, metadata?: Record<string, unknown>): Promise<void> {
    this.store.heartbeat(agentId, metadata);
  }
  async listAgents(): Promise<RegisteredAgent[]> {
    return this.store.listAgents();
  }
  async sendEnvelope(input: SendEnvelopeInput): Promise<DeckEnvelope> {
    return this.store.sendEnvelope(input);
  }
  async pullInbox(agentId: string, options?: { types?: EnvelopeType[]; limit?: number }): Promise<DeckEnvelope[]> {
    return this.store.pullInbox(agentId, options);
  }
  async ackEnvelope(envelopeId: string, agentId: string): Promise<boolean> {
    return this.store.ackEnvelope(envelopeId, agentId);
  }
  async getTrace(traceId: string): Promise<DeckEnvelope[]> {
    return this.store.getTrace(traceId);
  }
  async listTasks(): Promise<TaskRecord[]> {
    return this.store.listTasks();
  }
  async createApproval(params: {
    requested_by: string;
    action_summary: string;
    task_id?: string;
    risk_level?: RiskLevel;
    ttl_minutes?: number;
    metadata?: Record<string, unknown>;
  }): Promise<ApprovalRecord> {
    return this.store.createApproval(params);
  }
  async decideApproval(params: {
    idOrShortCode: string;
    decision: "approved" | "rejected";
    decided_by: string;
    comment?: string;
  }): Promise<ApprovalRecord> {
    return this.store.decideApproval(params);
  }
  async listApprovals(status?: "pending" | "approved" | "rejected"): Promise<ApprovalRecord[]> {
    return this.store.listApprovals(status);
  }
  async uploadArtifact(params: { filename: string; data: Buffer; mime_type?: string }): Promise<ArtifactRef> {
    return this.store.saveArtifact(params);
  }
  async downloadArtifact(artifactId: string): Promise<{ meta: ArtifactRef; data: Buffer } | null> {
    const found = this.store.getArtifact(artifactId);
    return found ? { meta: found.meta, data: found.data } : null;
  }
  async upsertKbDoc(params: Parameters<MailroomStore["upsertKbDoc"]>[0]): Promise<KbDocRecord> {
    return this.store.upsertKbDoc(params);
  }
  async searchKb(query: string, project?: string, limit?: number): Promise<KbDocRecord[]> {
    return this.store.searchKb(query, project, limit);
  }
  async recordFeedback(params: Parameters<MailroomStore["recordFeedback"]>[0]): Promise<FeedbackRecord> {
    return this.store.recordFeedback(params);
  }
  async listPendingFeedback(project?: string): Promise<FeedbackRecord[]> {
    return this.store.listPendingFeedback(project);
  }
  close(): void {
    this.store.close();
  }
}

export class RemoteMailroomClient implements MailroomClient {
  public readonly mode = "remote" as const;
  private readonly baseUrl: string;

  constructor(
    endpoint: string,
    private readonly token: string
  ) {
    this.baseUrl = endpoint.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
  }

  private isTransientSocketError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = `${err.message} ${String((err as { cause?: { code?: string; message?: string } }).cause?.code ?? "")} ${String((err as { cause?: { message?: string } }).cause?.message ?? "")}`;
    return /fetch failed|UND_ERR_SOCKET|ECONNRESET|EPIPE|other side closed|socket hang up/i.test(msg);
  }

  private async request<T>(method: string, pathStr: string, body?: unknown): Promise<T> {
    const canRetry =
      method === "GET" ||
      pathStr === "/api/heartbeat" ||
      pathStr === "/api/agents" ||
      pathStr === "/api/ack";
    const maxAttempts = canRetry ? 2 : 1;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}${pathStr}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        if (!res.ok) {
          throw new Error(`Relay ${res.status} (${String(json.error ?? "ERROR")}): ${String(json.message ?? text)}`);
        }
        return json as T;
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts && this.isTransientSocketError(err)) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  registerAgent(params: Parameters<MailroomStore["registerAgent"]>[0]): Promise<RegisteredAgent> {
    return this.request<RegisteredAgent>("POST", "/api/agents", params);
  }
  async heartbeat(agentId: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.request("POST", "/api/heartbeat", { agent_id: agentId, metadata });
  }
  async listAgents(): Promise<RegisteredAgent[]> {
    const r = await this.request<{ agents: RegisteredAgent[] }>("GET", "/api/agents");
    return r.agents;
  }
  sendEnvelope(input: SendEnvelopeInput): Promise<DeckEnvelope> {
    return this.request<DeckEnvelope>("POST", "/api/envelopes", input);
  }
  async pullInbox(agentId: string, options?: { types?: EnvelopeType[]; limit?: number }): Promise<DeckEnvelope[]> {
    const params = new URLSearchParams({ agent_id: agentId });
    if (options?.types?.length) params.set("types", options.types.join(","));
    if (options?.limit) params.set("limit", String(options.limit));
    const r = await this.request<{ envelopes: DeckEnvelope[] }>("GET", `/api/inbox?${params.toString()}`);
    return r.envelopes;
  }
  async ackEnvelope(envelopeId: string, agentId: string): Promise<boolean> {
    const r = await this.request<{ acked: boolean }>("POST", "/api/ack", {
      envelope_id: envelopeId,
      agent_id: agentId,
    });
    return r.acked;
  }
  async getTrace(traceId: string): Promise<DeckEnvelope[]> {
    const r = await this.request<{ envelopes: DeckEnvelope[] }>(
      "GET",
      `/api/traces/${encodeURIComponent(traceId)}`
    );
    return r.envelopes;
  }
  async listTasks(): Promise<TaskRecord[]> {
    const r = await this.request<{ tasks: TaskRecord[] }>("GET", "/api/tasks");
    return r.tasks;
  }
  createApproval(params: {
    requested_by: string;
    action_summary: string;
    task_id?: string;
    risk_level?: RiskLevel;
    ttl_minutes?: number;
    metadata?: Record<string, unknown>;
  }): Promise<ApprovalRecord> {
    return this.request<ApprovalRecord>("POST", "/api/approvals", params);
  }
  decideApproval(params: {
    idOrShortCode: string;
    decision: "approved" | "rejected";
    decided_by: string;
    comment?: string;
  }): Promise<ApprovalRecord> {
    return this.request<ApprovalRecord>("POST", "/api/approvals/decide", {
      id_or_short_code: params.idOrShortCode,
      decision: params.decision,
      decided_by: params.decided_by,
      comment: params.comment,
    });
  }
  async listApprovals(status?: "pending" | "approved" | "rejected"): Promise<ApprovalRecord[]> {
    const q = status ? `?status=${status}` : "";
    const r = await this.request<{ approvals: ApprovalRecord[] }>("GET", `/api/approvals${q}`);
    return r.approvals;
  }
  uploadArtifact(params: { filename: string; data: Buffer; mime_type?: string }): Promise<ArtifactRef> {
    return this.request<ArtifactRef>("POST", "/api/artifacts", {
      filename: params.filename,
      mime_type: params.mime_type,
      content_base64: params.data.toString("base64"),
    });
  }
  async downloadArtifact(artifactId: string): Promise<{ meta: ArtifactRef; data: Buffer } | null> {
    try {
      const r = await this.request<{ meta: ArtifactRef; content_base64: string }>(
        "GET",
        `/api/artifacts/${encodeURIComponent(artifactId)}`
      );
      return { meta: r.meta, data: Buffer.from(r.content_base64, "base64") };
    } catch {
      return null;
    }
  }
  upsertKbDoc(params: Parameters<MailroomStore["upsertKbDoc"]>[0]): Promise<KbDocRecord> {
    return this.request<KbDocRecord>("POST", "/api/kb/docs", params);
  }
  async searchKb(query: string, project?: string, limit?: number): Promise<KbDocRecord[]> {
    const p = new URLSearchParams({ q: query });
    if (project) p.set("project", project);
    if (limit) p.set("limit", String(limit));
    const r = await this.request<{ docs: KbDocRecord[] }>("GET", `/api/kb/search?${p.toString()}`);
    return r.docs;
  }
  recordFeedback(params: Parameters<MailroomStore["recordFeedback"]>[0]): Promise<FeedbackRecord> {
    return this.request<FeedbackRecord>("POST", "/api/feedback", params);
  }
  async listPendingFeedback(project?: string): Promise<FeedbackRecord[]> {
    const q = project ? `?project=${encodeURIComponent(project)}` : "";
    const r = await this.request<{ entries: FeedbackRecord[] }>("GET", `/api/feedback${q}`);
    return r.entries;
  }

  subscribeEnvelopes(_agentId: string, onEnvelope: (env: DeckEnvelope) => void): () => void {
    const wsUrl = `${this.baseUrl.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(this.token)}`;
    let closed = false;
    let ws: WebSocket | null = null;
    let pingTimer: NodeJS.Timeout | null = null;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(wsUrl);
      ws.on("open", () => {
        pingTimer = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 30_000);
      });
      ws.on("message", (raw) => {
        try {
          const parsed = JSON.parse(raw.toString("utf8")) as { event?: string; envelope?: DeckEnvelope };
          if (parsed.event === "envelope" && parsed.envelope) {
            onEnvelope(parsed.envelope);
          }
        } catch {
          // Ignore malformed event frame
        }
      });
      ws.on("close", () => {
        if (pingTimer) clearInterval(pingTimer);
        if (!closed) setTimeout(connect, 3_000);
      });
      ws.on("error", () => {
        // Reconnect handled in close
      });
    };

    connect();
    return () => {
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      ws?.close();
    };
  }

  close(): void {
    // Stateless HTTP client
  }
}

export function createMailroomClient(endpoint?: string, token?: string): MailroomClient {
  const ep = endpoint ?? process.env.DECK_ENDPOINT ?? "file://./.deck/mailroom";
  if (ep.startsWith("http://") || ep.startsWith("https://") || ep.startsWith("ws://") || ep.startsWith("wss://")) {
    return new RemoteMailroomClient(ep, token ?? process.env.DECK_AGENT_TOKEN ?? "");
  }
  const localDir = ep.startsWith("file://")
    ? ep.startsWith("file:///")
      ? fileURLToPath(ep)
      : ep.slice("file://".length)
    : ep;
  return new LocalMailroomClient(localDir);
}
