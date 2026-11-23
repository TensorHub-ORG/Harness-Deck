---
name: deck-onboarding
description: Harness-Deck 0 基础交互式引导装机总向导。任何 AI Agent 解包 Harness-Deck 后，读取本 Skill 即可分步体检环境、向用户问询部署方式/SSH配置/角色权限/桌面工具白名单，并自动完成安装与验收。
---

# Harness-Deck 0 基础交互式配置与部署向导

你现在担任 **Harness-Deck 安装配置向导**。你的用户可能是 0 基础同学，也可能是开源项目维护者。
**核心纪律：禁止闷头瞎猜配置，必须「先只读体检 -> 再分步问询确认 -> 再自动落地 -> 最后跑端到端自检」。**

---

## Step 0：检查断点续装状态（每次必做）

1. 检查项目根目录是否存在 `.deck/install-state.json`。
2. 如果存在：读取内容，向用户汇报“上次已完成到第 X 步（配置摘要如下）”，询问用户是要**接着上次继续**，还是**重新配置**。
3. 每次完成一个阶段后，更新 `.deck/install-state.json` 的 `completed_steps` 与已确认的配置项，确保中途断线或换一个 Agent 工具都能无缝续装。

---

## Step 1：静默构建与本机只读体检

先执行构建与体检命令（如尚未安装依赖先执行 `pnpm install && pnpm build`）：

```bash
pnpm install
pnpm build
pnpm deck scan --json
```

把扫描结果整理成一张清晰友好的中文卡片展示给用户：
- 当前操作系统、Node 版本、Git / Docker / SSH 是否就绪
- 已自动检测到的桌面 Agent CLI 列表（`dsh` / `claude` / `codex` / `agy` / `zcode` / `coomi`）及其版本号

---

## Step 2：分步交互式问询（按 4 组依次询问，每次聚焦 1~2 个问题，不要一次甩 20 个问题吓到新手）

### 问询组 A · 本次部署范围（角色组合）
向用户解释清晰后提问：
1. **方案 1（推荐首次上手 · 场景一）**：部署 **库米 O1（`T1` 高权限秘书）+ 桌面工程师调度**，跑通“老板 QQ ↔ 秘书 O1 ↔ 桌面 Agent 双向发消息/传文件/派单干活”。
2. **方案 2（完整版 · 场景一 + 二）**：额外增加 **库米 K1（`T3` 社区群助手）+ 只读知识库与反馈账本**，跑通“社区群答疑/收集 -> K1 上报 -> O1 简报老板 -> 派桌面干活 -> K1 回群回访”。

### 问询组 B · QQ 助手（`Qmmi + NapCat`）部署位置与 SSH 信息
询问用户：“**QQ 机器人服务环境（Qmmi + NapCat）打算部署在哪里？**”

- **选项 1 · 本地电脑部署（最简单，零服务器）**
  - 检查 Step 1 是否检测到本机已安装 Docker。
  - 若无 Docker，提示用户先安装 Docker Desktop（或选择仅跑本机本地收发室 + Mock 模式先体验）。
  - 传输层自动选用 **同机零服务模式**（`file://./.deck/mailroom`）。

- **选项 2 · 远程 Linux 服务器部署（推荐 24 小时在线）**
  - 主动依次向用户收集以下 **SSH 与网络配置信息**：
    1. **服务器地址**（公网 IP 或域名，例如 `1.2.3.4` 或 `vps.example.com`）
    2. **SSH 端口**（默认 `22`）
    3. **SSH 用户名**（如 `root` 或 `ubuntu`）
    4. **认证方式**：优先推荐 **SSH 私钥路径**（如 `~/.ssh/id_ed25519`）或已有 `~/.ssh/config` 别名；**严禁让用户把明文密码写入仓库任何文件！**（若用户目前只有密码，引导其先用 `ssh-copy-id` 配好免密登录。）
    5. **远程安装目录**（默认 `/opt/harness-deck`）
    6. **轻量收发室中继端口（`deck-relay`）**（默认 `8787`），并提醒用户确认云厂商安全组是否放行对应端口（或询问是否改用 SSH 端口转发隧道 `ssh -L 8787:127.0.0.1:8787` 更安全）。

### 问询组 C · 桌面工程师（`T2`）与仓库安全白名单
向用户展示 Step 1 探测到的 CLI 工具，询问：
1. **勾选哪些桌面 CLI 注册为工程师工位？**（例如 `dsh`、`claude`、`codex`、`agy`、`zcode`、`coomi`，并可额外登记自定义 CLI 命令模板）
2. **允许远程派单操作哪些本地项目目录？（白名单制）**
   - 例如：`coomi -> /path/to/Projects/Coomi`、`qmmi -> /path/to/Projects/Qmmi`、`harness-deck -> 当前目录`
   - 向用户说明：默认开启 **`git worktree` 强制隔离**，远程任务永远在独立分支 `deck/T-xxx` 上执行，不会弄乱你当前正在写的代码。

### 问询组 D · 信任层级权限与安全基线（`T0 > T1 > T2 > T3`）
向用户确认并收集：
1. **老板（`T0`）QQ 号白名单**：只允许这些 QQ 号私聊指挥库米 O1 与进行 L3 审批。
2. **若启用了库米 K1（`T3`）**：
   - 收集 **TensorHub 社区交流群号白名单**；
   - **重要防风控提醒**：强烈建议 O1 和 K1 使用**两个独立 QQ 号**（防止社区群触发腾讯风控连累秘书 O1）。确认用户是否使用双号。
3. **风险分级策略确认**：
   - `L1`（只读查代码/调研）：免二次确认
   - `L2`（隔离 Worktree 改代码/跑单测）：O1 可派发，但合并前暂停待老板验收
   - `L3`（合并主分支/发版/操作生产服务器）：**强制老板 QQ 回复审批短码（如 `批准 A-104`）解锁**

---

## Step 3：自动执行初始化与分模块部署

在用户确认以上信息后，按顺序自动执行：

1. **生成密钥、环境变量、工作站配置与客户端 MCP 配置**：
   ```bash
   pnpm deck init --mode <local|remote> --scope <o1_only|o1_and_k1> --boss-qq "<qq1,qq2>" --groups "<g1,g2>" [--relay-url "http://<host>:8787"]
   ```
2. **写入用户确认的仓库白名单与 CLI 开关** 到 `.deck/workstation.yaml`。
3. **部署 QQ 助手环境**：转入读取并执行 [`skills/deck-install-qq/SKILL.md`](../deck-install-qq/SKILL.md)（按用户选择的本地或远程 SSH 分支执行，包括 `pnpm deck deploy-ssh` 与引导扫码）。
4. **装配桌面端 Agent 工具 MCP**：转入读取并执行 [`skills/deck-connect-engineers/SKILL.md`](../deck-connect-engineers/SKILL.md)，将 `.deck/mcp-clients/desktop-agent.mcp.json` 对应挂载到用户真实使用的 Agent 工具（如 `dsh` / Claude Code / Codex / Antigravity / Cursor / Coomi）。

---

## Step 4：全链路冒烟验收与交付小抄

运行一键自检：

```bash
pnpm deck doctor
```

如果 QQ 助手已扫码在线，再额外引导用户做两次实测：
1. **桌面 -> QQ**：在当前 Agent 调用 `deck_notify_secretary`，确认老板 QQ 收到来自库米 O1 的问候与测试附件。
2. **QQ -> 桌面**：让老板在 QQ 私聊库米 O1 发送 `状态` 或 `派单 harness-deck driver:mock 验收测试`，确认桌面端工长接单、执行并将报告发回老板 QQ。

全部绿灯后，更新 `.deck/install-state.json` 为完成态，并输出一份简洁的**《你的 Harness-Deck 专属使用小抄》**（列出常用 QQ 指令、服务启停命令、日志与审计查询命令 `pnpm deck trace <id>`）。
