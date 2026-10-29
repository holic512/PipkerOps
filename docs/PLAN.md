# 开发与验收计划

整体目标保持完整；阶段通过不代表项目完成。初始盘点：仅 README 与 LICENSE，无源码及 HTML Demo。数据库子任务已提供 schema 与初始迁移。

| 阶段       | 范围                                                     | 验收证据                                  | 状态   |
| ---------- | -------------------------------------------------------- | ----------------------------------------- | ------ |
| 1 基础     | 工程、配置过滤、数据库、身份权限、审计、管理框架         | 迁移/认证拒绝/构建/凭据扫描               | 开发中 |
| 2 接入     | Go Agent、TLS/审批/mTLS、心跳/重连、systemd              | 真实 Agent 注册审批、吊销拒绝、断线重连   | 待实现 |
| 3 监控     | Linux CPU/内存/磁盘/网卡/IO/进程/端口与历史降采样        | Linux 真采样、历史 API、保留策略          | 待实现 |
| 4 应用探针 | 独立应用、多部署、健康/业务字段、多源 HTTP/TCP           | 主控和 Agent 探针、阈值/映射/历史         | 待实现 |
| 5 拓扑     | 应用/实例/节点/容器/Nginx/数据库关系、健康/矩阵          | 真实资源交互拓扑、跨节点探测              | 待实现 |
| 6 运维     | Docker/Compose、Nginx/ACME、PTY/文件/防火墙/systemd/软件 | 隔离 Linux 节点真实操作、服务端权限和审计 | 待实现 |
| 7 自动化   | 动作/动态参数、Cron、任务恢复/日志、告警/通知/Webhook    | 重启恢复、非幂等 UNKNOWN、权限/去重       | 待实现 |
| 8 AI       | MCP 全平台接口、API Key 范围/节点/高危限制、Skills       | SDK 客户端调用、越权拒绝                  | 待实现 |
| 9 交付     | Compose/TLS/持久化/备份恢复/升级、文档/测试              | 空环境部署、备份恢复演练、浏览器完整验收  | 待实现 |

## 架构

Next.js 管理端承载 Web/API/MCP；独立 Node.js Gateway 承载 TLS 注册与 mTLS 长连接，Worker 领取 PostgreSQL 持久化任务并执行主控探针/Cron/告警/维护。Redis 只作短期协调/限流，不是任务唯一事实源。Go Agent 只负责采集和实际执行。业务服务置于 src/lib/services，各入口共享授权、输入验证与任务创建。

数据库契约见 database.md。原始指标按月分区；30天原始/365天小时聚合。迁移增量提交，不使用 db push 替代迁移。

## 安全与部署决策

本地 .env 被忽略，只提交 .env.example。TLS 私钥与 Agent 状态被忽略。开发允许显式开启明文后端例外；生产公网连接强制 TLS。Agent 永不跳过证书验证，注册入口仅 TLS，批准后必须 mTLS。Web 写操作校验同源、角色、scope、节点范围；敏感操作服务端确认并审计。API Key 原文只返回一次。

## 进度与问题记录

- 2026-10-29：恢复检查，确认应用工程尚未落盘，数据库契约完成；开始工程与节点闭环。
- 提供的远程 PostgreSQL/Redis 关闭 TLS。仅开发显式例外；生产需要私网隧道或启用 TLS，不擅自修改远端配置。

## 2026-10-29 运行验收记录

- 远程 PostgreSQL 连接前检查 public 表为空；`prisma migrate deploy` 初始迁移成功；Redis PING 成功。真实地址和凭据仅存 `.env`，不写入本文档。
- `npm run db:validate`、`npm run check`、`npm run lint`、`npm test`（4项安全行为）、`npm run build` 已通过。构建发现动态 PKI 路径可能触发整个项目追踪，已排除本地配置/证书并明确运行时读取。
- `tests/platform.integration.ts` 对真实 Web/Gateway/Worker + 本机 Go Agent 的完整测试通过（24.8秒）：401/同源403、注册待审批、无证书TLS拒绝、审批后mTLS指标、system.info任务回传、幂等键复用、应用实例关联、主控与Agent HTTP探针及JSON映射、VIEWER拒绝、标准MCP SDK调用、空节点范围拒绝、密钥吊销、节点吊销。
- 验收资源使用唯一前缀并仅清理该次创建的ID；真实审计记录保留。不创建演示节点填充界面。
- Go 子任务 `go test -race ./...` / `go vet ./...` 通过；Linux amd64/arm64 和 macOS arm64 二进制编译通过。Linux系统运维、PTY、真实Docker/Compose、Nginx、UFW仍需隔离Linux环境执行验证。
- 浏览器已检查1280桌面与390移动布局、登录/空态；发现并修正小字对比度及导航语义。全页面非空业务交互验收仍待完成。

## 当前功能缺口（整体未完成）

- Docker stats/容器PTY、Compose编辑读取/更新状态、证书自动轮换、ACME签发/续期、HTTP自定义动作尚未闭环。
- 站点/动作/告警的编辑及停用等完整生命周期、节点升级界面、业务健康映射和拓扑布局需完善。
- 任务恢复必须继续验证Gateway/Worker重启、Agent崩溃与重复结果；不得将UNKNOWN当作明确失败。
- 部署Compose、备份恢复脚本和演练、专项Skills、全量API契约文档尚未交付。
- 权限和输入契约需继续针对聚合查询、Cron重授权、终端密钥/会话失效及跨节点探针做边界验证。
