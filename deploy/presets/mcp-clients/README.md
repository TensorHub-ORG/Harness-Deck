# 各桌面 Agent 工具挂载 Harness-Deck MCP 速查指南

运行 `pnpm deck init` 后，系统会自动在 `.deck/mcp-clients/` 生成带真实路径与令牌的配置文件：
- `.deck/mcp-clients/desktop-agent.mcp.json`（给 `T2` 桌面工程师 Agent 用）
- `.deck/mcp-clients/kumi-o1.mcp.json`（给 `T1` 库米 O1 用）
- `.deck/mcp-clients/kumi-k1.mcp.json`（给 `T3` 库米 K1 用）

也可随时运行 `pnpm deck mcp-config --role worker` 打印标准 `mcpServers` JSON。

---

## 各主流 Agent 工具接入位置

| Agent 工具 | 配置方式 |
| :--- | :--- |
| **DeepSeek Harness (`dsh`)** | 方式 1（通用）：将 `mcpServers` 合并到 `dsh` MCP 配置文件中；<br>方式 2（首个深度适配参考）：挂载 `adapters/dsh-plugin` 插件，自动注册所有 `skills/` 与 `mcps/` |
| **Claude Code (`claude`)** | 复制 `.deck/mcp-clients/desktop-agent.mcp.json` 为项目根目录 `.mcp.json`，或合并到 `~/.claude.json` |
| **OpenAI Codex (`codex`)** | 将对应 server 命令转写为 `~/.codex/config.toml` 中的 `[mcp_servers.harness-deck-comm]` 段 |
| **Antigravity (`agy`) / Cursor / Windsurf** | 将 `mcpServers` 合并入对应的 `mcp_config.json` / `.cursor/mcp.json` |
| **Coomi / Qmmi** | 将 `desktop-agent.mcp.json`（桌面端）或 `kumi-o1.mcp.json` / `kumi-k1.mcp.json`（QQ 端）配置到 Coomi/Qmmi 的 MCP 客户端设置中 |
| **ZCode / 自定义 CLI** | 即使不挂 MCP，只要在 `.deck/workstation.yaml` 中注册为 `T2` 工程师，桌面工长 `Deck Dispatcher` 的兜底捕获机制也能自动把输出、Diff 与日志回传给库米 O1 |
