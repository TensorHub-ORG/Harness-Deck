import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { EnvelopeType } from "@harness-deck/protocol";
import { MailroomError, MailroomStore, SendEnvelopeInput } from "./store.js";

export interface RelayServerOptions {
  host?: string;
  port?: number;
  dataDir: string;
  adminToken?: string;
}

/**
 * Lightweight Cross-Machine Relay Server (`deck-relay`):
 * Runs on a VPS alongside Qmmi + NapCat so desktop nodes can connect outbound
 * over HTTP + WebSocket with zero public IP or NAT port forwarding.
 */
export class DeckRelayServer {
  public readonly store: MailroomStore;
  private readonly server: http.Server;
  private readonly wss: WebSocketServer;
  private readonly socketsByAgent = new Map<string, Set<WebSocket>>();
  private readonly adminToken?: string;

  constructor(private readonly options: RelayServerOptions) {
    this.store = new MailroomStore(options.dataDir);
    this.adminToken = options.adminToken;

    this.server = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });

    this.wss = new WebSocketServer({ server: this.server, path: "/ws" });
    this.wss.on("connection", (ws, req) => this.handleWs(ws, req));
  }

  public async start(): Promise<{ host: string; port: number }> {
    const host = this.options.host ?? "0.0.0.0";
    const port = this.options.port ?? 8787;
    await new Promise<void>((resolve) => {
      this.server.listen(port, host, () => resolve());
    });
    const addr = this.server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    return { host, port: actualPort };
  }

  public async stop(): Promise<void> {
    for (const set of this.socketsByAgent.values()) {
      for (const ws of set) ws.close();
    }
    this.socketsByAgent.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.store.close();
  }

  private extractBearer(req: http.IncomingMessage): string | null {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("token");
  }

  private isAdmin(token: string | null): boolean {
    return Boolean(this.adminToken && token && token === this.adminToken);
  }

  private handleWs(ws: WebSocket, req: http.IncomingMessage): void {
    const token = this.extractBearer(req);
    const agent = token ? this.store.authenticateToken(token) : null;
    if (!agent) {
      ws.close(4001, "Unauthorized");
      return;
    }

    this.store.heartbeat(agent.agent_id);
    if (!this.socketsByAgent.has(agent.agent_id)) {
      this.socketsByAgent.set(agent.agent_id, new Set());
    }
    this.socketsByAgent.get(agent.agent_id)!.add(ws);

    // Push pending unacked envelopes immediately on reconnect
    const pending = this.store.pullInbox(agent.agent_id, { limit: 50 });
    for (const env of pending) {
      ws.send(JSON.stringify({ event: "envelope", envelope: env }));
    }

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString("utf8")) as { type?: string };
        if (msg.type === "ping") {
          this.store.heartbeat(agent.agent_id);
          ws.send(JSON.stringify({ event: "pong", timestamp: new Date().toISOString() }));
        }
      } catch {
        // Ignore malformed ping frames
      }
    });

    ws.on("close", () => {
      this.socketsByAgent.get(agent.agent_id)?.delete(ws);
    });
  }

  private pushToRecipient(agentId: string, envelope: unknown): void {
    const sockets = this.socketsByAgent.get(agentId);
    if (!sockets) return;
    const frame = JSON.stringify({ event: "envelope", envelope });
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    }
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return this.sendJson(res, 200, { ok: true, protocol_version: "1.0", time: new Date().toISOString() });
      }

      const token = this.extractBearer(req);
      const admin = this.isAdmin(token);
      const authedAgent = token ? this.store.authenticateToken(token) : null;

      if (!admin && !authedAgent) {
        return this.sendJson(res, 401, { error: "UNAUTHORIZED", message: "Valid Bearer token required." });
      }

      // Agent registration (admin or self)
      if (method === "POST" && url.pathname === "/api/agents") {
        const body = await this.readJsonBody(req);
        if (!admin && authedAgent?.agent_id !== body.agent_id) {
          return this.sendJson(res, 403, { error: "FORBIDDEN", message: "Admin token required to register other agents." });
        }
        const registered = this.store.registerAgent(body as Parameters<MailroomStore["registerAgent"]>[0]);
        return this.sendJson(res, 200, registered);
      }

      if (method === "GET" && url.pathname === "/api/agents") {
        return this.sendJson(res, 200, { agents: this.store.listAgents() });
      }

      if (method === "POST" && url.pathname === "/api/heartbeat") {
        const body = await this.readJsonBody(req);
        const targetId = authedAgent?.agent_id ?? String(body.agent_id ?? "");
        this.store.heartbeat(targetId, body.metadata as Record<string, unknown> | undefined);
        return this.sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && url.pathname === "/api/envelopes") {
        const body = (await this.readJsonBody(req)) as unknown as SendEnvelopeInput;
        // Enforce caller identity unless admin
        if (!admin && authedAgent) {
          body.from = {
            agent_id: authedAgent.agent_id,
            role: authedAgent.role,
            tier: authedAgent.tier,
          };
        }
        const env = this.store.sendEnvelope(body);
        this.pushToRecipient(env.to.agent_id, env);
        return this.sendJson(res, 201, env);
      }

      if (method === "GET" && url.pathname === "/api/inbox") {
        const agentId = admin
          ? url.searchParams.get("agent_id") ?? authedAgent?.agent_id ?? ""
          : authedAgent!.agent_id;
        const typesParam = url.searchParams.get("types");
        const types = typesParam ? (typesParam.split(",") as EnvelopeType[]) : undefined;
        const limit = Number(url.searchParams.get("limit") ?? 20);
        return this.sendJson(res, 200, { envelopes: this.store.pullInbox(agentId, { types, limit }) });
      }

      if (method === "POST" && url.pathname === "/api/ack") {
        const body = await this.readJsonBody(req);
        const agentId = admin ? String(body.agent_id ?? authedAgent?.agent_id ?? "") : authedAgent!.agent_id;
        const ok = this.store.ackEnvelope(String(body.envelope_id ?? ""), agentId);
        return this.sendJson(res, 200, { acked: ok });
      }

      if (method === "GET" && url.pathname.startsWith("/api/traces/")) {
        const traceId = decodeURIComponent(url.pathname.slice("/api/traces/".length));
        return this.sendJson(res, 200, { trace_id: traceId, envelopes: this.store.getTrace(traceId) });
      }

      if (method === "GET" && url.pathname === "/api/tasks") {
        return this.sendJson(res, 200, { tasks: this.store.listTasks() });
      }

      if (method === "POST" && url.pathname === "/api/approvals") {
        if (!admin && authedAgent?.tier !== "T1" && authedAgent?.tier !== "T0") {
          return this.sendJson(res, 403, { error: "FORBIDDEN", message: "Only T0/T1 can create approval requests." });
        }
        const body = await this.readJsonBody(req);
        const rec = this.store.createApproval({
          requested_by: authedAgent?.agent_id ?? String(body.requested_by ?? "kumi-o1"),
          action_summary: String(body.action_summary ?? ""),
          task_id: body.task_id ? String(body.task_id) : undefined,
          risk_level: (body.risk_level as "L1" | "L2" | "L3" | undefined) ?? "L3",
          ttl_minutes: body.ttl_minutes ? Number(body.ttl_minutes) : undefined,
          metadata:
            body.metadata && typeof body.metadata === "object"
              ? (body.metadata as Record<string, unknown>)
              : undefined,
        });
        return this.sendJson(res, 201, rec);
      }

      if (method === "POST" && url.pathname === "/api/approvals/decide") {
        if (!admin && authedAgent?.tier !== "T0") {
          return this.sendJson(res, 403, { error: "FORBIDDEN", message: "Only T0 (Boss) can decide approvals." });
        }
        const body = await this.readJsonBody(req);
        const rec = this.store.decideApproval({
          idOrShortCode: String(body.id_or_short_code ?? ""),
          decision: body.decision === "approved" ? "approved" : "rejected",
          decided_by: authedAgent?.agent_id ?? String(body.decided_by ?? "boss"),
          comment: body.comment ? String(body.comment) : undefined,
        });
        return this.sendJson(res, 200, rec);
      }

      if (method === "GET" && url.pathname === "/api/approvals") {
        const status = url.searchParams.get("status") as "pending" | "approved" | "rejected" | null;
        return this.sendJson(res, 200, { approvals: this.store.listApprovals(status ?? undefined) });
      }

      if (method === "POST" && url.pathname === "/api/artifacts") {
        const body = await this.readJsonBody(req);
        const data = Buffer.from(String(body.content_base64 ?? ""), "base64");
        const ref = this.store.saveArtifact({
          filename: String(body.filename ?? "artifact.bin"),
          data,
          mime_type: body.mime_type ? String(body.mime_type) : undefined,
        });
        return this.sendJson(res, 201, ref);
      }

      if (method === "GET" && url.pathname.startsWith("/api/artifacts/")) {
        const artifactId = decodeURIComponent(url.pathname.slice("/api/artifacts/".length));
        const found = this.store.getArtifact(artifactId);
        if (!found) return this.sendJson(res, 404, { error: "NOT_FOUND" });
        return this.sendJson(res, 200, {
          meta: found.meta,
          content_base64: found.data.toString("base64"),
        });
      }

      if (method === "POST" && url.pathname === "/api/kb/docs") {
        if (!admin && authedAgent?.tier === "T3") {
          return this.sendJson(res, 403, { error: "FORBIDDEN", message: "T3 frontline has read-only KB access." });
        }
        const body = await this.readJsonBody(req);
        const doc = this.store.upsertKbDoc(body as Parameters<MailroomStore["upsertKbDoc"]>[0]);
        return this.sendJson(res, 200, doc);
      }

      if (method === "GET" && url.pathname === "/api/kb/search") {
        const q = url.searchParams.get("q") ?? "";
        const project = url.searchParams.get("project") ?? undefined;
        const limit = Number(url.searchParams.get("limit") ?? 5);
        return this.sendJson(res, 200, { docs: this.store.searchKb(q, project, limit) });
      }

      if (method === "POST" && url.pathname === "/api/feedback") {
        const body = await this.readJsonBody(req);
        const fb = this.store.recordFeedback(body as Parameters<MailroomStore["recordFeedback"]>[0]);
        return this.sendJson(res, 201, fb);
      }

      if (method === "GET" && url.pathname === "/api/feedback") {
        const project = url.searchParams.get("project") ?? undefined;
        return this.sendJson(res, 200, { entries: this.store.listPendingFeedback(project) });
      }

      return this.sendJson(res, 404, { error: "NOT_FOUND", path: url.pathname });
    } catch (err) {
      if (err instanceof MailroomError) {
        return this.sendJson(res, err.statusCode, { error: err.code, message: err.message });
      }
      return this.sendJson(res, 500, {
        error: "INTERNAL_ERROR",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
