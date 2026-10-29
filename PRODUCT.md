# PipkerOps

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

用户指定：Go Agent；Next.js App Router、React、TypeScript、shadcn/ui、Tailwind CSS；PostgreSQL + Prisma；Redis；Docker Compose。按需独立 Gateway 与 Worker。

## Users

个人开发者和维护 10–50 台 Linux 节点的小团队。

## Product Purpose

统一查看基础设施与应用健康，从管理端或 AI 工具执行可追踪、可审计的运维任务。

## Operating Context

浏览器管理、Agent 主动建立 TLS 连接、systemd 托管；Web/MCP/Cron 共享业务授权与任务机制。部署在自有 Linux 服务器。

## Capabilities and Constraints

完整目标与验收见 docs/PLAN.md。所有数据来自真实 API；空集不填充演示节点。非幂等任务结果不明时不自动重试。不得将真实连接凭据、私钥或运行日志提交 Git。

## Brand Commitments

用户指定参考 1Panel：简洁浅色、分组侧栏、顶部多标签、表格与卡片。中文操作界面。此约束优先于技能的自由视觉探索。

## Evidence on Hand

初始仓库只有 README/许可证，无 HTML Demo、已有品牌资产或业务实现。数据库模型已建立，尚需真实联调。

## Open Decisions

推定首版为单管理域、角色式授权；多租户不在用户要求内。生产域名、证书与部署节点等待实际部署时提供，不影响本地开发。
