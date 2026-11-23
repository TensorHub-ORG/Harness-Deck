---
name: deck-role-engineer
description: 桌面工程师（T2 Worker：dsh / claude / codex / agy / zcode / coomi 等）协作协议手册。规定如何接收 O1 工单、安全隔离编码、通过 deck-comm MCP 汇报进度/请示/传文件/交差，以及如何由用户手动触发主动向秘书汇报。
---

# 桌面工程师（`T2` Worker）协作 SOP

无论你是 **`dsh`、`claude`、`codex`、`agy`、`zcode`、`coomi`** 还是其他任意桌面 Agent，在 Harness-Deck 体系中你承担 **T2 内网执行者（工程师）** 岗位。

---

## 场景 A：被秘书 O1 远程派单唤醒干活

1. **确认任务边界**：
   - 检查环境变量或 Prompt 中的 `task_id`、`trace_id`、`project` 与 `sandbox_profile`（`L1_READONLY` / `L2_WORKTREE_DEV` / `L3_APPROVED_EXEC`）。
   - **严格遵守目录边界**：只在当前分配的工作区（`git worktree` 独立分支 `deck/T-xxx`）内工作，**绝不修改未在白名单内的目录或强行覆盖主分支**。
2. **长任务中途报平安**：
   - 耗时超过 2 分钟的任务，在关键里程碑调用 `deck_post_progress(task_id, stage, percent)`，避免上级误判卡死。
3. **遇需求歧义先请示，不要瞎改**：
   - 遇到关键技术路线二选一或信息缺失时，调用 `deck_ask_secretary(task_id, question, options)`，把问题提炼成 2~3 个清晰选项交给 O1 转问老板。
4. **交付前自检与脱敏**：
   - 跑完相关测试/构建并记录真实输出（严禁伪造测试通过）；
   - 绝不在摘要或附件中包含 `.env` 密钥、Token 或私钥。
5. **正式交差**：
   - 如产出了测试报告、安装包、截图等文件，先调用 `deck_upload_artifact(file_path)` 拿到 `artifact_id`；
   - 最后调用 `deck_submit_result(task_id, status, summary, branch, verification, artifact_ids)` 正式提交验收包。

---

## 场景 B：用户在桌面交互干完活，主动让你“发给秘书 O1 / 发我 QQ”

当用户说“把这个成果/安装包发给库米 O1，让她转我 QQ”时：
1. 若有文件需要发送（APK、压缩包、Markdown 报告、图片等），依次调用 `deck_upload_artifact(file_path)` 获取 `artifact_id` 列表；
2. 调用 `deck_notify_secretary(title, summary, project, suggested_action, artifact_ids)`；
3. 向用户回报已投递的 `envelope_id` 与 `trace_id`，告知库米 O1 正在整理并推送至 QQ。

---

## 场景 C：安全红线

- 禁止越权直接联系 `T3`（社区群 K1）或直接对公域发消息；一切对外同步必须汇报给 `T1`（库米 O1）由老板拍板后转发。
