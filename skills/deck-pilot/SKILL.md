---
name: deck-pilot
description: Harness-Deck 日常驾驭与运维控制台 Skill。当用户需要查看链路健康状态、一键拉起或配置开机自启、向桌面 CLI 派单/续聊/取消任务、审批 L3 短码、向老板 QQ 推送纯文本简报或文件、排查 trace 故障或增删项目白名单时使用本 Skill。
---

# Harness-Deck Pilot — 日常驾驭与运维控制台

> **定位**：`deck-onboarding` 负责第 0 天从零装机；本 Skill（`deck-pilot`）负责**日常高频驾驭、状态体检、一键守护、任务调度与快速排障**。
> 适用于任意 AI Agent（Antigravity / `agy`、Claude Code、Codex、`dsh`、Cursor、ZCode、Coomi）。

---

## 快速意图路由表

| 用户诉求示例 | 首选动作 |
| :--- | :--- |
| 「看看状态 / 检查在线情况 / 体检一下」 | 运行 `pnpm deck status`（机器可读加 `--json`）；需要全链路验证再跑 `pnpm deck doctor` |
| 「一键启动所有服务 / 拉起守护」 | 运行 `pnpm deck up --profile o1`（如需连本地 Relay 加 `--with-relay`） |
| 「配开机自启 / 卸载自启」 | 先预览 `pnpm deck daemon script --profile o1`，确认后执行 `pnpm deck daemon install --profile o1 --apply` |
| 「派个任务给 agy / dsh」「接着上次任务继续改」 | 通过 QQ 私聊库米 O1（`派单` / `续聊 T-xxxx`）或调用 `deck-comm` MCP `deck_dispatch_task` |
| 「把正在跑的任务停掉」 | 运行 `pnpm deck cancel <T-xxxx> [原因]`，或在 QQ 直接回复 `取消 T-xxxx` |
| 「批准 / 拒绝 L3 审批」 | 运行 `pnpm deck approve <A-xxxx>` 或 `pnpm deck reject <A-xxxx> [理由]`，或在 QQ 回复 `批准 A-xxxx` |
| 「排查刚才为什么失败 / 查日志」 | 运行 `pnpm deck trace <trace_id>`，检查 `.deck/audit/` 与 `git worktree` 状态 |
| 「给老板 QQ 发简报或 PDF/文件」 | 通过 `deck-comm`（`deck_upload_artifact` + `deck_notify_secretary`）或 `deck-qq` MCP 发送，**严禁 Markdown 符号** |
| 「加一个新的白名单目录 / 新 CLI 引擎」 | 编辑 `.deck/workstation.yaml`，改完后用 `pnpm deck status` 复核 |

---

## 1. 1 秒体检与链路诊断

优先使用只读命令，绝不盲目重启：

```bash
# 一次性检查 Mailroom/Relay、NapCat O1/K1、桌面工位、待审 L3 短码、最近 5 条工单
pnpm deck status

# 需要结构化 JSON 供 Agent 解析时
pnpm deck status --json

# 完整端到端自检（协议校验 + RBAC 隔离拦截 + Secret 脱敏 + Mock 派单闭环）
pnpm deck doctor
```

**排障决策树**：
- **`Mailroom: ERROR (Relay unreachable)`**：若为跨端模式（`DECK_ENDPOINT=http://127.0.0.1:...`），先检查本地 SSH 隧道是否存活；若为 VPS 端重启后异常，检查服务器 `systemd` 服务 `harness-deck-relay.service`。
- **`NapCat O1: OFFLINE`**：检查本地或远程 NapCat OneBot v11 WebSocket 进程是否在线、端口与 `.env` 中 `NAPCAT_O1_WS_URL` 是否一致。
- **桌面 CLI 不可用**：运行 `pnpm deck scan`，检查 `.deck/workstation.yaml` 中对应 driver 是否 `enabled: true`；若 `dsh` 无头模式认证失败，核对 `.env` 中 `DECK_DSH_PATCH` 路径是否存在。

---

## 2. 一键守护运行与开机自启

### 前台一键托管（自动拉起 + 指数退避重启）
```bash
# 启动 dispatch + qq-bridge(o1)；若 .env 配置了 DECK_SSH_TUNNEL_ARGS 还会一并守护 SSH 隧道
pnpm deck up --profile o1

# 常用组合开关
pnpm deck up --profile o1 --with-relay        # 同时拉起本地 deck-relay
pnpm deck up --profile o1 --no-qq             # 仅拉起桌面工长（+隧道）
pnpm deck up --profile k1 --no-dispatch       # 仅拉起 T3 公域前线库米 K1
```
运行时会在 `.deck/runtime-status.json` 持续写入子进程 PID 与重启计数，`pnpm deck status` 会自动读取该状态。

### 开机自启（先预览，经用户确认后再 `--apply`）
```bash
# 1. 生成脚本/systemd unit 并打印注册命令（不改动系统配置）
pnpm deck daemon script --profile o1

# 2. 经用户确认后正式注册（Windows 计划任务 / Linux systemd --user）
pnpm deck daemon install --profile o1 --apply

# 3. 卸载自启
pnpm deck daemon uninstall --profile o1 --apply
```

---

## 3. 任务派发、带附件派单、会话续聊与强杀中断

### 老板 QQ 侧（与库米 O1 对话）
- **自然语言派单**：直接说需求（如“让 `agy` 看下 `UltraCausal` 的最新实验日志”），O1 会调工具校验白名单并在 L3 策略下发短码 `A-xxxx`。
- **发文件给桌面 CLI**：直接把 PDF / 报错截图 / 日志文件发给库米 O1，O1 会自动上传到 Mailroom 暂存（15 分钟有效），接着发一句任务说明即自动附带并落盘到桌面工长的 `_inputs/<task_id>/` 目录，CLI 工程师可直接读取。
- **快捷指令**：
  - `派单 <项目名> [driver:dsh|agy|claude|codex|zcode] <任务描述>`
  - `续聊 <T-xxxx> <继续修改要求>`（自动继承原项目、分支与 `session_id`）
  - `取消 <T-xxxx> [原因]`（向桌面工长发送 `task.cancel` 强杀子进程树并上报 `cancelled`）
  - `批准 <A-xxxx>` / `拒绝 <A-xxxx> [理由]`
- **长任务心跳**：运行超过 `DECK_DISPATCH_HEARTBEAT_SEC`（默认 75 秒）的任务会定期回报一句运行进展与中止提示，避免长时间无声。

### 本地终端侧（CLI 兜底控制）
```bash
# 批准 / 拒绝 L3 短码
pnpm deck approve A-1042
pnpm deck reject A-1042 "先不动主分支"

# 强杀运行中的桌面工单
pnpm deck cancel T-123456 "需求变更，停止执行"

# 按 trace_id 查看全链路审计记录
pnpm deck trace <trace_id>
```

---

## 4. 安全管理项目白名单（`.deck/workstation.yaml`）

当用户要求“新增一个允许远程调度的目录”时：
1. 先确认该目录真实存在，并询问用户希望的隔离策略：
   - 代码仓库优先使用 `git_isolation: worktree`（强制保护主工作区）
   - 非 Git 临时资料目录可使用 `git_isolation: none`
2. 仅编辑 gitignored 的 `.deck/workstation.yaml`，在 `workspaces:` 下新增对应条目。
3. 运行 `pnpm deck status` 确认新项目已出现在 `projects=[...]` 列表；若 `deck dispatch` 正在运行，提醒用户重启 `dispatch`（或 `deck up`）生效。

---

## 5. 向老板 QQ 发送纯文本简报 / 文件铁律

1. **禁止任何 Markdown 语法**：QQ 无法渲染 `**`、`###`、```` ``` ````、`` ` ``、`- `，必须使用正常纯文本分段（底层 `formatPlainTextForQq()` 也会做兜底清洗）。
2. **文件交付优先走工件中转**：先通过 `deck-comm` 上传 PDF/压缩包/日志（自动计算 SHA256），再由 O1 转发为 QQ 私聊文件。
3. **绝对保密红线**：严禁把 `.env`、API Key、Token、私钥、VPS IP、个人 QQ 号输出到公开文档、提交记录或非授权聊天中；严禁打破 `T0 > T1 > T2 > T3` 信任边界（`T2 ↮ T3`、`T3 ↛ T0`）。
