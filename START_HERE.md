# START HERE — Harness-Deck 任意 Agent 通用引导入口

> **致正在阅读本文件的 AI Agent**：
> 你现在拿到的是 **Harness-Deck** 整合包（包含 HDP v1 协作协议、多个模块化 MCP、多个模块化 Skill、本地/远程部署代码与自检工具）。
> 无论你是 **`dsh`、Claude Code、Codex、Antigravity (`agy`)、ZCode、Coomi、Cursor** 还是其他任意 Agent，**请严格按照下面的步骤与用户交互，带用户从 0 完成部署和联调**。

---

## 第一铁律：禁止跳步瞎猜，必须先体检再分步问询

1. **不要直接修改系统文件或盲目启动 Docker**——先检查断点状态文件 `.deck/install-state.json`（若存在则询问用户是否断点续装）。
2. **立即阅读完整向导 Skill**：[`skills/deck-onboarding/SKILL.md`](skills/deck-onboarding/SKILL.md)。
3. **先做只读体检，再向用户提问**：把你扫描到的本机环境（OS、Node、Git、Docker、SSH、已安装的 `dsh`/`claude`/`codex`/`agy`/`zcode`/`coomi`）展示给用户，再依次询问：
   - 本次部署范围（仅 **库米 O1 + 桌面工程师**，还是 **O1 + 库米 K1 社区群 + 知识库**）
   - QQ 助手（`Qmmi + NapCat`）部署位置：**本地电脑** 还是 **远程 Linux 服务器（SSH）**
   - 若选远程服务器：询问 **SSH 主机、端口、用户名、私钥路径（或 SSH Config 别名）、远程安装目录、Relay 连接方式**（绝不把明文密码写入仓库）
   - 桌面工程师工位与仓库白名单（勾选要纳管的本地 CLI 工具 + 允许操作的项目目录）
   - 安全与权限基线（老板 `T0` QQ 号、社区群号、是否严格启用 `L3` 高危操作 QQ 短码二次审批）

---

## 整合包资产地图

| 目录 / 文件 | 用途 | 适用阶段 |
| :--- | :--- | :--- |
| [`skills/deck-onboarding/SKILL.md`](skills/deck-onboarding/SKILL.md) | **0 基础交互式总装机向导**（必读） | Day-0 初始化 |
| [`skills/deck-pilot/SKILL.md`](skills/deck-pilot/SKILL.md) | **日常驾驭与运维控制台**（状态体检、一键守护、派单/续聊/取消、审批排障） | 日常高频使用 |
| [`skills/deck-install-qq/SKILL.md`](skills/deck-install-qq/SKILL.md) | `Qmmi + NapCat` 本地 / 远程 SSH 双分支部署剧本 | 场景一 / 二 |
| [`skills/deck-connect-engineers/SKILL.md`](skills/deck-connect-engineers/SKILL.md) | 桌面 CLI 工程师扫描、Worktree 隔离与 MCP 自动装配 | 场景一 |
| [`skills/deck-role-o1/SKILL.md`](skills/deck-role-o1/SKILL.md) | **库米 O1（`T1` 秘书主管）** 行为规范与调度手册 | 运行态 O1 |
| [`skills/deck-role-k1/SKILL.md`](skills/deck-role-k1/SKILL.md) | **库米 K1（`T3` 公域前线）** 群答疑、防注入与上报手册 | 运行态 K1 |
| [`skills/deck-role-engineer/SKILL.md`](skills/deck-role-engineer/SKILL.md) | **桌面工程师（`T2` Worker）** 进度汇报、请示与交差手册 | 运行态桌面端 |
| [`protocol/`](protocol/) | HDP v1 协议 Schema、信任层级（`T0>T1>T2>T3`）与安全脱敏 | 核心协议 |
| [`packages/mailroom/`](packages/mailroom/) | 极简收发室（本地 SQLite 零服务 + 跨端 `deck-relay`） | 核心通信 |
| [`packages/dispatcher/`](packages/dispatcher/) | 桌面工长（统一驱动 `dsh`/`claude`/`codex`/`agy`/`zcode` + Git Worktree） | 桌面调度 |
| [`packages/cli/`](packages/cli/) | `deck` 命令行（`scan` / `init` / `relay` / `dispatch` / `qq-bridge` / `deploy-ssh` / `doctor` / `trace` / `mock`） | 全阶段工具 |
| [`mcps/`](mcps/) | 4 个独立 MCP Server：`deck-comm`、`deck-dispatch`、`deck-qq`、`deck-kb` | 按需挂载 |
| [`deploy/`](deploy/) | 本地 Docker Compose、远程 VPS 一键部署脚本、NapCat 与客户端预设模板 | 实际部署 |
| [`adapters/dsh-plugin/`](adapters/dsh-plugin/) | DeepSeek Harness（`dsh` / Cordis）首个原生深度适配插件参考 | 可选增强 |
| [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) | 完整系统架构蓝图 | 架构参考 |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | HDP v1 正式协议细则与安全模型 | 协议参考 |

---

## 快速前置命令（Agent 首次运行）

```bash
# 1. 安装依赖并构建整套整合包（需要 Node.js >= 22.5 与 pnpm）
pnpm install
pnpm build

# 2. 体检本机环境（只读，输出 JSON 报告供你展示给用户）
pnpm deck scan --json

# 3. 验证核心协议与安全测试
pnpm test
```

完成构建和体检后，立刻遵循 [`skills/deck-onboarding/SKILL.md`](skills/deck-onboarding/SKILL.md) 开始与用户交互式配置！
