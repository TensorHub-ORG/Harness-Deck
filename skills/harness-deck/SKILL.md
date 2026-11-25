---
name: harness-deck
description: >-
  Harness-Deck 体系核心认知 Skill（连接并驾驭 / Connect and harness）。
  当任意 AI Agent 需要理解 Harness-Deck 的整体架构、HDP v1 协作协议、T0>T1>T2>T3 四级信任与隔离模型、
  库米 O1/K1 与桌面多 CLI（dsh/agy/claude/codex/zcode/coomi）的协同机制、双模收发室（本地 SQLite / 跨端 deck-relay）
  或在跨项目/新会话中快速建立 Harness-Deck 工程心智模型时激活本 Skill。
---

# Harness-Deck — 全体系认知模型（Cognitive Skill）

> **Harness-Deck — 连接并驾驭。 / Connect and harness.**
>
> 本 Skill 让任意 AI Agent（Antigravity / `agy`、Claude Code、Codex、`dsh`、Cursor、ZCode、Coomi）在数秒内建立对 **Harness-Deck** 体系的完整世界观、角色边界与协作心智模型。

---

## 1. 一句话本质与四大第一性原理

Harness-Deck 是一个 **以人为核心驾驭主体（Human-in-the-Loop）的多 Agent 分层协作开放协议（HDP v1）** 与 **工具中立的 Skill + MCP + CLI 整合包**，最初面向 TensorHub-ORG（`Coomi`、`Qmmi`、`Latexsnipper`、`Storydex` 等）开源项目自动化维护与个人多 CLI 调度设计，但对任何项目和任意 Agent 工具通用。

理解整套体系只需抓住 **4 条第一性原理**：

1. **人在回路，绝不失控（Human-in-the-Loop）**：人类（`T0`）永远掌握最高目标下达、高危操作 `L3` 短码二次审批与最终验收权，Agent 舰队只执行授权范围内的任务。
2. **信任分级，硬边界隔离（Monotonic Trust Tiers）**：公域输入默认不可信，用协议层硬路由 + 角色动态裁剪 MCP 工具把公域前线与内网执行彻底物理/逻辑隔断。
3. **极简可插拔传输，零重型中台**：不需要 Kafka / Redis / K8s；单机用本地 `node:sqlite` 零服务模式，跨机用 ~23MB 轻量 `deck-relay`（支持 SSH 加密隧道或出站 WS，桌面端免公网 IP）。
4. **核心彻底工具中立（Tool-Neutral Core）**：协议、收发室、桌面工长、MCP 与 Skill 不绑定任何单一厂商或 CLI；某工具的原生深度插件只能放在 `adapters/`（如 `adapters/dsh-plugin/`）。

---

## 2. 四级信任层级与不可逾越的红线

```text
T0 老板 / 核心维护者（QQ 私聊 / 真实使用中的 Agent）     ← 最高决策 & L3 审批权
        ↕  私聊 / 发文件 / 短码审批（批准 A-xxxx）
T1 秘书主管（库米 O1 · Coomi O1）                        ← 承上启下 · 防注入审查隔离阀
     ↙                                   ↘
T2 内网执行层（桌面工长 + 多 CLI）   ✕ 严禁直连 ✕   T3 公域前线（库米 K1 · Coomi K1）
   dsh / agy / claude / codex / ...                  只读 KB 答疑 · 结构化采集社区反馈
```

### 3 条硬路由铁律（协议层 + Mailroom + MCP 三重强制）
1. **`T2 ↮ T3` 严禁直连**：公域社区群（不可信输入）可能包含 Prompt Injection，因此 `T3` 绝不能直接触达内网桌面 `T2`，所有情报必须经 `T1` 隔离审查与转译。
2. **`T3 ↛ T0` 严禁越级**：公域前线 `T3` 绝不能直接私聊打扰老板 `T0`，只能查只读知识库（`deck-kb` 只读视图）并向 `T1` 提交结构化简报/升级单（自动打标 `untrusted_origin: true` + `wrapUntrustedDigest()` 数据围栏）。
3. **`L3` 必须持有 `T0` 审批凭据**：任何 `L3` 高危派单必须带有效的 `approval_ref`（老板通过 QQ 短码 `A-xxxx` 或 `deck approve` 批准，审批上下文持久化在 SQLite `approvals.metadata_json` 防重启丢失）。

---

## 3. 四层系统架构与双模流转

| 层级 | 核心组件 | 职责 |
| :--- | :--- | :--- |
| **L1 人类与公域入口** | 老板 (`T0`) / TensorHub 社区群 | 下达目标、发送待分析文件、L3 审批；社区用户日常提问与 Bug 反馈 |
| **L2 QQ 边缘交互层** | `mcps/deck-qq` (`NapCat / OneBot v11`) | 推荐双号隔离防风控：O1 (`T1`) 仅收白名单老板私聊与文件、纯文本回复（严禁 Markdown）；K1 (`T3`) 仅守白名单社区群 |
| **L3 极简收发室层** | `protocol` (`HDP v1`) + `packages/mailroom` | 协议校验、RBAC 硬路由、L3 持久化审批、SHA256 双向工件中转、密钥脱敏、`max_hops` 防死循环、`trace_id` 审计；支持 **Mode A (`file://` 本地 SQLite)** 与 **Mode B (`http(s)://` 跨端 `deck-relay`)** |
| **L4 内网执行层 (`T2`)** | `mcps/*` + `packages/dispatcher` + 各类 CLI | 强制项目目录白名单（`.deck/workstation.yaml`）与 `git worktree` 隔离；统一纳管 `dsh` / `agy` / `claude` / `codex` / `zcode` / `coomi` / `custom-cli`；支持附件自动落盘 `_inputs/<task_id>/`、长任务心跳、`task.cancel` 强杀与 `session_id` 续聊 |

---

## 4. Agent 自我定位协议（进入会话先确认「我是谁」）

无论你在哪个项目或工具中激活本 Skill，先判断当前所处角色并遵循对应边界：

- **场景 A：你是老板正在对话的日常 Agent（`T0` 代理 / 协同助手）**
  - 需要排查、启停、审批、取消任务或改白名单 → 遵循仓库内 `skills/deck-pilot/SKILL.md`（日常驾驭控制台）。
  - 需要从 0 帮用户安装部署到新电脑/VPS → 遵循 `START_HERE.md` 与 `skills/deck-onboarding/SKILL.md`。
- **场景 B：你是正在维护/开发 Harness-Deck 仓库本身的工程师**
  - 先读仓库 `AGENTS.md` 与 `docs/A2A_HANDOFF.md`，改完代码必须跑通 `pnpm build`、`pnpm test`、`pnpm smoke:mcp`、`pnpm deck doctor`。
- **场景 C：你是被 `Deck Dispatcher` 调起执行工单的桌面 CLI（`T2` Worker）**
  - 严格限定在当前白名单项目/worktree 与 `DECK_INPUT_DIR` 附件目录内作业，输出事实精炼、绝不泄露密钥；详见 `skills/deck-role-engineer/SKILL.md`。
- **场景 D：你是运行在 QQ 边缘的秘书 O1（`T1`）或社区前线 K1（`T3`）**
  - O1 坚持纯文本无 Markdown、先结论后证据；K1 严守只读 KB 与结构化上报；详见 `skills/deck-role-o1/SKILL.md` 与 `skills/deck-role-k1/SKILL.md`。

---

## 5. 按需深入阅读（Progressive Disclosure）

仅在需要具体协议字段、MCP 清单、CLI 参数或避坑细节时再读取下列参考手册：

- **协议细则、12 种信封、RBAC 路由表与安全模型**：[references/protocol-and-rbac.md](./references/protocol-and-rbac.md)
- **双模运行态、4 套 MCP、8 种 CLI 驱动参数、`deck` 命令与实测踩坑清单**：[references/runtime-and-drivers.md](./references/runtime-and-drivers.md)

---

## 6. 跨会话不可违背的 5 条铁律

1. **绝不破坏信任隔离**：禁止任何绕过 `T2 ↮ T3`、`T3 ↛ T0` 或 `L3` 审批的代码与配置。
2. **绝不泄露或提交敏感信息**：`.env`、`.deck/`、`*.sqlite*`、API Key、Token、SSH 私钥、VPS IP、个人 QQ 号绝不入库，也不要无必要地回显在公开文档中；测试中的伪造密钥必须动态拼接避免误触 GitHub Secret Scanning。
3. **QQ 出口强制纯文本**：QQ 无法渲染 Markdown，所有发往 QQ 的内容必须无 `**`、`###`、```` ``` ````、`` ` `` 等符号（底层经 `formatPlainTextForQq()` 清洗）。
4. **核心保持工具中立**：任何工具专属插件只放 `adapters/`，核心协议与包不写死单一 Agent 厂商。
5. **变更必验收**：修改 Harness-Deck 源码后，必须完整通过 `pnpm build` + `pnpm test` + `pnpm smoke:mcp` + `pnpm deck doctor`。
