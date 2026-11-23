# Harness-Deck Protocol（HDP v1）正式规范

> 单一真相源（Single Source of Truth）实现位于 [`protocol/src/`](../protocol/src/)。所有 MCP、收发室、工长、QQ 桥接与第三方扩展包必须严格遵守本协议。

---

## 1. 信任层级与身份模型（Trust Tiers）

数字越小，信任度越高、离公域不可信输入越远：

| 层级 | 枚举值 | 角色 (`role`) | 说明 |
| :--- | :--- | :--- | :--- |
| **`T0`** | `T0` | `boss` | 人类核心维护者（QQ 私聊 / 真实使用中的 Agent），拥有最终决策权与 L3 审批权 |
| **`T1`** | `T1` | `secretary` | 秘书主管（如 `kumi-o1`），对上汇报 `T0`，对下统筹 `T2` 与 `T3` |
| **`T2`** | `T2` | `worker` | 内网执行者（桌面 CLI 工程师、自动化管线），受白名单约束在隔离工作区执行 |
| **`T3`** | `T3` | `frontline` | 公域前线（如 `kumi-k1`），驻守社区群，面向外部不可信输入，权限最低 |

### 核心隔离不变量（Invariants）
1. **`T3` 禁止直接联系 `T0` 或 `T2`**（无法私聊老板、无法派发任务）。
2. **`T2` 与 `T3` 水平硬隔离**：内网执行者与公域前线绝不可直接通信，必须经由 `T1` 审查中转。
3. **所有源自 `T3` 的信封**，在收发室写入时强制覆写 `security.untrusted_origin = true`，不允许发件人自欺篡改。

---

## 2. 硬权限路由矩阵（Hard RBAC Matrix）

收发室在 `sendEnvelope()` 阶段强制拦截不符合下列规则的投递：

| `type` | 允许发送方 (`tier` / `role`) | 允许接收方 (`tier` / `role`) | 附加硬规则 |
| :--- | :--- | :--- | :--- |
| `report.digest` | `T3 (frontline)`, `T2 (worker)` | `T1 (secretary)` | 必须匹配 `CommunityDigestPayloadSchema`；`T3` 强制 `untrusted_origin=true` |
| `qa.escalation` | `T3 (frontline)` | `T1 (secretary)` | 仅限向直属上级求助 |
| `directive` | `T1 (secretary)`, `T0 (boss)` | `T3 (frontline)` | 上级下发收集重点、标准答案或发版回访指令 |
| `task.dispatch` | `T1 (secretary)`, `T0 (boss)` | `T2 (worker)` | 若 `risk_level === "L3"`，**必须携带由 `T0` 批准的有效 `approval_ref`** |
| `task.progress` | `T2 (worker)` | `T1 (secretary)` | 心跳与阶段进度，不触发 LLM 死循环回复 |
| `task.question` | `T2 (worker)` | `T1 (secretary)` | 工程师遇阻挂起（`WAITING_INPUT`）请示 |
| `task.answer` | `T1 (secretary)`, `T0 (boss)` | `T2 (worker)` | 回复工程师请示，唤醒工位继续执行 |
| `task.result` | `T2 (worker)` | `T1 (secretary)` | 交付包：状态、摘要、分支、Diff 统计、工件列表 |
| `task.cancel` | `T1 (secretary)`, `T0 (boss)` | `T2 (worker)` | 中止正在运行的工位进程树 |
| `notify.secretary` | `T2 (worker)` | `T1 (secretary)` | 桌面 Agent 主动向秘书发消息或传文件 |
| `approval.request` | `T1 (secretary)` | `T0 (boss)` | 为 L3 高危任务生成短码审批卡片（如 `T-104`） |
| `approval.decision` | `T0 (boss)` | `T1 (secretary)` | 老板批准或拒绝审批短码 |

---

## 3. 任务风险分级与沙箱策略（L1 / L2 / L3）

| 风险级别 | 沙箱档位 | 审批要求 | 典型操作 |
| :--- | :--- | :--- | :--- |
| **`L1`** | `L1_READONLY` | 免二次审批 | 查日志、分析 PR Diff、只读调研、跑只读测试 |
| **`L2`** | `L2_WORKTREE_DEV` | `T1` 可直接派单；合并主分支前暂停 | 在独立 `git worktree` 和 `deck/T-xxx` 分支修复 Bug、写测试、生成草稿报告 |
| **`L3`** | `L3_APPROVED_EXEC` | **强制 `T0` 审批令牌 (`approval_ref`)** | 合并主分支、生产构建发版、操作生产服务器、对外群发正式公告 |

---

## 4. 防御机制协议约定

1. **幂等与防过期**：支持 `idempotency_key`（相同键重复投递直接返回既有信封）与 `expires_at`（超时工单不会被离线重连的机器误执行）。
2. **防死循环熔断**：每条信封必须携带 `hop_count` 与 `max_hops`（默认 `6`），超过 `max_hops` 直接拒绝投递并记录审计告警；纯确认型回执（ACK）严禁再触发 LLM 自动回复。
3. **出口密钥脱敏（Secret Scrubber）**：收发室与桌面工长在所有外发文本/日志摘要上自动运行敏感模式正则脱敏（API Keys、Bearer Tokens、GitHub PAT、SSH 私钥、数据库连接串等均替换为 `[REDACTED]`）。
4. **全链路审计（Audit Trail）**：所有跨角色信封携带全局 `trace_id`，同步以 JSONL 格式落盘至 `.deck/audit/<trace_id>.jsonl`，随时可用 `deck trace <trace_id>` 还原全过程。
5. **工件中转（Artifact Relay）**：文件跨端不暴露绝对路径，统一登记为 `ArtifactRef`（`artifact_id` + `sha256` + `size_bytes` + `expires_at`），经由同机目录或 `deck-relay` 安全中转并定期按 TTL 清理。
