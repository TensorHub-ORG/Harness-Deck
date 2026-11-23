---
name: deck-connect-engineers
description: 扫描并接入本机多款桌面 Agent CLI（dsh / claude / codex / agy / zcode / coomi / custom），配置仓库白名单、Git Worktree 隔离以及各工具的 MCP 挂载文件。
---

# 桌面工程师集群（`T2`）接入与配置剧本

本 Skill 负责把用户电脑上的任意桌面 Agent 工具注册成 Harness-Deck 的 **T2 工程师工位**，实现：
1. 秘书 O1 可以通过 `Deck Dispatcher` 远程派单唤醒任意一款已安装 CLI（`dsh`、`claude`、`codex`、`agy`、`zcode`、`coomi` 等）在独立 `git worktree` 里安全干活；
2. 用户自己在桌面打开任意交互式 Agent 干完活后，可以直接调用 `deck-comm` MCP 把总结和文件发给库米 O1。

---

## Step 1：探测本机工具与项目目录

运行探测并展示给用户：
```bash
pnpm deck scan
```

询问用户确认：
1. 要启用哪些已检测到的 CLI 工程师？各自标注擅长标签（例如 `claude` 擅长复杂架构/Rust、`codex` 擅长快速补丁/单测、`dsh` 擅长插件/日常开发、`agy` 擅长全栈调研、`zcode` 擅长前端快修）。
2. 如果有未在内置列表中的 CLI 工具，可选择 `driver: custom-cli` 并提供 `command_template`（支持 `{{prompt}}`、`{{cwd}}`、`{{task_id}}` 占位符）。
3. 确认允许被远程操作的**本地项目仓库白名单**（绝对路径），未列入白名单的目录工长会硬拒绝访问。

---

## Step 2：写入 `.deck/workstation.yaml`

按用户确认更新 `.deck/workstation.yaml`（严格遵守 `WorkstationConfigSchema`），确保代码仓库均设置 `git_isolation: worktree`。

---

## Step 3：为不同桌面 Agent 工具装配 MCP（工具中立！）

运行以下命令生成标准 MCP 配置片段：
```bash
pnpm deck mcp-config --role worker --agent-id desktop-engineer
```
（或直接读取 `.deck/mcp-clients/desktop-agent.mcp.json`。）

根据用户真实使用的工具，主动告知或代为写入对应位置（修改用户全局配置前务必先征得同意）：
- **DeepSeek Harness (`dsh`)**：支持两种方式——① 将 `mcpServers` 合并入 `dsh` MCP 配置；② 安装可选的原生参考插件 `adapters/dsh-plugin`（一键托管 Skills + MCP + 后台 Dispatcher）。
- **Claude Code (`claude`)**：写入项目 `.mcp.json` 或 `~/.claude.json` 的 `mcpServers`。
- **OpenAI Codex (`codex`)**：写入 `~/.codex/config.toml` 的 `[mcp_servers.*]`。
- **Antigravity (`agy`) / Cursor / Coomi**：合并入对应的 `mcpServers` JSON 配置文件。

---

## Step 4：启动桌面工长并跑模拟派单验收

```bash
# 终端 1：启动桌面工长（常驻监听收发室）
pnpm deck dispatch

# 终端 2：用内置模拟秘书发一条 L1 测试单
pnpm deck mock secretary --project harness-deck --driver mock --instruction "验收桌面工位调度链路"
```

确认终端 1 自动接单、执行完毕并回传 `task.result` 与日志附件后，接入完成！
