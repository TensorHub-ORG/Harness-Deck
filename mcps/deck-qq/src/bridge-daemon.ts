import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeckEnvelope, generateTaskId, scrubSecrets } from "@harness-deck/protocol";
import { MailroomClient } from "@harness-deck/mailroom";
import { OneBotClient, OneBotEvent } from "./onebot.js";
import { LlmBrainConfig, OpenAiCompatibleBrain, ToolDefinition, ToolHandlerMap } from "./llm-brain.js";

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
  private readonly pendingL3Dispatches = new Map<
    string,
    {
      taskId: string;
      targetWorkerId: string;
      project: string;
      instruction: string;
      preferredDriver?: string;
      bossQq: string;
    }
  >();
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

  private async handleQqEvent(ev: OneBotEvent): Promise<void> {
    if (ev.post_type !== "message" || !ev.raw_message) return;
    const text = ev.raw_message.trim();
    const senderId = String(ev.user_id ?? "");

    if (this.options.profile === "o1") {
      // T1 Secretary ONLY accepts private commands from T0 Boss allowlist
      if (ev.message_type !== "private" || !this.options.bossQqList.includes(senderId)) {
        return;
      }
      await this.handleBossCommand(senderId, text);
      return;
    }

    // Profile "k1" (T3 Frontline): ONLY allowlisted community QQ groups
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
      (rec.metadata?.pending_dispatch as
        | {
            taskId: string;
            targetWorkerId: string;
            project: string;
            instruction: string;
            preferredDriver?: string;
            bossQq: string;
          }
        | undefined);
    if (pending) {
      this.pendingL3Dispatches.delete(rec.short_code);
      await this.options.mailroom.sendEnvelope({
        from: { agent_id: this.options.agentId, role: "secretary", tier: "T1" },
        to: { agent_id: pending.targetWorkerId, role: "worker", tier: "T2" },
        type: "task.dispatch",
        security: { risk_level: "L3", approval_ref: rec.approval_id },
        payload: {
          task_id: pending.taskId,
          project: pending.project,
          title: pending.instruction.slice(0, 80),
          instruction: pending.instruction,
          preferred_driver: pending.preferredDriver,
          sandbox_profile: "L3_APPROVED_EXEC",
        },
      });
      return {
        ok: true,
        short_code: rec.short_code,
        task_id: pending.taskId,
        message: `get 已批准 ${rec.short_code}\n工单 ${pending.taskId} 已派发到 ${pending.targetWorkerId} 项目 ${pending.project} 开始跑`,
      };
    }

    return {
      ok: true,
      short_code: rec.short_code,
      message: `get 已批准 ${rec.short_code} 令牌 ${rec.approval_id} 已解锁`,
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
      const workers = (await this.options.mailroom.listAgents()).filter((a) => a.tier === "T2");
      const targetWorker =
        workers.find((w) => w.agent_id === this.options.defaultWorkerId) ?? workers.find((w) => w.online) ?? workers[0];

      if (!targetWorker) {
        await this.onebot.sendPrivateMessage(bossQq, "[库米 O1] 当前没有已注册的桌面工程师节点，请先启动桌面工长。");
        return;
      }

      const taskId = generateTaskId();
      const riskLevel = this.options.defaultRiskLevel ?? "L2";

      if (riskLevel === "L3") {
        const pendingInfo = {
          taskId,
          targetWorkerId: targetWorker.agent_id,
          project,
          instruction: rest,
          preferredDriver,
          bossQq,
        };
        const apr = await this.options.mailroom.createApproval({
          requested_by: this.options.agentId,
          task_id: taskId,
          risk_level: "L3",
          action_summary: `[${project}${preferredDriver ? `/${preferredDriver}` : ""}] ${rest.slice(0, 200)}`,
          metadata: { pending_dispatch: pendingInfo },
        });
        this.pendingL3Dispatches.set(apr.short_code, pendingInfo);
        await this.onebot.sendPrivateMessage(
          bossQq,
          [
            `待老板审批 L3 短码 ${apr.short_code}`,
            `工单 ${taskId} 目标 ${targetWorker.agent_id} ${targetWorker.online ? "在线" : "离线排队"}`,
            `项目 ${project}${preferredDriver ? ` 工位 ${preferredDriver}` : ""}`,
            `内容 ${rest.slice(0, 300)}`,
            `回复 批准 ${apr.short_code} 放行 或回复 拒绝 ${apr.short_code} 取消`,
          ].join("\n")
        );
        return;
      }

      await this.options.mailroom.sendEnvelope({
        from: { agent_id: this.options.agentId, role: "secretary", tier: "T1" },
        to: { agent_id: targetWorker.agent_id, role: "worker", tier: "T2" },
        type: "task.dispatch",
        security: { risk_level: riskLevel },
        payload: {
          task_id: taskId,
          project,
          title: rest.slice(0, 80),
          instruction: rest,
          preferred_driver: preferredDriver,
          sandbox_profile: riskLevel === "L1" ? "L1_READONLY" : "L2_WORKTREE_DEV",
        },
      });

      const statusNote = targetWorker.online
        ? "桌面工位在线 已下发开始跑"
        : "桌面电脑目前离线 工单已入队 上线后自动跑";
      await this.onebot.sendPrivateMessage(
        bossQq,
        `get 工单 ${taskId} 项目 ${project}${preferredDriver ? ` 工位 ${preferredDriver}` : ""}\n${statusNote}`
      );
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
          "[库米 O1 · 指挥指令速查]",
          "1. 派单 <项目名> [driver:dsh|agy|claude|codex|zcode] <任务描述>",
          "2. 批准 <短码> / 拒绝 <短码> [理由]",
          "3. 当前在线节点：",
          summary || "(暂无)",
        ].join("\n")
      );
    }
  }

  private async handleBossNaturalLanguage(bossQq: string, text: string): Promise<string> {
    const agents = await this.options.mailroom.listAgents();
    const workers = agents.filter((a) => a.tier === "T2");
    const pendingApprovals = await this.options.mailroom.listApprovals("pending");
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
      "工具使用约定：",
      "1 查节点或任务状态时先调工具 拿到真实数据再简洁回复",
      "2 老板明确让桌面干活时调 dispatch_desktop_task 注意 project 必须用白名单准确名称 信息太模糊就先问不猜",
      "3 老板回复授权 批准 同意或拒绝待审批工单时 调 approve_or_reject_pending 工具",
      "4 再次自检 绝对不要输出任何 Markdown 符号（** ### ``` ` - 等） 只发正常纯文本",
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
          description: "向桌面工位派发工程任务（若默认 L3 策略开启，会自动创建待老板确认的短码审批单）。",
          parameters: {
            type: "object",
            properties: {
              project: {
                type: "string",
                description: "白名单中的项目名，例如 coomi / qmmi / harness-deck",
              },
              instruction: { type: "string", description: "清晰具体的任务要求" },
              preferred_driver: { type: "string", description: "可选，指定工程师 CLI：dsh / agy / mock" },
            },
            required: ["project", "instruction"],
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
      dispatch_desktop_task: async (args) => {
        const project = String(args.project ?? "");
        const instruction = String(args.instruction ?? "");
        const preferredDriver = args.preferred_driver ? String(args.preferred_driver) : undefined;
        const latestWorkers = (await this.options.mailroom.listAgents()).filter((a) => a.tier === "T2");
        const targetWorker =
          latestWorkers.find((w) => w.agent_id === this.options.defaultWorkerId) ??
          latestWorkers.find((w) => w.online && w.agent_id.startsWith("dispatcher")) ??
          latestWorkers.find((w) => w.online) ??
          latestWorkers[0];

        if (!targetWorker) {
          return { ok: false, error: "当前没有可用的桌面工程师节点。" };
        }

        const taskId = generateTaskId();
        if (defaultRisk === "L3") {
          const pendingInfo = {
            taskId,
            targetWorkerId: targetWorker.agent_id,
            project,
            instruction,
            preferredDriver,
            bossQq,
          };
          const apr = await this.options.mailroom.createApproval({
            requested_by: this.options.agentId,
            task_id: taskId,
            risk_level: "L3",
            action_summary: `[${project}${preferredDriver ? `/${preferredDriver}` : ""}] ${instruction.slice(0, 200)}`,
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
            instruction_for_boss: `请回复「批准 ${apr.short_code}」放行执行，或回复「拒绝 ${apr.short_code}」取消。`,
          };
        }

        await this.options.mailroom.sendEnvelope({
          from: { agent_id: this.options.agentId, role: "secretary", tier: "T1" },
          to: { agent_id: targetWorker.agent_id, role: "worker", tier: "T2" },
          type: "task.dispatch",
          security: { risk_level: defaultRisk },
          payload: {
            task_id: taskId,
            project,
            title: instruction.slice(0, 80),
            instruction,
            preferred_driver: preferredDriver,
            sandbox_profile: defaultRisk === "L1" ? "L1_READONLY" : "L2_WORKTREE_DEV",
          },
        });
        return { ok: true, status: "DISPATCHED", task_id: taskId, target_worker: targetWorker.agent_id };
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
