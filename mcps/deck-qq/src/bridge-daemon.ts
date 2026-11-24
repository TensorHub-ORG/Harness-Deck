import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactRef, DeckEnvelope, generateTaskId, scrubSecrets } from "@harness-deck/protocol";
import { MailroomClient } from "@harness-deck/mailroom";
import { InboundMediaItem, OneBotClient, OneBotEvent, extractInboundMedia } from "./onebot.js";
import { LlmBrainConfig, OpenAiCompatibleBrain, ToolDefinition, ToolHandlerMap } from "./llm-brain.js";

interface PendingDispatchRecord {
  taskId: string;
  targetWorkerId: string;
  project: string;
  instruction: string;
  preferredDriver?: string;
  bossQq: string;
  resumeSessionId?: string;
  existingBranch?: string;
  reworkOfTaskId?: string;
  attachments?: ArtifactRef[];
}

const MAX_INBOUND_FILE_BYTES = 25 * 1024 * 1024;
const BOSS_ARTIFACT_TTL_MS = 15 * 60 * 1000;

function inferMimeType(filename: string, kind: "file" | "image"): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".txt" || ext === ".log" || ext === ".md") return "text/plain";
  if (ext === ".json") return "application/json";
  if (ext === ".csv") return "text/csv";
  if (ext === ".zip") return "application/zip";
  return kind === "image" ? "image/png" : "application/octet-stream";
}

export interface QqBridgeOptions {
  profile: "o1" | "k1";
  agentId: string;
  mailroom: MailroomClient;
  /** Optional T0 Boss-scoped mailroom client used ONLY after verifying Boss QQ whitelist */
  bossMailroom?: MailroomClient;
  napcatWsUrl: string;
  napcatToken?: string;
  bossQqList: string[];
  communityGroupList: string[];
  defaultRiskLevel?: "L1" | "L2" | "L3";
  defaultWorkerId?: string;
  secretaryId?: string;
  qmmiWebhookUrl?: string;
  llm?: LlmBrainConfig;
  personaFile?: string;
  logger?: (msg: string) => void;
}

/**
 * Qmmi + NapCat <-> Harness-Deck Mailroom Bridge Daemon:
 * - Profile "o1" (T1 Secretary):
 *     * Accepts private QQ chats ONLY from T0 Boss allowlist
 *     * Handles T0 short-code approvals (`批准 A-104` / `拒绝 A-104`)
 *     * Handles task dispatch commands (`派单 <project> <instruction>`) or forwards to Qmmi runtime
 *     * Relays incoming `task.result`, `notify.secretary`, `task.question`, `report.digest` + files to Boss QQ!
 * - Profile "k1" (T3 Frontline):
 *     * Listens ONLY to allowlisted community QQ groups
 *     * Answers from read-only KB or logs structured feedback
 *     * Executes downward `directive` envelopes from superior O1 (e.g. release followup)
 *     * Strictly CANNOT DM Boss or dispatch desktop engineers!
 */
export class QqBridgeDaemon {
  private readonly onebot: OneBotClient;
  private readonly brain: OpenAiCompatibleBrain | null;
  private readonly personaText: string;
  private readonly log: (msg: string) => void;
  private readonly processingEnvelopeIds = new Set<string>();
  private readonly pendingL3Dispatches = new Map<string, PendingDispatchRecord>();
  private readonly recentBossArtifacts = new Map<string, Array<{ ref: ArtifactRef; uploadedAt: number }>>();
  private readonly lastProgressNotifyAt = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | null = null;
  private unsubWs: (() => void) | null = null;

  constructor(private readonly options: QqBridgeOptions) {
    this.log = options.logger ?? ((m) => console.error(`[qq-bridge:${options.profile}] ${m}`));
    this.personaText = this.loadPersonaText(options.personaFile);
    this.brain =
      options.llm && options.llm.baseUrl && options.llm.apiKey && options.llm.model
        ? new OpenAiCompatibleBrain(options.llm)
        : null;
    this.onebot = new OneBotClient({
      wsUrl: options.napcatWsUrl,
      accessToken: options.napcatToken,
      onEvent: (ev) => void this.handleQqEvent(ev),
      onDisconnect: (reason) => this.log(`WATCHDOG ALERT: NapCat disconnected (${reason}). Retrying...`),
    });
  }

  private loadPersonaText(personaFile?: string): string {
    const candidates = [
      personaFile,
      process.env.DECK_QQ_PERSONA_FILE,
      path.resolve(process.cwd(), "deploy", "presets", "coomi-o1-persona.txt"),
    ].filter((p): p is string => Boolean(p));

    for (const candidate of candidates) {
      const abs = path.resolve(candidate);
      if (fs.existsSync(abs)) {
        return fs.readFileSync(abs, "utf8").trim();
      }
    }

    return [
      "你是库米 O1（英文名 Coomi O1），TensorHub 理工女形态，担任 T1 秘书主管，1v1 向老板 Septemc（T0）汇报。",
      "说话精炼简洁高效，像日志和终端输出，先结论后证据再给下一步，禁止客服味与 AI 味。",
      "严禁使用任何 Markdown 语法（禁止 ** ### ``` ` - 等），只输出干净的正常纯文本，默认不用多余句号和感叹号。",
    ].join("\n");
  }

  public async start(): Promise<void> {
    const isO1 = this.options.profile === "o1";
    await this.options.mailroom.registerAgent({
      agent_id: this.options.agentId,
      role: isO1 ? "secretary" : "frontline",
      tier: isO1 ? "T1" : "T3",
      reports_to: isO1 ? "boss" : (this.options.secretaryId ?? "kumi-o1"),
      display_name: isO1 ? "库米 O1 / Coomi O1 (秘书主管)" : "库米 K1 / Coomi K1 (社区专员)",
      metadata: {
        profile: this.options.profile,
        napcat_ws: this.options.napcatWsUrl,
      },
    });

    await this.onebot.connect();
    this.log(
      `Connected to NapCat at ${this.options.napcatWsUrl}${
        this.options.llm ? ` | LLM Brain: ${this.options.llm.model} (${this.options.llm.baseUrl})` : ""
      }`
    );

    if (this.options.mailroom.subscribeEnvelopes) {
      this.unsubWs = this.options.mailroom.subscribeEnvelopes(this.options.agentId, (env) => {
        void this.handleMailroomEnvelope(env);
      });
    }

    this.pollTimer = setInterval(() => {
      void this.pollMailroom();
      void this.options.mailroom.heartbeat(this.options.agentId);
    }, 3000);
    await this.pollMailroom();
  }

  public stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.unsubWs) this.unsubWs();
    this.onebot.close();
  }

  private async pollMailroom(): Promise<void> {
    const inbox = await this.options.mailroom.pullInbox(this.options.agentId, { limit: 20 });
    for (const env of inbox) {
      await this.handleMailroomEnvelope(env);
    }
  }

  private pruneBossArtifacts(bossQq: string): Array<{ ref: ArtifactRef; uploadedAt: number }> {
    const now = Date.now();
    const valid = (this.recentBossArtifacts.get(bossQq) ?? []).filter(
      (item) => now - item.uploadedAt <= BOSS_ARTIFACT_TTL_MS
    );
    if (valid.length > 0) {
      this.recentBossArtifacts.set(bossQq, valid);
    } else {
      this.recentBossArtifacts.delete(bossQq);
    }
    return valid;
  }

  private consumeBossArtifacts(bossQq: string): ArtifactRef[] {
    const items = this.pruneBossArtifacts(bossQq);
    this.recentBossArtifacts.delete(bossQq);
    return items.map((i) => i.ref);
  }

  private async ingestBossMedia(bossQq: string, files: InboundMediaItem[]): Promise<ArtifactRef[]> {
    const uploaded: ArtifactRef[] = [];
    for (const item of files) {
      try {
        let data: Buffer | null = null;
        let filename = item.filename;

        if (item.localPath && fs.existsSync(item.localPath)) {
          const stat = fs.statSync(item.localPath);
          if (stat.size <= MAX_INBOUND_FILE_BYTES) {
            data = fs.readFileSync(item.localPath);
          }
        }

        if (!data && item.fileId) {
          const res = await this.onebot.getFile(item.fileId);
          const payload = (res.data ?? {}) as Record<string, unknown>;
          const remoteFile = typeof payload.file === "string" ? payload.file : undefined;
          const remoteBase64 = typeof payload.base64 === "string" ? payload.base64 : undefined;
          const remoteUrl = typeof payload.url === "string" ? payload.url : undefined;
          if (typeof payload.file_name === "string" && payload.file_name.trim()) {
            filename = payload.file_name.trim();
          }
          if (remoteFile && fs.existsSync(remoteFile)) {
            const stat = fs.statSync(remoteFile);
            if (stat.size <= MAX_INBOUND_FILE_BYTES) {
              data = fs.readFileSync(remoteFile);
            }
          } else if (remoteBase64) {
            const decoded = Buffer.from(remoteBase64, "base64");
            if (decoded.length <= MAX_INBOUND_FILE_BYTES) {
              data = decoded;
            }
          } else if (remoteUrl && /^https?:\/\//i.test(remoteUrl)) {
            const resp = await fetch(remoteUrl);
            if (resp.ok) {
              const arr = Buffer.from(await resp.arrayBuffer());
              if (arr.length <= MAX_INBOUND_FILE_BYTES) data = arr;
            }
          }
        }

        if (!data && item.url && /^https?:\/\//i.test(item.url)) {
          const resp = await fetch(item.url);
          if (resp.ok) {
            const arr = Buffer.from(await resp.arrayBuffer());
            if (arr.length <= MAX_INBOUND_FILE_BYTES) data = arr;
          }
        }

        if (!data || data.length === 0) {
          this.log(`Could not retrieve bytes for inbound QQ ${item.kind} "${filename}"`);
          continue;
        }

        const ref = await this.options.mailroom.uploadArtifact({
          filename,
          data,
          mime_type: inferMimeType(filename, item.kind),
        });
        const existing = this.pruneBossArtifacts(bossQq);
        existing.push({ ref, uploadedAt: Date.now() });
        this.recentBossArtifacts.set(bossQq, existing.slice(-8));
        uploaded.push(ref);
      } catch (err) {
        this.log(`Inbound media ingest error (${item.filename}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return uploaded;
  }

  private async handleQqEvent(ev: OneBotEvent): Promise<void> {
    const senderId = String(ev.user_id ?? "");

    if (this.options.profile === "o1") {
      // T1 Secretary ONLY accepts private messages or offline_file notices from T0 Boss allowlist
      if (!this.options.bossQqList.includes(senderId)) return;
      const isPrivateMsg = ev.post_type === "message" && ev.message_type === "private";
      const isOfflineFile = ev.post_type === "notice" && ev.notice_type === "offline_file";
      if (!isPrivateMsg && !isOfflineFile) return;

      const { text, files } = extractInboundMedia(ev);
      let uploaded: ArtifactRef[] = [];
      if (files.length > 0) {
        uploaded = await this.ingestBossMedia(senderId, files);
      }
      if (!text) {
        if (uploaded.length > 0) {
          const desc = uploaded
            .map((a) => `${a.filename}（${Math.max(1, Math.round(a.size_bytes / 1024))}KB）`)
            .join("、");
          await this.onebot.sendPrivateMessage(
            senderId,
            `收到文件 ${desc} 接下来直接说交给哪个项目和工位处理 我会自动附带给桌面 CLI（15分钟内有效）`
          );
        }
        return;
      }
      await this.handleBossCommand(senderId, text);
      return;
    }

    // Profile "k1" (T3 Frontline): ONLY allowlisted community QQ groups
    if (ev.post_type !== "message" || !ev.raw_message) return;
    const text = ev.raw_message.trim();
    const groupId = String(ev.group_id ?? "");
    if (ev.message_type !== "group" || !this.options.communityGroupList.includes(groupId)) {
      return;
    }
    await this.handleCommunityMessage(groupId, senderId, ev.sender?.nickname ?? senderId, text);
  }

  private async executeApprovalDecision(
    bossQq: string,
    codeOrAuto: string | undefined,
    decision: "approved" | "rejected",
    comment?: string
  ): Promise<{ ok: boolean; message: string; task_id?: string; short_code?: string }> {
    let targetCode = codeOrAuto;
    if (!targetCode) {
      const pendingList = await this.options.mailroom.listApprovals("pending");
      if (pendingList.length === 0) {
        return { ok: false, message: "当前没有待审批的工单" };
      }
      if (pendingList.length > 1) {
        const lines = pendingList.map((a, idx) => `${idx + 1} ${a.short_code} ${a.action_summary}`);
        return { ok: false, message: `？有多个待审批项 要操作哪个\n${lines.join("\n")}` };
      }
      targetCode = pendingList[0]!.short_code;
    }

    const approverClient = this.options.bossMailroom ?? this.options.mailroom;
    const rec = await approverClient.decideApproval({
      idOrShortCode: targetCode,
      decision,
      decided_by: `boss_qq_${bossQq}`,
      comment,
    });

    if (decision === "rejected") {
      this.pendingL3Dispatches.delete(rec.short_code);
      return {
        ok: true,
        short_code: rec.short_code,
        message: `已拒绝 ${rec.short_code}${comment ? ` 理由 ${comment}` : ""}`,
      };
    }

    const pending =
      this.pendingL3Dispatches.get(rec.short_code) ??
      this.pendingL3Dispatches.get(rec.approval_id) ??
      (rec.metadata?.pending_dispatch as PendingDispatchRecord | undefined);
    if (pending) {
      this.pendingL3Dispatches.delete(rec.short_code);
      await this.options.mailroom.sendEnvelope({
        from: { agent_id: this.options.agentId, role: "secretary", tier: "T1" },
        to: { agent_id: pending.targetWorkerId, role: "worker", tier: "T2" },
        type: "task.dispatch",
        security: { risk_level: "L3", approval_ref: rec.approval_id },
        attachments: pending.attachments ?? [],
        payload: {
          task_id: pending.taskId,
          project: pending.project,
          title: pending.instruction.slice(0, 80),
          instruction: pending.instruction,
          preferred_driver: pending.preferredDriver,
          sandbox_profile: "L3_APPROVED_EXEC",
          ...(pending.resumeSessionId ? { resume_session_id: pending.resumeSessionId } : {}),
          ...(pending.existingBranch ? { existing_branch: pending.existingBranch } : {}),
          ...(pending.reworkOfTaskId ? { rework_of_task_id: pending.reworkOfTaskId } : {}),
        },
      });
      const attachNote =
        pending.attachments && pending.attachments.length > 0 ? ` 附带 ${pending.attachments.length} 个文件` : "";
      const resumeNote = pending.reworkOfTaskId ? ` 续接 ${pending.reworkOfTaskId}` : "";
      return {
        ok: true,
        short_code: rec.short_code,
        task_id: pending.taskId,
        message: `get 已批准 ${rec.short_code}\n工单 ${pending.taskId} 已派发到 ${pending.targetWorkerId} 项目 ${pending.project}${resumeNote}${attachNote} 开始跑`,
      };
    }

    return {
      ok: true,
      short_code: rec.short_code,
      message: `get 已批准 ${rec.short_code} 令牌 ${rec.approval_id} 已解锁`,
    };
  }

  private async resolveResumeContext(taskId: string): Promise<{
    project: string;
    preferredDriver?: string;
    existingBranch?: string;
    resumeSessionId?: string;
    targetWorkerId?: string;
  } | null> {
    const tasks = await this.options.mailroom.listTasks();
    const prev = tasks.find((t) => t.task_id.toLowerCase() === taskId.toLowerCase());
    if (!prev) return null;
    let sessionId: string | undefined;
    let branch: string | undefined = prev.branch ?? undefined;
    if (prev.result_json) {
      try {
        const parsed = JSON.parse(prev.result_json) as { session_id?: string; branch?: string };
        if (typeof parsed.session_id === "string" && parsed.session_id) sessionId = parsed.session_id;
        if (!branch && typeof parsed.branch === "string" && parsed.branch) branch = parsed.branch;
      } catch {
        // ignore malformed result_json
      }
    }
    return {
      project: prev.project,
      preferredDriver: prev.driver ?? undefined,
      existingBranch: branch,
      resumeSessionId: sessionId,
      targetWorkerId: prev.assigned_to ?? undefined,
    };
  }

  private async cancelRunningTask(
    taskId: string,
    reason?: string
  ): Promise<{ ok: boolean; message: string; target_worker?: string }> {
    const tasks = await this.options.mailroom.listTasks();
    const rec = tasks.find((t) => t.task_id.toLowerCase() === taskId.toLowerCase());
    const workers = (await this.options.mailroom.listAgents()).filter((a) => a.tier === "T2");
    const targetWorker =
      (rec?.assigned_to ? workers.find((w) => w.agent_id === rec.assigned_to) : undefined) ??
      workers.find((w) => w.agent_id === this.options.defaultWorkerId) ??
      workers.find((w) => w.online) ??
      workers[0];
    if (!targetWorker) {
      return { ok: false, message: `找不到在线桌面工位 无法取消 ${taskId}` };
    }
    const cleanReason = reason?.trim() || "老板通过 QQ 请求中止";
    await this.options.mailroom.sendEnvelope({
      from: { agent_id: this.options.agentId, role: "secretary", tier: "T1" },
      to: { agent_id: targetWorker.agent_id, role: "worker", tier: "T2" },
      type: "task.cancel",
      security: { risk_level: "L2" },
      payload: {
        task_id: rec?.task_id ?? taskId,
        reason: cleanReason,
      },
    });
    return {
      ok: true,
      target_worker: targetWorker.agent_id,
      message: `已向 ${targetWorker.agent_id} 下发中止信号 取消工单 ${rec?.task_id ?? taskId}`,
    };
  }

  private async dispatchOrQueueTask(params: {
    bossQq: string;
    project?: string;
    instruction: string;
    preferredDriver?: string;
    resumeFromTaskId?: string;
  }): Promise<{
    ok: boolean;
    status?: "PENDING_T0_APPROVAL" | "DISPATCHED";
    task_id?: string;
    short_code?: string;
    target_worker?: string;
    worker_online?: boolean;
    attachment_count?: number;
    resumed_session?: boolean;
    message: string;
    error?: string;
  }> {
    let project = params.project?.trim() ?? "";
    let preferredDriver = params.preferredDriver?.trim() || undefined;
    let resumeSessionId: string | undefined;
    let existingBranch: string | undefined;
    let reworkOfTaskId: string | undefined;
    let preferredWorkerId: string | undefined;

    if (params.resumeFromTaskId) {
      const ctx = await this.resolveResumeContext(params.resumeFromTaskId);
      if (!ctx) {
        return {
          ok: false,
          error: `找不到历史工单 ${params.resumeFromTaskId}`,
          message: `找不到历史工单 ${params.resumeFromTaskId} 无法续聊`,
        };
      }
      if (!project) project = ctx.project;
      if (!preferredDriver) preferredDriver = ctx.preferredDriver;
      resumeSessionId = ctx.resumeSessionId;
      existingBranch = ctx.existingBranch;
      reworkOfTaskId = params.resumeFromTaskId;
      preferredWorkerId = ctx.targetWorkerId;
    }

    if (!project) {
      return { ok: false, error: "缺少目标项目名", message: "缺少目标项目名 请先指定白名单项目" };
    }

    const workers = (await this.options.mailroom.listAgents()).filter((a) => a.tier === "T2");
    const targetWorker =
      (preferredWorkerId ? workers.find((w) => w.agent_id === preferredWorkerId) : undefined) ??
      workers.find((w) => w.agent_id === this.options.defaultWorkerId) ??
      workers.find((w) => w.online && w.agent_id.startsWith("dispatcher")) ??
      workers.find((w) => w.online) ??
      workers[0];

    if (!targetWorker) {
      return {
        ok: false,
        error: "当前没有已注册的桌面工程师节点",
        message: "当前没有已注册的桌面工程师节点 请先启动桌面工长",
      };
    }

    const attachments = this.consumeBossArtifacts(params.bossQq);
    const taskId = generateTaskId();
    const riskLevel = this.options.defaultRiskLevel ?? "L3";
    const attachNote = attachments.length > 0 ? ` 附带 ${attachments.length} 个文件` : "";
    const resumeNote = reworkOfTaskId
      ? ` 续接 ${reworkOfTaskId}${resumeSessionId ? "（复用会话上下文）" : ""}`
      : "";

    if (riskLevel === "L3") {
      const pendingInfo: PendingDispatchRecord = {
        taskId,
        targetWorkerId: targetWorker.agent_id,
        project,
        instruction: params.instruction,
        preferredDriver,
        bossQq: params.bossQq,
        resumeSessionId,
        existingBranch,
        reworkOfTaskId,
        attachments: attachments.length > 0 ? attachments : undefined,
      };
      const apr = await this.options.mailroom.createApproval({
        requested_by: this.options.agentId,
        task_id: taskId,
        risk_level: "L3",
        action_summary: `[${project}${preferredDriver ? `/${preferredDriver}` : ""}${reworkOfTaskId ? ` 续:${reworkOfTaskId}` : ""}] ${params.instruction.slice(0, 180)}`,
        metadata: { pending_dispatch: pendingInfo },
      });
      this.pendingL3Dispatches.set(apr.short_code, pendingInfo);
      return {
        ok: true,
        status: "PENDING_T0_APPROVAL",
        task_id: taskId,
        short_code: apr.short_code,
        target_worker: targetWorker.agent_id,
        worker_online: targetWorker.online,
        attachment_count: attachments.length,
        resumed_session: Boolean(resumeSessionId),
        message: [
          `待老板审批 L3 短码 ${apr.short_code}`,
          `工单 ${taskId} 目标 ${targetWorker.agent_id} ${targetWorker.online ? "在线" : "离线排队"}`,
          `项目 ${project}${preferredDriver ? ` 工位 ${preferredDriver}` : ""}${resumeNote}${attachNote}`,
          `内容 ${params.instruction.slice(0, 300)}`,
          `回复 批准 ${apr.short_code} 放行 或回复 拒绝 ${apr.short_code} 取消`,
        ].join("\n"),
      };
    }

    await this.options.mailroom.sendEnvelope({
      from: { agent_id: this.options.agentId, role: "secretary", tier: "T1" },
      to: { agent_id: targetWorker.agent_id, role: "worker", tier: "T2" },
      type: "task.dispatch",
      security: { risk_level: riskLevel },
      attachments,
      payload: {
        task_id: taskId,
        project,
        title: params.instruction.slice(0, 80),
        instruction: params.instruction,
        preferred_driver: preferredDriver,
        sandbox_profile: riskLevel === "L1" ? "L1_READONLY" : "L2_WORKTREE_DEV",
        ...(resumeSessionId ? { resume_session_id: resumeSessionId } : {}),
        ...(existingBranch ? { existing_branch: existingBranch } : {}),
        ...(reworkOfTaskId ? { rework_of_task_id: reworkOfTaskId } : {}),
      },
    });
    const statusNote = targetWorker.online
      ? "桌面工位在线 已下发开始跑"
      : "桌面电脑目前离线 工单已入队 上线后自动跑";
    return {
      ok: true,
      status: "DISPATCHED",
      task_id: taskId,
      target_worker: targetWorker.agent_id,
      worker_online: targetWorker.online,
      attachment_count: attachments.length,
      resumed_session: Boolean(resumeSessionId),
      message: `get 工单 ${taskId} 项目 ${project}${preferredDriver ? ` 工位 ${preferredDriver}` : ""}${resumeNote}${attachNote}\n${statusNote}`,
    };
  }

  private async handleBossCommand(bossQq: string, text: string): Promise<void> {
    // 1. Direct approval/rejection fast-path: "批准 A-104" / "授权" / "同意" / "拒绝 A-104"
    const approveMatch = text.match(/^(批准|同意|授权|approve)(?:\s+#?([A-Za-z0-9_-]+))?$/i);
    if (approveMatch) {
      try {
        const res = await this.executeApprovalDecision(bossQq, approveMatch[2], "approved");
        await this.onebot.sendPrivateMessage(bossQq, res.message);
      } catch (err) {
        await this.onebot.sendPrivateMessage(
          bossQq,
          `审批失败 ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return;
    }

    const rejectMatch = text.match(/^(拒绝|否决|取消审批|reject)(?:\s+#?([A-Za-z0-9_-]+))?(?:\s+(.+))?$/i);
    if (rejectMatch) {
      const code = rejectMatch[2];
      const reason = rejectMatch[3];
      try {
        const res = await this.executeApprovalDecision(bossQq, code, "rejected", reason);
        await this.onebot.sendPrivateMessage(bossQq, res.message);
      } catch (err) {
        await this.onebot.sendPrivateMessage(
          bossQq,
          `拒绝失败 ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return;
    }

    // 1b. Direct task cancellation fast-path: "取消 T-xxxx [reason]" / "终止 T-xxxx"
    const cancelMatch = text.match(/^(取消|终止|停止|cancel)\s+#?(T-[A-Za-z0-9_-]+)(?:\s+(.+))?$/i);
    if (cancelMatch) {
      try {
        const res = await this.cancelRunningTask(cancelMatch[2]!, cancelMatch[3]);
        await this.onebot.sendPrivateMessage(bossQq, res.message);
      } catch (err) {
        await this.onebot.sendPrivateMessage(
          bossQq,
          `取消失败 ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return;
    }

    // 1c. Direct session resume fast-path: "续聊 T-xxxx <instruction>" / "resume T-xxxx <instruction>"
    const resumeMatch = text.match(/^(续聊|继续|续接|resume)\s+#?(T-[A-Za-z0-9_-]+)\s+(.+)$/is);
    if (resumeMatch) {
      try {
        const res = await this.dispatchOrQueueTask({
          bossQq,
          resumeFromTaskId: resumeMatch[2]!,
          instruction: resumeMatch[3]!.trim(),
        });
        await this.onebot.sendPrivateMessage(bossQq, res.message);
      } catch (err) {
        await this.onebot.sendPrivateMessage(
          bossQq,
          `续聊派单失败 ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return;
    }

    // 2. Quick dispatch command: "派单 <project> [driver:<name>] <instruction>"
    const dispatchMatch = text.match(/^(派单|dispatch)\s+(\S+)\s+(.+)$/is);
    if (dispatchMatch) {
      const project = dispatchMatch[2]!;
      let rest = dispatchMatch[3]!.trim();
      let preferredDriver: string | undefined;
      const drvMatch = rest.match(/^driver:(\S+)\s+(.+)$/is);
      if (drvMatch) {
        preferredDriver = drvMatch[1]!;
        rest = drvMatch[2]!.trim();
      }
      const res = await this.dispatchOrQueueTask({
        bossQq,
        project,
        instruction: rest,
        preferredDriver,
      });
      await this.onebot.sendPrivateMessage(bossQq, res.message);
      return;
    }

    // 3. Built-in OpenAI-compatible Secretary Brain (natural language + tool calling)
    if (this.brain) {
      try {
        const reply = await this.handleBossNaturalLanguage(bossQq, text);
        if (reply) {
          await this.onebot.sendPrivateMessage(bossQq, reply);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`O1 LLM error: ${msg}`);
        await this.onebot.sendPrivateMessage(bossQq, `模型调用报错 ${msg.slice(0, 200)}`);
      }
      return;
    }

    // 4. Forward natural conversation to external Qmmi agent runtime if configured
    if (this.options.qmmiWebhookUrl) {
      try {
        const res = await fetch(this.options.qmmiWebhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "o1", boss_qq: bossQq, text }),
        });
        const body = (await res.json()) as { reply?: string };
        if (body.reply) {
          await this.onebot.sendPrivateMessage(bossQq, body.reply);
        }
      } catch (err) {
        this.log(`Qmmi webhook error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    // 5. Built-in help summary if neither LLM nor Qmmi webhook is attached
    if (/^(帮助|help|状态|status)$/i.test(text)) {
      const agents = await this.options.mailroom.listAgents();
      const summary = agents.map((a) => `- ${a.agent_id} [${a.tier}] ${a.online ? "在线" : "离线"}`).join("\n");
      await this.onebot.sendPrivateMessage(
        bossQq,
        [
          "库米 O1 指挥指令速查",
          "1 派单 <项目名> [driver:dsh|agy|claude|codex|zcode] <任务描述>（先发文件会自动附带）",
          "2 续聊 <工单号> <继续要求>（自动继承原分支与 session）",
          "3 取消 <工单号> [原因]（强杀运行中任务）",
          "4 批准 <短码> / 拒绝 <短码> [理由]",
          "当前在线节点",
          summary || "暂无",
        ].join("\n")
      );
    }
  }

  private async handleBossNaturalLanguage(bossQq: string, text: string): Promise<string> {
    const agents = await this.options.mailroom.listAgents();
    const workers = agents.filter((a) => a.tier === "T2");
    const pendingApprovals = await this.options.mailroom.listApprovals("pending");
    const recentFiles = this.pruneBossArtifacts(bossQq);
    const defaultRisk = this.options.defaultRiskLevel ?? "L3";

    const workerContext = workers
      .map((w) => {
        const meta = w.metadata as { workspaces?: string[]; engineers?: Array<{ name: string; strengths?: string[] }> };
        const wsList = meta.workspaces?.join(", ") || "未知";
        const engList = meta.engineers?.map((e) => e.name).join(", ") || "默认";
        return `- ${w.agent_id} (${w.online ? "在线" : "离线"}) | 白名单项目: [${wsList}] | 可用工程师CLI: [${engList}]`;
      })
      .join("\n");

    const systemPrompt = [
      this.personaText,
      "",
      "=== 运行时实时环境上下文（T1 Coomi O1）===",
      `默认任务风险策略 ${defaultRisk}（L3 模式下派单先生成审批短码 A-xxxx 等老板批准/授权后再放行）`,
      "当前已注册 T2 桌面工位：",
      workerContext || "暂无已注册桌面工位",
      pendingApprovals.length > 0
        ? `待老板审批的 L3 短码：\n${pendingApprovals.map((a, i) => `${i + 1} ${a.short_code} ${a.action_summary}`).join("\n")}`
        : "当前无待审批短码",
      recentFiles.length > 0
        ? `老板刚上传的待附带文件（下次派单将自动转给桌面 CLI）：${recentFiles.map((f) => `${f.ref.filename}(${Math.max(1, Math.round(f.ref.size_bytes / 1024))}KB)`).join(", ")}`
        : "当前无待附带文件",
      "工具使用约定：",
      "1 查节点或任务状态时先调工具 拿到真实数据再简洁回复",
      "2 老板明确让桌面干活时调 dispatch_desktop_task 注意 project 必须用白名单准确名称；若是接着上次任务继续改 可填 resume_from_task_id",
      "3 老板回复授权 批准 同意或拒绝待审批工单时 调 approve_or_reject_pending 工具",
      "4 老板要中止正在跑的任务时 调 cancel_running_task 工具",
      "5 再次自检 绝对不要输出任何 Markdown 符号（** ### ``` ` - 等） 只发正常纯文本",
    ].join("\n");

    const tools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "list_online_nodes",
          description: "查询当前在线的 Harness-Deck 节点、桌面工程师 CLI 与白名单项目。",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "list_recent_tasks",
          description: "查询最近的工程任务工单状态与结果。",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "dispatch_desktop_task",
          description:
            "向桌面工位派发工程任务（支持自动附带老板刚发的 QQ 文件；支持传 resume_from_task_id 续接历史任务的会话与分支；若默认 L3 策略开启则先生成短码审批单）。",
          parameters: {
            type: "object",
            properties: {
              project: {
                type: "string",
                description: "白名单中的项目名，例如 harness-deck / UltraCausal（若填了 resume_from_task_id 可留空自动继承）",
              },
              instruction: { type: "string", description: "清晰具体的任务要求" },
              preferred_driver: { type: "string", description: "可选，指定工程师 CLI：dsh / agy / claude / codex / mock" },
              resume_from_task_id: {
                type: "string",
                description: "可选，要续聊或返工的历史工单号（如 T-123456），会自动复用原项目、分支与 sessionId",
              },
            },
            required: ["instruction"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "cancel_running_task",
          description: "老板要求强行停止或取消正在执行的桌面任务时调用。",
          parameters: {
            type: "object",
            properties: {
              task_id: { type: "string", description: "要中止的工单号（如 T-xxxx）" },
              reason: { type: "string", description: "可选取消原因" },
            },
            required: ["task_id"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "approve_or_reject_pending",
          description: "老板在私聊里明确授权、批准或拒绝待审批的 L3 工单时调用。",
          parameters: {
            type: "object",
            properties: {
              decision: { type: "string", enum: ["approved", "rejected"] },
              short_code: { type: "string", description: "审批短码如 A-1234；若当前只有一条待审可留空" },
              comment: { type: "string", description: "可选备注或拒绝理由" },
            },
            required: ["decision"],
          },
        },
      },
    ];

    const handlers: ToolHandlerMap = {
      list_online_nodes: async () => ({ agents: await this.options.mailroom.listAgents() }),
      list_recent_tasks: async () => ({ tasks: (await this.options.mailroom.listTasks()).slice(0, 10) }),
      approve_or_reject_pending: async (args) => {
        const decision = args.decision === "rejected" ? "rejected" : "approved";
        const code = args.short_code ? String(args.short_code) : undefined;
        const comment = args.comment ? String(args.comment) : undefined;
        return this.executeApprovalDecision(bossQq, code, decision, comment);
      },
      cancel_running_task: async (args) => {
        const taskId = String(args.task_id ?? "").trim();
        const reason = args.reason ? String(args.reason) : undefined;
        if (!taskId) return { ok: false, error: "缺少要取消的 task_id" };
        return this.cancelRunningTask(taskId, reason);
      },
      dispatch_desktop_task: async (args) => {
        const res = await this.dispatchOrQueueTask({
          bossQq,
          project: args.project ? String(args.project) : undefined,
          instruction: String(args.instruction ?? ""),
          preferredDriver: args.preferred_driver ? String(args.preferred_driver) : undefined,
          resumeFromTaskId: args.resume_from_task_id ? String(args.resume_from_task_id) : undefined,
        });
        return {
          ...res,
          ...(res.short_code
            ? { instruction_for_boss: `请回复 批准 ${res.short_code} 放行执行 或回复 拒绝 ${res.short_code} 取消` }
            : {}),
        };
      },
    };

    return this.brain!.chatWithTools({
      sessionKey: `boss:${bossQq}`,
      systemPrompt,
      userMessage: text,
      tools,
      handlers,
    });
  }

  private async handleCommunityMessage(
    groupId: string,
    userId: string,
    nickname: string,
    text: string
  ): Promise<void> {
    // Only respond to explicit triggers (e.g. mentions or prefix) to avoid group spam
    if (!/^(库米|k1|@|\/ask|\/feedback)/i.test(text)) return;

    const cleanQuery = text.replace(/^(库米|k1|\/ask|\/feedback)\s*/i, "").trim();
    if (!cleanQuery) return;

    // 1. Feedback collection
    if (/^(bug|反馈|闪退|报错|建议)/i.test(cleanQuery) || text.toLowerCase().startsWith("/feedback")) {
      await this.options.mailroom.recordFeedback({
        project: "TensorHub",
        category: /建议|需求/.test(cleanQuery) ? "feature" : "bug",
        severity: /闪退|崩溃|打不开|严重/.test(cleanQuery) ? "high" : "medium",
        summary: cleanQuery.slice(0, 300),
        quote: cleanQuery.slice(0, 280),
        source_group_id: groupId,
        source_user_hint: `${nickname}(${userId.slice(-4)})`,
      });
      await this.onebot.sendGroupMessage(groupId, `[库米 K1] 收到！已帮您记录该反馈，稍后会整理汇总同步给维护团队。`);
      return;
    }

    // 2. Read-only KB search
    const hits = await this.options.mailroom.searchKb(cleanQuery, undefined, 2);
    if (hits.length > 0) {
      const top = hits[0]!;
      await this.onebot.sendGroupMessage(
        groupId,
        `[库米 K1 · 知识库参考]\n【${top.project}】${top.title}\n${top.content.slice(0, 500)}`
      );
    } else {
      await this.options.mailroom.sendEnvelope({
        from: { agent_id: this.options.agentId, role: "frontline", tier: "T3" },
        to: { agent_id: this.options.secretaryId ?? "kumi-o1", role: "secretary", tier: "T1" },
        type: "qa.escalation",
        security: { untrusted_origin: true, risk_level: "L1" },
        payload: {
          question_id: `qa_${Date.now().toString(36)}`,
          project: "TensorHub",
          question_summary: cleanQuery.slice(0, 500),
          source_group_id: groupId,
          asker_hint: `${nickname}(${userId.slice(-4)})`,
        },
      });
      await this.onebot.sendGroupMessage(
        groupId,
        "[库米 K1] 这个问题暂时不在我的知识库里，我已登记并上报给主管核实，确认后再来回复您~"
      );
    }
  }

  private async handleMailroomEnvelope(env: DeckEnvelope): Promise<void> {
    if (this.processingEnvelopeIds.has(env.id)) return;
    this.processingEnvelopeIds.add(env.id);
    try {
      if (this.options.profile === "o1") {
        await this.deliverToBoss(env);
      } else if (this.options.profile === "k1" && env.type === "directive") {
        await this.executeK1Directive(env);
      }
      await this.options.mailroom.ackEnvelope(env.id, this.options.agentId);
    } catch (err) {
      this.log(`Error handling envelope ${env.id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.processingEnvelopeIds.delete(env.id);
    }
  }

  private async deliverToBoss(env: DeckEnvelope): Promise<void> {
    const bossQq = this.options.bossQqList[0];
    if (!bossQq) return;

    let text = "";
    if (env.type === "task.result") {
      const p = env.payload;
      const rawBrief = [
        `工单：#${String(p.task_id ?? "")} | 状态：${String(p.status ?? "unknown")} | 执行工位：${String(p.driver ?? "")}`,
        p.branch ? `分支：${String(p.branch)}` : "",
        `输出摘要：\n${String(p.summary ?? "").slice(0, 2000)}`,
        p.diff_stat ? `Git 改动统计：\n${String(p.diff_stat).slice(0, 600)}` : "",
        `Trace: ${env.trace_id}`,
      ]
        .filter(Boolean)
        .join("\n");

      if (this.brain) {
        try {
          text = await this.brain.summarize(
            `${this.personaText}\n\n现在请你把下面桌面工程师的交付结果提炼成正常纯文本简报，按 结论 / 证据(分支与关键改动) / 下一步 三行输出，保留工单号与 Trace ID，严禁任何 Markdown 语法和多余句号感叹号，控制在 220 字以内。`,
            rawBrief
          );
        } catch {
          text = `done ${String(p.task_id ?? "")}\n${rawBrief.slice(0, 1200)}`;
        }
      } else {
        text = `done ${String(p.task_id ?? "")}\n${rawBrief.slice(0, 1200)}`;
      }
    } else if (env.type === "notify.secretary") {
      const p = env.payload;
      text = [
        `桌面端汇报 ${String(p.title ?? "")}`,
        String(p.summary ?? ""),
        p.suggested_action ? `下一步建议 ${String(p.suggested_action)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    } else if (env.type === "task.question") {
      const p = env.payload;
      const opts = Array.isArray(p.options) && p.options.length > 0 ? `\n选项 ${p.options.join(" / ")}` : "";
      text = `？工单 ${String(p.task_id ?? "")} 卡住需要你确认\n${String(p.question ?? "")}${opts}`;
    } else if (env.type === "report.digest") {
      const items = (env.payload.items as Array<Record<string, unknown>>) ?? [];
      const lines = items.map(
        (it, idx) =>
          `${idx + 1} ${String(it.severity)} ${String(it.category)} ${String(it.project)} ${String(it.summary)} x${String(it.occurrence_count ?? 1)}`
      );
      text = [
        `Coomi K1 上报社区简报 外部数据仅作汇总`,
        ...lines,
        `要安排修复直接说项目和要求`,
      ].join("\n");
    } else if (env.type === "task.progress") {
      const p = env.payload;
      const taskId = String(p.task_id ?? "");
      if (!p.heartbeat || !taskId) return;
      const lastAt = this.lastProgressNotifyAt.get(taskId) ?? 0;
      if (Date.now() - lastAt < 55_000) return;
      this.lastProgressNotifyAt.set(taskId, Date.now());
      const driver = String(p.driver ?? "cli");
      const elapsed = p.elapsed_sec ? `${String(p.elapsed_sec)}s` : "";
      const stage = String(p.stage ?? "running");
      text = `运行中 ${taskId}（${driver}${elapsed ? ` 已跑 ${elapsed}` : ""} 阶段 ${stage}） 如需中止回复 取消 ${taskId}`;
    } else if (env.type === "qa.escalation") {
      text = `Coomi K1 上报未命中知识库的问题\n项目 ${String(env.payload.project ?? "")}\n问题 ${String(env.payload.question_summary ?? "")}`;
    } else {
      return;
    }

    await this.onebot.sendPrivateMessage(bossQq, scrubSecrets(text));

    // Relay attached artifacts as QQ private files
    for (const att of env.attachments) {
      const downloaded = await this.options.mailroom.downloadArtifact(att.artifact_id);
      if (!downloaded) continue;
      const tmpFile = path.join(os.tmpdir(), `hdeck_${att.artifact_id}_${att.filename}`);
      fs.writeFileSync(tmpFile, downloaded.data);
      try {
        await this.onebot.uploadPrivateFile(bossQq, tmpFile, att.filename);
      } finally {
        fs.rmSync(tmpFile, { force: true });
      }
    }
  }

  private async executeK1Directive(env: DeckEnvelope): Promise<void> {
    const p = env.payload;
    const kind = String(p.kind ?? "");
    const content = scrubSecrets(String(p.content ?? ""));
    const targets = Array.isArray(p.target_group_ids) && p.target_group_ids.length > 0
      ? (p.target_group_ids as string[]).filter((g) => this.options.communityGroupList.includes(g))
      : this.options.communityGroupList;

    if (kind === "group_followup" || kind === "qa_answer") {
      for (const gid of targets) {
        await this.onebot.sendGroupMessage(gid, `[库米 K1 · 维护团队同步]\n${content}`);
      }
    }
  }
}
