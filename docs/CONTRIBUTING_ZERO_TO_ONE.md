# TensorHub 0 基础团队协作开发指南

欢迎加入 **Harness-Deck**！本项目专门设计为**“零基础友好 + AI 辅助开发 + 三位主力并行推进”**的工程实践项目。

---

## 1. 先跑通本地全链路（5 分钟）

```bash
pnpm install
pnpm build
pnpm test
pnpm deck init --mode local
pnpm deck doctor
```

如果 `pnpm deck doctor` 全部亮绿灯，说明你本地已经跑通了：
- HDP v1 协议校验与 `T0 > T1 > T2 > T3` 越权拦截自测
- Secret Scrubber 密钥自动脱敏自测
- Mock 工程师从接单 -> 执行 -> 交付包回传的完整闭环

---

## 2. 三位主力怎么并行开发、互不等待？

本项目内置了 **`deck mock`** 替身工具，你可以在队友还没写完模块时独立调试自己的部分：

- **模块 A（协议 / 收发室 / 通信 MCP）**：`protocol/`、`packages/mailroom/`、`mcps/deck-comm/`
  - 用 `pnpm test` 跑单元测试与集成测试。
- **模块 B（QQ 助手 / Qmmi + NapCat / 角色 Skill）**：`mcps/deck-qq/`、`deploy/`、`skills/deck-install-qq/`、`skills/deck-role-o1/`、`skills/deck-role-k1/`
  - 本地启动 `pnpm deck mock engineer` 模拟桌面工程师，专注调试 QQ 消息/文件双向收发与扫码流程。
- **模块 C（桌面工长 / 多 CLI 驱动 / 工具适配插件）**：`packages/dispatcher/`、`mcps/deck-dispatch/`、`adapters/dsh-plugin/`
  - 本地运行 `pnpm deck mock secretary --dispatch` 投递模拟工单，专注测试 `dsh` / `claude` / `codex` / `agy` / `zcode` 的调用与 `git worktree` 隔离。

---

## 3. 新增业务管线包（`packs/`）的 3 步规范

当你要认领 `coomi.septemc.com` 前端部署、`updates.septemc.com` 反馈看板、或 `TensorHub-ORG` GitHub PR 巡检时：
1. 在 `packs/<pack-name>/` 下新建独立目录；
2. 复用 `@harness-deck/protocol` 和 `@harness-deck/mailroom` 客户端，以 `T2 (worker)` 身份接入收发室；
3. 配套写一份 `skills/deck-pack-<name>/SKILL.md` 告诉任意 Agent 如何交互式引导配置和调用它。
