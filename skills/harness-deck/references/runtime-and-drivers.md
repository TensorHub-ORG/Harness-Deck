# Harness-Deck — 运行态、MCP、CLI 驱动与避坑参考

> 本文档为 `harness-deck` 认知 Skill 的按需工程参考，涵盖双模部署、4 套 MCP、8 种桌面 CLI 驱动、常用命令与线上实测避坑清单。

## 1. 代码仓库地图

| 目录 | 包名 / 定位 | 核心职责 |
| :--- | :--- | :--- |
| `protocol/` | `@harness-deck/protocol` | HDP v1 Schema、四级信任与路由矩阵、脱敏与防注入围栏 |
| `packages/mailroom/` | `@harness-deck/mailroom` | `MailroomStore` (`node:sqlite`)、`DeckRelayServer` (HTTP+WS)、`LocalMailroomClient` (`file://`) & `RemoteMailroomClient` (`http(s)://`，含瞬断自动重试 + 20s 超时) |
| `packages/dispatcher/` | `@harness-deck/dispatcher` | `DeckDispatcher` 桌面工长（白名单校验、Worktree 隔离、附件落盘 `_inputs/<task_id>/`、长任务心跳、`task.cancel` 进程树强杀、双保险兜底上报）与 8 种 CLI 驱动 |
| `packages/cli/` | `@harness-deck/cli` | `deck` 统一命令行与 `supervisor.ts`（`status` / `up` / `daemon` / `cancel`） |
| `mcps/deck-comm/` | `@harness-deck/mcp-comm` | 跨 Agent 通信 MCP，按 `DECK_AGENT_TIER` 动态裁剪工具 |
| `mcps/deck-dispatch/` | `@harness-deck/mcp-dispatch` | 本地环境扫描、白名单查看、Worktree 管理、MCP 配置生成 |
| `mcps/deck-qq/` | `@harness-deck/mcp-qq` | NapCat OneBot v11 客户端、`formatPlainTextForQq()`、双向媒体/文件提取、`QqBridgeDaemon`（O1/K1）、`OpenAiCompatibleBrain` |
| `mcps/deck-kb/` | `@harness-deck/mcp-kb` | 知识库与社区反馈账本 MCP（`T3` 仅开放只读检索与反馈登记，禁写文档） |
| `adapters/dsh-plugin/` | `@harness-deck/adapter-dsh` | DeepSeek Harness (`dsh`) 可选 Cordis 原生深度适配参考 |
| `skills/` | 8 个模块化 Skill | `harness-deck`（体系认知）、`deck-onboarding`（0 基础装机）、`deck-pilot`（日常运维）、`deck-install-qq`、`deck-connect-engineers`、`deck-role-o1`、`deck-role-k1`、`deck-role-engineer` |
| `deploy/` | 本地与 VPS 套件 | Docker Compose、零 Docker 原生 `systemd` 部署脚本（`setup-vps-native.sh`，~23MB RAM）、NapCat 模板、人设预设 |
| `packs/` | 业务管线预留槽 | 未来挂载 GitHub 巡检、官网发布、定时简报、聚合 API 槽位等 |

## 2. 内置 8 种桌面 CLI 驱动（`packages/dispatcher/src/drivers.ts`）

| Driver ID | 默认命令 / 关键调用特征 | 支持续聊 (`resume_session_id`) |
| :--- | :--- | :---: |
| `dsh-cli` | `dsh --profile headless [--patch DECK_DSH_PATCH] --json --approval-policy never [--permission-mode read-only \| --add-dir cwd] [--add-dir inputDir] [--session-id id] -`（Prompt 经 **stdin** 传入，解析 JSONL `session`/`status`/`final.text`） | 是 |
| `agy-cli` | `agy --print <prompt> --output-format text --print-timeout <sec>s --mode <plan\|accept-edits\|auto> [--add-dir cwd] [--add-dir inputDir] [--conversation id]`（**无 `run` 子命令**） | 是 |
| `claude-code-cli` | `claude -p <prompt> --output-format stream-json --permission-mode <plan\|acceptEdits> [--resume id]` | 是 |
| `codex-cli` | `codex exec <prompt> --json --sandbox <read-only\|workspace-write\|danger-full-access>` | 否 |
| `zcode-cli` | `zcode run <prompt>` | 否 |
| `coomi-cli` | `coomi run --prompt <prompt>` | 否 |
| `custom-cli` | `.deck/workstation.yaml` 自定义 `command_template`（支持 `{{prompt}}` / `{{cwd}}` / `{{task_id}}` / `{{project}}`） | 否 |
| `mock-cli` | 内置 Node 替身，供离线联调与 `deck doctor` 验证 | 是 |

## 3. 常用 `deck` CLI 命令速查

```bash
pnpm build && pnpm test && pnpm smoke:mcp && pnpm deck doctor   # 改动后必跑四件套
pnpm deck scan [--json]                                         # 扫描本机工具与已安装 CLI
pnpm deck status [--json]                                       # 1 秒查看 Relay/NapCat/工位/待审/工单
pnpm deck up [--profile o1|k1] [--with-relay] [--no-tunnel]     # 一键托管守护（自动指数退避重启）
pnpm deck daemon <script|install|uninstall> [--apply]           # 生成/注册开机自启（Windows 计划任务 / systemd --user）
pnpm deck approve <A-xxxx> / pnpm deck reject <A-xxxx> [理由]   # 终端侧 T0 审批兜底
pnpm deck cancel <T-xxxx> [原因]                                # 实时强杀运行中的桌面任务
pnpm deck trace <trace_id>                                      # 查看完整 JSONL 审计链路
pnpm deck mcp-config --role <boss|secretary|worker|frontline>   # 导出标准 mcpServers JSON
pnpm pack:bundle                                                # 打包便携整合包至 dist-bundle/harness-deck/
```

## 4. 线上实测避坑清单（开发/排障必看）

1. **Windows npm `.cmd` 垫片陷阱**：直接用 `cmd.exe` (`shell: true`) 执行 `.cmd` 传入多行 UTF-8 Prompt 会截断/破坏引号；必须通过 `unwrapWindowsNpmShim()` 解析 `"%dp0%\...\bin.js"` 后由 `process.execPath` 直接调用。
2. **输出缓冲防断行**：必须缓存完整 `stdoutRaw`/`stderrRaw` 后再按行切分，避免流式 chunk 切断中文或单词。
3. **WS + 轮询竞态去重**：`QqBridgeDaemon` 与 `DeckDispatcher` 同时订阅 WS 与定时轮询，依赖 `processingEnvelopeIds` 内存锁防重复执行或重复发 QQ。
4. **长连接 Keep-Alive 瞬断防护**：`RemoteMailroomClient` 对幂等请求内置一次瞬断自动重试 + 20s 超时，所有守护进程定时器均带异常捕获与节流日志，防止 SSH 隧道抖动导致未捕获 Promise 拒绝退出。
5. **QQ 双向文件流**：老板给 O1 发文件/图片后暂存 15 分钟，下次派单（含 L3 审批放行）自动附带到 `task.dispatch.attachments`，工长落盘至 `<worktree_root>/_inputs/<task_id>/` 并自动追加 `--add-dir` 权限，不污染 Git 状态。
6. **VPS 原生 `systemd` 刷新**：更新代码后必须执行 `systemctl enable` + `systemctl restart`（仅 `enable --now` 不会重启已在运行的服务）。
7. **本地运行态安全检查**：诊断本机实况时可只读检查 gitignored 的 `.env`、`.deck/workstation.yaml`、`.deck/install-state.json`、`.deck/audit/*.jsonl`，但**严禁**将密钥、Token、私网 IP、个人 QQ 号输出到跟踪文件或公开文档。
