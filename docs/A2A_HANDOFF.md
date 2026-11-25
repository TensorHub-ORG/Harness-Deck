# Harness-Deck — A2A (Agent-to-Agent) Context & Handoff Brief

> **Target Reader**: Any AI Agent (`dsh`, `agy` / Antigravity, Claude Code, Codex, Cursor, ZCode, Coomi, etc.) entering a **brand-new session** to develop, debug, operate, or extend **Harness-Deck**.
>
> **Do not confuse with [`START_HERE.md`](../START_HERE.md)**:
> - Use [`START_HERE.md`](../START_HERE.md) when **onboarding a new human user** to deploy Harness-Deck from scratch.
> - Use **this document** when **you (an AI Agent) are taking over engineering, debugging, or operations** on this repository.

---

## 0. 30-Second Cold-Start Summary

- **Project**: **Harness-Deck** — *"连接并驾驭。 / Connect and harness."* (`https://github.com/TensorHub-ORG/Harness-Deck`, MIT License)
- **What it is**: A **tool-neutral, Human-in-the-Loop multi-agent collaboration protocol (`HDP v1`)** and modular **Skill + MCP + CLI** bundle built for TensorHub-ORG (`Coomi`, `Qmmi`, `Latexsnipper`, `Storydex`, etc.) and personal multi-CLI orchestration.
- **Core Stack**: TypeScript 5.9 (`ESM`), `pnpm` monorepo, **Node.js `>= 22.5`** using built-in `node:sqlite` (**zero native C++ addons**), `zod`, `@modelcontextprotocol/sdk`, `ws`, `yaml`.
- **Architecture Diagram**: [`docs/architecture.png`](architecture.png) / [`docs/architecture.svg`](architecture.svg) (minimalist Excalidraw whiteboard schematic; keep in sync when changing layers or tiers).

---

## 1. Non-Negotiable Architecture & Security Invariants

**NEVER weaken, bypass, or work around any of the following invariants:**

1. **Monotonic 4-Tier Trust Hierarchy (`protocol/src/tiers.ts`)**:
   - `T0 (boss)` > `T1 (secretary, e.g. Coomi O1 / 库米 O1)` > `T2 (worker, Desktop Foreman & CLI Engineers)` > `T3 (frontline, e.g. Coomi K1 / 库米 K1)`.
   - External QQ group members have **no tier** (untrusted external input).
2. **Hard Isolation Rules (enforced in `validateRouting()` + Mailroom + MCP tool registration)**:
   - **`T2 ↮ T3` STRICTLY FORBIDDEN**: Internal workers (`T2`) and public frontline (`T3`) can NEVER exchange envelopes directly; all mediation passes through `T1`.
   - **`T3 ↛ T0` STRICTLY FORBIDDEN**: Public frontline (`T3`) can NEVER directly message the Boss (`T0`) or send private QQ messages; `T3` only gets read-only `deck-kb` access and upward structured digests to `T1`.
   - **`T3` Anti-Injection**: Incoming `T3 -> T1` digests are tagged `untrusted_origin: true` and wrapped via `wrapUntrustedDigest()` (data-only fence, never execute as instructions).
3. **L3 Approval Gate**:
   - Any `task.dispatch` with `risk_level: "L3"` requires a valid `T0` `approval_ref` (short code like `A-1042`).
   - Pending L3 dispatch payloads are persisted in SQLite `approvals.metadata_json` so restarts do not lose pending approvals, and expired approvals are swept automatically in `listApprovals()`.
4. **Loop Breaker & Secret Hygiene**:
   - `hop_count > max_hops` (default `6`) hard-blocks envelopes to prevent agent infinite loops.
   - All envelopes, logs, and outgoing QQ messages pass through `scrubSecrets()` (`protocol/src/security.ts`).
   - **Never commit secrets or PII**: `.env`, `.deck/`, `*.sqlite*`, private keys, VPS IPs, API keys, and personal QQ numbers MUST stay gitignored.
5. **Tool-Neutral Core**:
   - `protocol/`, `packages/mailroom/`, `packages/dispatcher/`, `mcps/`, and `skills/` MUST remain 100% vendor/tool-neutral. Tool-specific deep plugins live ONLY under `adapters/` (e.g., `adapters/dsh-plugin/`).
6. **Mandatory Workspace Safety (`T2`)**:
   - Desktop Dispatcher MUST enforce project directory allowlists from `.deck/workstation.yaml` and isolate code edits in dedicated `git worktree` checkouts (`packages/dispatcher/src/worktree.ts`).

---

## 2. Monorepo Codebase Map

| Workspace / Path | Package Name | Key Files & Responsibility |
| :--- | :--- | :--- |
| `protocol/` | `@harness-deck/protocol` | `src/tiers.ts` (`T0..T3`, 12 `EnvelopeType`s, `ROUTING_MATRIX`, `validateRouting`), `src/schemas.ts` (Zod schemas for envelopes, tasks, approvals, workstation, install state), `src/security.ts` (`scrubSecrets`, `wrapUntrustedDigest`, token/ID generators). |
| `packages/mailroom/` | `@harness-deck/mailroom` | `src/store.ts` (`MailroomStore` on `node:sqlite`: agents, envelopes, tasks, approvals + `metadata_json`, artifacts w/ SHA256, KB docs, feedback ledger, JSONL `trace_id` audit), `src/relay-server.ts` (`DeckRelayServer` HTTP + WS), `src/client.ts` (`LocalMailroomClient` for `file://` zero-server mode + `RemoteMailroomClient` for `http(s)://` cross-machine mode via `createMailroomClient`). |
| `packages/dispatcher/` | `@harness-deck/dispatcher` | `src/dispatcher.ts` (`DeckDispatcher` T2 foreman daemon: WS + poll dedupe, inbound attachment materialization into `_inputs/<task_id>/`, worktree lifecycle, periodic long-task heartbeats, clean `task.cancel` -> `cancelled` reporting, timeout watchdog w/ process-tree kill, stdout/stderr full buffering, fallback result reporting), `src/drivers.ts` (`unwrapWindowsNpmShim`, `extraDirs` `--add-dir` injection, 8 drivers), `src/detect.ts`, `src/worktree.ts`, `src/config-gen.ts`. |
| `packages/cli/` | `@harness-deck/cli` | `src/index.ts` (`deck` CLI: `scan`, `status`, `up`, `daemon`, `init`, `relay`, `dispatch`, `qq-bridge`, `deploy-ssh`, `doctor`, `trace`, `mock`, `approve`, `reject`, `cancel`, `mcp-config`), `src/supervisor.ts` (`collectStackStatus`, `runSupervisor` watchdog, `manageDaemonAutostart`), `src/deploy-ssh.ts` (Docker & zero-Docker native `systemd` VPS deployer with Windows `~` path expansion). |
| `mcps/deck-comm/` | `@harness-deck/mcp-comm` | Role-scoped stdio MCP (`deck_whoami`, `deck_list_agents`, `deck_pull_inbox`, `deck_dispatch_task`, `deck_report_progress`, `deck_submit_result`, `deck_notify_secretary`, `deck_request_approval`, `deck_send_directive`, `deck_upload_artifact`, etc. dynamically gated by `DECK_AGENT_TIER`). |
| `mcps/deck-dispatch/` | `@harness-deck/mcp-dispatch` | Local T2/T0 workstation & worktree inspection MCP (`dispatch_scan_environment`, `dispatch_get_workstation`, `dispatch_list_worktrees`, `dispatch_cleanup_worktree`, `dispatch_generate_mcp_config`). |
| `mcps/deck-qq/` | `@harness-deck/mcp-qq` | `src/index.ts` (QQ MCP gated by tier), `src/onebot.ts` (NapCat OneBot v11 WS client + `formatPlainTextForQq()` + `extractInboundMedia()` + `getFile`), `src/bridge-daemon.ts` (`QqBridgeDaemon` for `o1` & `k1`: Boss file/image ingestion, `续聊`/`取消` fast-paths, throttled progress heartbeats), `src/llm-brain.ts` (`OpenAiCompatibleBrain` tool-calling incl. `dispatch_desktop_task` w/ `resume_from_task_id`, `cancel_running_task`, `approve_or_reject_pending`). |
| `mcps/deck-kb/` | `@harness-deck/mcp-kb` | Knowledge base & community feedback ledger MCP (`kb_search`, `feedback_record`; write tools `kb_ingest_doc` / `kb_ingest_markdown_file` blocked for `T3`). |
| `adapters/dsh-plugin/` | `@harness-deck/adapter-dsh` | Optional Cordis-compatible reference plugin for DeepSeek Harness (`dsh`). |
| `skills/` | — | 8 Agent skills: `harness-deck` (universal cognitive mental model + `references/`), `deck-onboarding` (Day-0 setup), `deck-pilot` (everyday control & ops), `deck-install-qq`, `deck-connect-engineers`, `deck-role-o1`, `deck-role-k1`, `deck-role-engineer` (auto-discovered via `.agents/skills.json`). |
| `deploy/` | — | `local/docker-compose.qq.yml`, `remote/docker-compose.vps.yml`, `remote/Dockerfile.deck-runtime`, `remote/setup-vps.sh`, `remote/setup-vps-native.sh` (native Node + `systemd`, ~23MB RAM), `napcat/onebot11.template.json`, `presets/coomi-o1-persona.txt` (1v1 engineering persona, plain-text only). |
| `packs/` | — | Reserved extension slot for future domain pipelines (GitHub watch, web release, feedback sync, deferred `api-gateway-slot`). |
| `scripts/` | — | `smoke-mcp.mjs` (6 JSON-RPC role-scoping tests), `pack-bundle.mjs` (portable bundle builder → `dist-bundle/harness-deck/`). |

---

## 3. Runtime Topology & Data Flows

### Dual-Mode Mailroom (`DECK_ENDPOINT`)
- **Mode A (`file://./.deck/mailroom`)**: Single-machine zero-server mode; all processes share local SQLite + artifact directory directly.
- **Mode B (`http://127.0.0.1:<port>` via SSH tunnel or `https://<vps>`)**: Lightweight `deck-relay` runs on VPS (bound strictly to `127.0.0.1` when using SSH port forwarding `-L <local>:127.0.0.1:<remote>`). Desktop Foreman (`deck dispatch`) and QQ Bridge (`deck qq-bridge`) connect outbound — **no public desktop IP required**.

### Typical Boss → QQ O1 → Desktop CLI → Boss Flow
1. Boss (`T0`) sends a private QQ message to **Coomi O1 (`T1`)** via NapCat OneBot v11 WS.
2. `QqBridgeDaemon` verifies sender is in `DECK_BOSS_QQ_LIST`, invokes `OpenAiCompatibleBrain` (with persona loaded from `DECK_QQ_PERSONA_FILE` and strict plain-text formatting for QQ).
3. If task risk is `L3` (or `defaultRiskLevel=L3`): O1 creates a persistent approval record (`short_code`, e.g. `A-1042`, storing dispatch metadata in SQLite `approvals.metadata_json`) and asks Boss to reply `批准 A-xxxx` / `授权`.
4. Upon approval (or immediately for `L1`/`L2`), O1 sends a `task.dispatch` envelope to the target `T2` worker via Mailroom.
5. `DeckDispatcher` receives the envelope (deduped across WS + poll via `processingEnvelopeIds`), verifies project allowlist, optionally creates a `git worktree`, spawns the requested CLI driver (`dsh`, `agy`, `claude`, `codex`, etc.), monitors timeout/stdout/stderr, and posts `task.result` (plus optional uploaded SHA256 artifacts like PDFs) back to `T1`.
6. `QqBridgeDaemon` pulls `task.result` / `notify.secretary`, downloads any attached artifacts, formats plain text (stripping Markdown), and delivers message + files to Boss QQ.

---

## 4. Battle-Tested Driver Quirks & Pitfalls (DO NOT RE-BREAK)

These were uncovered and fixed on real Windows + Linux production runs. Keep them intact when editing:

1. **Windows npm `.cmd` Shims (`packages/dispatcher/src/drivers.ts`)**:
   - Global npm CLIs (`dsh.cmd`, `claude.cmd`) break multiline UTF-8 prompts and quotes if spawned via `cmd.exe` (`shell: true`).
   - Always use `unwrapWindowsNpmShim()` to resolve `"%dp0%\...\bin.js"` and invoke `process.execPath` directly.
   - Conversely, CLI detection (`packages/dispatcher/src/detect.ts`) needs `shell: true` for `.cmd` version checks and inspects user-local fallback bin dirs (e.g. `%LOCALAPPDATA%\agy\bin`).
2. **`dsh-cli` Exact Invocation**:
   - Uses `dsh --profile headless [--patch <DECK_DSH_PATCH>] --json --approval-policy never [--permission-mode read-only | --add-dir <cwd>] [--session-id <id>] -` with the prompt piped to **stdin** (`stdinText`).
   - Never use non-existent `dsh run`; parse JSONL lines for `type: "session"` (`sessionId`), `type: "status"`, and `type: "final"` (`final.text`).
3. **`agy-cli` Exact Invocation**:
   - Uses `agy --print <prompt> --output-format text --print-timeout <sec>s --mode <plan|accept-edits|auto> [--dangerously-skip-permissions] [--add-dir <cwd>] [--conversation <id>]`.
   - Never pass a `run` subcommand.
4. **Output Buffering & Process-Tree Cleanup (`packages/dispatcher/src/dispatcher.ts`)**:
   - Buffer raw `stdoutRaw` / `stderrRaw` chunks before splitting lines so streaming chunks never inject mid-word newlines into summaries.
   - On timeout on Windows, kill the full process tree via `taskkill /T /F /PID <pid>`.
5. **WS + Polling Race Deduplication**:
   - Both `QqBridgeDaemon` and `DeckDispatcher` subscribe to WebSocket pushes AND run fallback polling; keep `processingEnvelopeIds` in-flight locks so QQ messages / dispatches are never processed twice.
6. **QQ Cannot Render Markdown**:
   - Always run outgoing QQ strings through `formatPlainTextForQq()` (and enforce plain-text rules in `deploy/presets/coomi-o1-persona.txt`).
7. **VPS Native `systemd` Reload (`deploy/remote/setup-vps-native.sh`)**:
   - Always run `systemctl enable` followed by `systemctl restart` (NOT `enable --now` alone, which does not restart an already-running service after code updates).
8. **GitHub Secret Scanning in Tests**:
   - Never write literal synthetic OpenAI/GitHub token-shaped strings in test fixtures; concatenate prefixes dynamically at runtime so GitHub Push Protection never rejects commits.
9. **Windows PowerShell 5.1**:
   - On Windows dev hosts running PowerShell 5.1, chain commands with `;` (not `&&`) and check `$LASTEXITCODE`.

---

## 5. Build, Test & Verification Playbook

Run these after ANY code modification:

```bash
# 1. Full monorepo TypeScript build (required before running `pnpm deck` or tests)
pnpm build

# 2. Unit & integration tests (protocol RBAC/scrubber + mailroom SQLite/relay + dispatcher worktree/drivers)
pnpm test

# 3. MCP JSON-RPC role-scoping smoke tests (6 assertions across T0/T1/T2/T3)
pnpm smoke:mcp

# 4. End-to-end local self-check (RBAC deny check, scrubber check, mock engineer dispatch)
pnpm deck doctor

# 5. Optional: rebuild portable distribution bundle (`dist-bundle/harness-deck/`)
pnpm pack:bundle
```

Useful operational CLI commands (`pnpm deck <cmd>`):
- `pnpm deck scan [--json]` — inspect OS, Node, Git, Docker, SSH, installed CLI drivers
- `pnpm deck status [--json]` — 1-second health report across Mailroom/Relay, NapCat, Workstation, pending approvals & recent tasks
- `pnpm deck up [--profile o1|k1] [--with-relay] [--no-qq] [--no-dispatch]` — run supervised local stack with auto-restart watchdog
- `pnpm deck daemon <script|install|uninstall> [--profile o1|k1] [--apply]` — generate or register OS autostart (Windows Scheduled Task / Linux `systemd --user`)
- `pnpm deck relay` — start cross-machine Mailroom relay server
- `pnpm deck dispatch` — start T2 Desktop Foreman daemon
- `pnpm deck qq-bridge --profile o1|k1` — start QQ Bridge daemon
- `pnpm deck trace <trace_id>` — inspect full JSONL audit trail
- `pnpm deck approve|reject <short_code>` — T0 CLI approval fallback
- `pnpm deck cancel <task_id> [reason]` — stop a running desktop task live
- `pnpm deck mcp-config --role <boss|secretary|worker|frontline>` — emit standard `mcpServers` JSON

---

## 6. Inspecting Local Runtime State Safely (For Live-Host Sessions)

When operating on an already-deployed host, local machine configuration lives in **gitignored** files:
- `.env` — active `DECK_ENDPOINT`, scoped tokens, QQ allowlists, NapCat WS URL, LLM Brain config, `DECK_DSH_PATCH`
- `.deck/workstation.yaml` — `node_id`, enabled CLI engineers (`dsh`, `agy`, etc.), allowlisted project directories
- `.deck/install-state.json` — onboarding/deploy progress state
- `.deck/dsh-headless.patch.yml` — optional headless provider patch for `dsh`
- `.deck/audit/<trace_id>.jsonl` — per-trace audit trails

**Strict Security Rule for Incoming Agents**:
- You MAY read `.env` / `.deck/*` locally to diagnose issues, **NEVER** echo raw API keys, tokens, private SSH keys, personal QQ numbers, or private server IPs into chat logs unnecessarily, and **NEVER** write them into tracked Git files.

---

## 7. Current Status & Prioritized Roadmap

### Completed & Verified
- Full HDP v1 monorepo (`protocol`, `mailroom`, `dispatcher`, `cli`, 4 `mcps`, `adapters/dsh-plugin`, 7 `skills` incl. `deck-pilot`, Docker + native `systemd` `deploy/`, GitHub Actions CI `.github/workflows/ci.yml`).
- Everyday operations & reliability upgrades: `pnpm deck status`, `pnpm deck up` auto-restart supervisor, `pnpm deck daemon` OS autostart generator, `pnpm deck cancel` live task termination (`status: "cancelled"`), long-task periodic heartbeats, QQ → Desktop inbound file/image ingestion (`_inputs/<task_id>/` + `--add-dir`), and QQ `续聊 T-xxxx` / `resume_from_task_id` session resume.
- Production live verification: Aliyun 2C2G native `systemd` `deck-relay` + SSH tunnel + NapCat `Coomi O1` + CPA OpenAI-compatible Brain + Desktop Foreman (`dsh` + `agy`) + L3 persistent approval + Desktop-to-QQ PDF artifact delivery.
- Clean public repository at `https://github.com/TensorHub-ORG/Harness-Deck` with minimalist Excalidraw whiteboard architecture schematic ([`docs/architecture.png`](architecture.png)).

### Intentionally Deferred
- API Aggregation Platform (`packs/api-gateway-slot/`) — deferred to a later milestone.

### Next Recommended Milestones
- **P1 (Community Frontline `T3`)**:
  - Bring up second QQ instance for **Coomi K1 (`T3`)** bound to read-only `deck-kb` + TensorHub community groups (`K1 -> O1 -> Boss -> T2 -> K1` closed loop).
- **P2 (`packs/` Automation & Multi-IM)**:
  - Implement `packs/github-watch` & `packs/research-brief` scheduled pipelines; add optional Feishu/Telegram edge adapters reusing HDP v1.
- **P3 (OSS Polish)**:
  - Lightweight dark status dashboard (`deck ui`), `README_EN.md`, and real-host verification for `claude`/`codex`/`zcode`/`coomi` drivers.

---

## 8. Quick Intake Guide for Incoming Agents

Choose your next read based on what the user asked you to do:
- **User wants to deploy Harness-Deck on a new machine** → Read [`START_HERE.md`](../START_HERE.md) and [`skills/deck-onboarding/SKILL.md`](../skills/deck-onboarding/SKILL.md).
- **User wants to modify protocol / RBAC / schemas** → Read [`docs/PROTOCOL.md`](PROTOCOL.md) and [`protocol/src/tiers.ts`](../protocol/src/tiers.ts).
- **User wants to add/fix a desktop CLI driver or worktree behavior** → Read [`packages/dispatcher/src/drivers.ts`](../packages/dispatcher/src/drivers.ts) and [`packages/dispatcher/src/dispatcher.ts`](../packages/dispatcher/src/dispatcher.ts).
- **User wants to tune Coomi O1/K1 QQ behavior or LLM tools** → Read [`mcps/deck-qq/src/bridge-daemon.ts`](../mcps/deck-qq/src/bridge-daemon.ts) and [`mcps/deck-qq/src/onebot.ts`](../mcps/deck-qq/src/onebot.ts).
- **User wants to inspect/upgrade Mailroom or VPS Relay** → Read [`packages/mailroom/src/store.ts`](../packages/mailroom/src/store.ts) and [`packages/mailroom/src/relay-server.ts`](../packages/mailroom/src/relay-server.ts).
