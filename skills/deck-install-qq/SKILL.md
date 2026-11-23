---
name: deck-install-qq
description: 场景一/二 QQ 助手（Qmmi + NapCat OneBot v11 + Deck QQ Bridge）安装部署剧本，覆盖本地电脑 Docker 部署与远程 Linux 服务器 SSH 一键部署两条完整分支。
---

# QQ 助手（Qmmi + NapCat）双分支部署剧本

本 Skill 负责把 **库米 O1（`T1` 秘书）** 以及可选的 **库米 K1（`T3` 社区专员）** 对应的 `NapCat + Qmmi / Deck QQ Bridge` 运行环境真正装好、连上收发室，并引导用户完成 QQ 扫码登录。

---

## 前置确认清单（未收集完整必须先问用户）

- [ ] 部署目标：`local`（本地电脑）或 `remote_ssh`（远程 Linux 服务器）
- [ ] 角色范围：`o1_only`（仅秘书 O1）或 `o1_and_k1`（O1 + 社区群 K1）
- [ ] `.env` 已通过 `pnpm deck init` 生成（包含 `DECK_BOSS_QQ_LIST`、`NAPCAT_O1_TOKEN` 等）
- [ ] 若选 `remote_ssh`：已确认 `host`、`port`、`user`、`key_path`、`remote_dir`、`relay_port`

---

## 分支 A：本地电脑部署（同机零服务器模式）

1. **检查 Docker 可用性**：
   ```bash
   docker --version
   docker compose version
   ```
   若未安装，请暂停并引导用户安装 Docker Desktop。

2. **准备本地 OneBot v11 配置并启动 NapCat**：
   - 读取 `deploy/napcat/onebot11.template.json`，将 `{{TOKEN}}` 替换为 `.env` 中的 `NAPCAT_O1_TOKEN`（如启用 K1，再为 `napcat-k1` 渲染一份端口 `3002` + `NAPCAT_K1_TOKEN`）。
   - 启动本地编排：
     ```bash
     # 仅 O1：
     docker compose -f deploy/local/docker-compose.qq.yml --env-file .env up -d

     # 若同时启用 O1 + K1（独立双 QQ 号容器，隔离风控）：
     docker compose -f deploy/local/docker-compose.qq.yml --env-file .env --profile k1 up -d
     ```

3. **引导用户扫码登录 QQ**：
   - 提取 NapCat WebUI 登录 Token：
     ```bash
     docker logs harness-deck-napcat-o1 2>&1 | grep -i token
     ```
   - 告诉用户打开浏览器访问 `http://127.0.0.1:6099/webui`（若启用 K1，另外访问 `http://127.0.0.1:6100/webui`），输入 Token 后用对应的机器人 QQ 号扫码登录，并在「网络配置」确认 OneBot 11 WebSocket Server（端口 `3001` / `3002`）已开启。

4. **接入 Qmmi（可选叠加 AI 对话引擎）与启动 Deck QQ Bridge**：
   - 如用户已在本地运行 `TensorHub-ORG/Qmmi`，可在 `.env` 中填入 `QMMI_O1_API_URL`（以及 `.deck/mcp-clients/kumi-o1.mcp.json` 挂入 Qmmi 的 MCP 配置，让 Qmmi 直接调用 `deck-comm` / `deck-qq` / `deck-kb`）。
   - 启动本地桥接进程（负责双向转发 Mailroom 信封、审批短码与文件附件）：
     ```bash
     pnpm deck qq-bridge --profile o1
     # 若启用 K1，另开终端或后台运行：
     pnpm deck qq-bridge --profile k1
     ```

---

## 分支 B：远程 Linux 服务器部署（SSH 一键部署 + 跨端轻量 Relay）

1. **先做 Dry-Run 向用户展示即将执行的 SSH 操作（透明安全！）**：
   ```bash
   pnpm deck deploy-ssh --host <HOST> --port <PORT> --user <USER> --key <KEY_PATH> --remote-dir <REMOTE_DIR> --scope <o1_only|o1_and_k1> --dry-run
   ```
   将输出的目标地址、端口和命令清单展示给用户，获得用户确认后再正式执行。

2. **正式执行远程 SSH 部署（自动适配 Docker 或原生无 Docker 低内存 2C2G 模式！）**：
   - 自动检测远端是否安装 Docker：
     - 有 Docker -> 运行 `setup-vps.sh` 拉起 `deck-relay` + `napcat-o1` (+ 可选 `napcat-k1`) + `qq-bridge` 容器；
     - **无 Docker（如 2C2G 轻量云，已装 Node >= 22）** -> 自动切换 `setup-vps-native.sh`，用远端原生 Node + `systemd` 拉起 `harness-deck-relay.service`（仅占 ~40MB 内存，避免压垮 2G 小机器）。
   - 部署前务必先用 `ss -tlnp` 检查目标端口（默认 `8787` / `3001` / `6099`）是否被已有业务占用，若冲突自动避让到空闲端口（如 `18787` / `13001` / `16099`）。
   ```bash
   pnpm deck deploy-ssh --host <HOST> --port <PORT> --user <USER> --key <KEY_PATH> --remote-dir <REMOTE_DIR> --relay-port <RELAY_PORT> --runtime auto --scope <o1_only|o1_and_k1>
   ```

3. **网络与安全建议（主动提醒用户）**：
   - 如不想把 `6099` / `8787` 端口直接暴露公网，推荐给用户一条安全的 **SSH 隧道命令**：
     ```bash
     ssh -N -L 6099:127.0.0.1:6099 -L 8787:127.0.0.1:8787 -i <KEY_PATH> <USER>@<HOST>
     ```
     这样本地电脑只需把 `DECK_ENDPOINT` 设为 `http://127.0.0.1:8787` 即可加密穿透访问，云端无需公网暴露任何敏感管理端口！

4. **验证连通性**：
   - 引导用户扫码登录远端 NapCat WebUI；
   - 访问 `http://<RELAY_HOST>:8787/health` 确认返回 `{"ok":true}`；
   - 使用 `qq_health_check` 工具或让老板给 O1 私聊发 `状态` 验证闭环。
