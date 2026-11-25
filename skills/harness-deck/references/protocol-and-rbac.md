# Harness-Deck — HDP v1 协议、RBAC 与安全模型速查

> 本文档为 `harness-deck` 认知 Skill 的按需参考资料，汇总 `protocol/` 与 `packages/mailroom/` 的核心不变量。

## 1. 信任等级与角色映射（`protocol/src/tiers.ts`）

| Tier | 数值序 | 角色 (`AgentRole`) | 典型实例 | 权限范围 |
| :--- | :---: | :--- | :--- | :--- |
| `T0` | 0（最高） | `boss` | 老板 QQ 私聊 / 真实使用中的 Agent | 最高目标下达、`L3` 审批决定（`approval.decision`）、退回返工 |
| `T1` | 1 | `secretary` | 库米 O1 (`kumi-o1`) | 承上启下：向 `T0` 申请审批与汇报，向 `T2` 派单/取消，向 `T3` 下发指令，审查 `T3` 不可信摘要 |
| `T2` | 2 | `worker` | 桌面工长 (`dispatcher-*`) & CLI 工程师 | 接收 `T0/T1` 派单与取消，在白名单目录/Worktree 执行，向 `T1` 上报进度、请示、结果与工件 |
| `T3` | 3（最低） | `frontline` | 库米 K1 (`kumi-k1`) | 只读检索 `deck-kb`，结构化记录社区反馈并向 `T1` 上报（强制 `untrusted_origin: true`），执行 `T1` 下发指令 |

## 2. 12 种 HDP v1 信封路由矩阵（`ROUTING_MATRIX`）

| 信封类型 (`EnvelopeType`) | 允许发送方 | 允许接收方 | 特殊安全约束 |
| :--- | :--- | :--- | :--- |
| `report.digest` | `T3`, `T2` | `T1` | `T3` 发出时强制 `untrusted_origin: true` + `wrapUntrustedDigest()` |
| `qa.escalation` | `T3` | `T1` | `T3` 发出时强制 `untrusted_origin: true` |
| `directive` | `T0`, `T1` | `T3` | 向下指挥公域前线（回访、公告、答疑补充） |
| `task.dispatch` | `T0`, `T1` | `T2` | **`L3` 风险必须携带已批准的 `approval_ref`**；可附 `attachments` 与 `resume_session_id` / `existing_branch` |
| `task.progress` | `T2` | `T1` | 阶段进展与长任务定期心跳（`heartbeat: true`, `elapsed_sec`） |
| `task.question` | `T2` | `T1` | 工程师卡住时向 `T1` 请示 |
| `task.answer` | `T0`, `T1` | `T2` | 回答工程师请示 |
| `task.result` | `T2` | `T1` | 最终交付摘要、`diff_stat`、`branch`、`session_id`、附件工件 |
| `task.cancel` | `T0`, `T1` | `T2` | 实时中止运行中的桌面任务（强杀进程树并上报 `status: "cancelled"`） |
| `notify.secretary` | `T2` | `T1` | 桌面端主动汇报（附可选 `attachments`，可转交老板 QQ） |
| `approval.request` | `T1` | `T0` | 发起短码审批请求（如 `A-1042`） |
| `approval.decision` | `T0` | `T1` | 老板批准或拒绝审批 |

## 3. 内置安全护栏

1. **硬拦截规则（`validateRouting`）**：
   - `hop_count > max_hops`（默认 6）→ `LOOP_BREAKER` 拒绝，防止多 Agent 死循环。
   - `T2 ↮ T3` → `RBAC_ISOLATION_DENIED`。
   - `T3 → T0` → `RBAC_SKIP_LEVEL_DENIED`。
   - `L3 task.dispatch` 无 `approval_ref` → `APPROVAL_REQUIRED`。
2. **三档沙箱（`SandboxProfile`）**：
   - `L1_READONLY`：只读分析/排查。
   - `L2_WORKTREE_DEV`：强制 `git worktree` 独立分支开发，保护主工作区。
   - `L3_APPROVED_EXEC`：经 `T0` 短码审批放行的高权限执行。
3. **密钥脱敏（`scrubSecrets`）**：自动抹除 OpenAI / GitHub / Bearer Token、私钥块等敏感片段，应用于信封、日志与 QQ 出口。
4. **Mailroom SQLite 持久化（`node:sqlite`，零 C++ 依赖）**：
   - 核心表：Registered Agents、Envelopes（含幂等键与签收状态）、Tasks（含 `result_json` 留存 `session_id`/`branch`）、Approvals（含 `metadata_json` 持久化 `pending_dispatch` 及附件，重启不丢且 `listApprovals` 自动清扫过期项）、Artifacts（SHA256 校验 + TTL）、KB Docs、Feedback Ledger、JSONL `trace_id` 审计日志。
