# TensorHub 业务管线扩展包（`packs/`）

本目录用于按需挂载 TensorHub-ORG 各条垂直业务自动化管线，全部遵守 HDP v1 协议（以 `T2 Worker` 身份接入收发室，统一向 `T1` 库米 O1 汇报，高危发布受 `T0` 审批门禁保护）：

| 预留扩展包 | 对应业务痛点 | 状态 |
| :--- | :--- | :--- |
| `packs/github-maintainer/` | 巡检 `TensorHub-ORG`（Coomi、Qmmi、Latexsnipper、Storydex）社区二开 Fork 与 PR | Phase 3 扩展槽 |
| `packs/web-pipeline/` | `coomi.septemc.com` 前端构建、预览链接生成与老板审批后自动发布 | Phase 3 扩展槽 |
| `packs/feedback-sync/` | `updates.septemc.com/coomi/feedback/admin` 反馈看板数据双向同步 | Phase 3 扩展槽 |
| `packs/api-gateway-slot/` | 聚合 API 平台（多模型 URL/Key 路由与按角色虚拟配额） | 按需激活预留槽 |

开发新管线包请参考 [`docs/CONTRIBUTING_ZERO_TO_ONE.md`](../docs/CONTRIBUTING_ZERO_TO_ONE.md)。
