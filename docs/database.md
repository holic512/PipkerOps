# 数据库模型与生命周期

本契约由 `prisma/schema.prisma` 定义，初始迁移位于 `prisma/migrations/202610280001_init/migration.sql`。数据库为 PostgreSQL，Prisma ORM 7 的连接串应由主项目 `prisma.config.ts` 读取环境变量；模型文件及迁移不包含主机、用户名、密码或真实业务数据。

## 模块与关系

| 模块       | 表                                  | 关键关系与约束                                                                                                                          |
| ---------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 身份与授权 | User、Session、ApiKey               | Session/API Key 只保存令牌摘要；用户角色为 ADMIN/OPERATOR/VIEWER。API Key 保留 scopes、nodeIds、allowDangerous 及吊销时间。             |
| 节点接入   | EnrollmentToken、Node               | 注册令牌限制有效期、使用次数。节点状态为 PENDING/APPROVED/REJECTED/REVOKED；证书序列号、指纹唯一。仅存 CSR 和公钥证书，私钥留在 Agent。 |
| 指标监控   | MetricSample、MetricHourly          | 原始记录包含 CPU/内存查询字段及磁盘、网络、IO、进程、端口 JSON 数据；小时聚合保留 CPU/内存均值、峰值、样本量。                          |
| 应用与拓扑 | Application、Deployment、Dependency | 应用独立存在，部署关联节点与容器/Compose/systemd 目标；有向依赖禁止自引用。同一应用的相同节点、类型及目标不可重复登记。                 |
| 多源探针   | Probe、ProbeResult                  | sourceNodeId 为空表示主控，否则表示指定 Agent。HTTP/TCP 配置、JSON 字段映射独立保存；结果按探针及时间索引。                             |
| 异步执行   | Task、TaskLog、Schedule             | Web/MCP/Cron/System 共用 Task。任务参数和结果使用 JSON；日志以任务内递增 sequence 去重。Schedule 持久化下次运行时间。                   |
| 告警审计   | AlertRule、Notification、AuditEvent | 告警规则只能指向一个节点或一个探针；审计记录可关联用户、API Key、节点及资源。通知支持已读状态。                                         |
| 运维资源   | Site、CustomAction                  | 站点保存节点、域名、上游及配置；自定义动作保存类型、动态参数定义、节点范围及高危标记。                                                  |

所有时间列为 `timestamptz(3)`。应用写入与返回使用 ISO 8601 时间；分区和聚合边界统一 UTC，UI 按用户时区展示。Prisma `cuid()` 和 `@updatedAt` 由客户端生成，直接 SQL 写入者必须显式提供 `id` 与必要的 `updatedAt`，不能假设数据库存在对应默认值。

## 接入与权限契约

- Session 的 `tokenHash`、API Key 的 `keyHash`、EnrollmentToken 的 `tokenHash` 只保存摘要，原文仅在创建时返回一次。摘要算法和随机长度由认证模块统一实现。
- `nodeIds=[]` 的含义由授权服务明确解释，不能在各入口自行把空列表当作全节点权限。角色、scope、节点范围和高危限制必须在统一业务层校验。
- 注册应在事务中检查令牌有效期及次数，再原子增加 `usedCount` 并创建 PENDING 节点。数据库 CHECK 提供最后一道使用次数边界；并发超限应返回明确业务错误。
- 只有获批节点的有效证书才可提交心跳、指标或任务结果；节点吊销应同时断开现有连接。数据库中保存的证书信息不替代 TLS 链验证及授权状态检查。
- 不向普通 Web/API 响应直接序列化 User、Session、ApiKey、EnrollmentToken 全行；显式选择公开字段。

## 持久化任务与断线恢复

任务状态为 `QUEUED → DISPATCHED → RUNNING → SUCCEEDED/FAILED`；取消为 CANCELLED，执行结果无法确认时为 UNKNOWN。

- 创建任务默认为 `idempotent=false,maxAttempts=1`。数据库 CHECK 禁止非幂等任务配置多次尝试。
- `idempotencyKey` 全局唯一，用于 HTTP 重发、MCP 重发及 Cron 重复触发去重。业务层生成时纳入入口、动作、目标及调用者等信息，防止跨调用者复用键造成越权返回。
- Worker/Gateway 应使用事务条件更新或 `FOR UPDATE SKIP LOCKED` 领取任务，同时更新 `attempts`、`leaseExpiresAt` 和分发时间。
- 非幂等任务发送后断线不能直接重新入队。标为 UNKNOWN，等待 Agent 本地执行日志对账或用户明确重新执行。
- `TaskLog(taskId,sequence)` 唯一约束允许 Agent 重连后重放日志；Gateway 应使用冲突忽略或幂等 upsert，避免重复日志使整个任务失败。
- 审计事件与任务创建应处于同一数据库事务。审计 `detail` 和日志不得包含密码、令牌或完整环境变量。

## 指标分区、索引与降采样

`MetricSample` 使用 `RANGE(recordedAt)` 按 UTC 月分区，联合主键为 `(id,recordedAt)`，符合 PostgreSQL 分区唯一约束必须覆盖分区键的要求。每个分区继承 `(nodeId,recordedAt DESC)` B-tree 及 `recordedAt` BRIN 索引。初次迁移动态创建当前月及后两个月分区，另有 DEFAULT 分区承接延迟或超出边界的记录。

`MetricHourly` 使用 `(nodeId,bucketAt)` 主键，并为时间范围清理建立 BRIN 索引。它只保存 CPU/内存的均值和最大值；磁盘、网络、IO、进程及端口的详情仅在原始保留期可查，不能用小时均值冒充原始采样。

Worker 应每日在后台执行：

```sql
SELECT pipkerops_maintain_metrics();
-- 或显式配置，原始保留天数必须 >= 1，小时保留天数必须 >= 原始天数。
SELECT pipkerops_maintain_metrics(30, 365);
```

该函数执行实际聚合与清理，采用事务级 advisory lock 防止多 Worker 同时维护：

1. 将原始保留期内已完成的 UTC 小时重算并 upsert，反映窗口内的延迟到达数据。
2. 按完整 UTC 小时对齐原始过期边界，避免下次重算时用残缺小时覆盖已有聚合。
3. 删除完全过期的月分区；清理跨边界分区及 DEFAULT 中的过期记录。返回的 `removedRawRows` 只统计 DELETE 行数，不包含被直接 DROP 的整分区行数。
4. 删除过期小时聚合及探针明细；不自动清理审计、任务或任务日志。
5. 补齐当前月及后两个月分区。如果某新分区范围已在 DEFAULT 中存在记录，则跳过该分区，继续由 DEFAULT 承接。可在停采维护窗口用事务搬移数据后创建分区，禁止在线不加锁搬移。

保留期之外的迟到原始数据会被清理，不会反向覆盖旧小时聚合。Gateway 应限制可接受的采样时钟偏移并记录时间异常。每日重新扫描最多原始保留期的小时聚合是 10–50 节点规模下的初始实现；应测量维护耗时及锁等待，再按实际需要改为带水位的增量聚合。分区维护会获取 DDL 锁，建议在低峰执行并为调用设置合理锁等待和语句超时。

## 迁移、连接与备份

- 初次部署在空库执行 `prisma migrate deploy`，不能用 `db push` 代替迁移。初始 SQL 包含 Prisma schema 无法表达的分区、CHECK 和维护函数，后续迁移需要保留这些结构。
- 不需要自动创建额外数据库或额外时序服务，也不需要 PostgreSQL 扩展。
- 生产使用独立迁移角色与受限运行角色。维护函数会创建/删除分区，调用者必须拥有相应权限；它不是 SECURITY DEFINER，不能借此隐式提升普通运行角色权限。
- 连接池应限制总连接数：Web、Gateway、Worker 分别设置上限，避免实例数乘池大小耗尽 PostgreSQL。
- `.env` 及所有含真实连接串的变体必须被 Git 忽略；示例配置只包含占位符。远程 PostgreSQL/Redis 未开启 TLS 时，需要私有网络或受保护隧道；是否启用远程服务 TLS 属于部署决策，不能在数据库建模阶段擅自修改远端配置。
- `pg_dump` 备份必须包含表结构、枚举、分区、函数和数据，恢复后执行迁移状态检查及节点/任务数量核对。恢复前应暂停 Gateway/Worker；不能把恢复操作当作普通开发迁移自动执行。

## 本次验证范围

本数据库子任务只写模型、迁移及本文档，不连接或修改真实 PostgreSQL/Redis。已实际执行：

- Prisma CLI 7.10.1 的 `validate --schema prisma/schema.prisma` 通过。
- 使用临时 PGlite（真实 PostgreSQL 引擎的本地 WASM 运行时，非生产数据库）执行完整迁移，成功创建 20 个模型表、分区、索引、外键、CHECK 和维护函数。
- 临时库中写入同小时两条监控及一条过期监控，验证均值/最大值/样本数、过期清理，以及再次维护不会产生重复聚合。
- 临时库实际拒绝非幂等任务多次重试、负数注册令牌使用量和应用自依赖。

Prisma `migrate diff --from-empty --to-schema` 在当前环境报告 `Error in Schema engine`，未获得自动 SQL 等价比较结果。真实 PostgreSQL 迁移、并发恢复和备份恢复仍需由主线程验证；上述临时测试数据不写入生产或迁移文件。

## 主线程增量验证

2026-10-29 已在用户指定空PostgreSQL执行初始迁移；随后实际执行客户端证书轮换与计划Key授权增量迁移。独立Compose空库再运行迁移成功，pg_dump/pg_restore到第二空库后应用ID和JSON业务数据一致。旧指纹仅有24小时宽限；Schedule保留创建Key ID并在调度时检查其当前状态，该字段刻意不因删除Key而清空，避免降级为用户全权限。上述真实验证补充了建模阶段的本地测试，并不表示生产灾备、长期容量和公网TLS已验收。


探针授权迁移 `202610290003_probe_authorization` 增加 `Probe.createdById/createdByApiKeyId`。这些字段刻意保留身份ID，删除Key不能通过SET NULL退化为完整用户权限；调度时重新查验用户/Key，缺失或失效则停用并通知，重新保存绑定新授权。实例健康探针与普通探针使用相同机制。


`202610290004_task_key_identity` 移除Task→ApiKey的SET NULL外键，保留创建Key ID。物理删除Key后排队任务重授权失败并取消，不降级成用户权限；标准平台联调已验证。

历史API的1–48小时窗口按请求起点做动态时间桶（最多1440点），返回均值/峰值/采样数，不传输每条进程/容器payload。更长窗口按UTC小时合并MetricHourly与原始小时尾部，同桶以仍保留的raw聚合覆盖旧摘要，避免迟到数据丢失及双计数。

`202610290005_metric_maintenance` 新增MetricMaintenanceState单行水位/成功时间/摘要。首次或长时间停机先补聚合保留期内的旧原始样本，再清理到期数据；后续只回看48小时和未处理区间，不跨已经清理的旧边界。相同保留参数同UTC日成功调用快速跳过；DEFAULT阻挡建分区时保留数据并返回blockedPartitions，可修复后重试。advisory事务锁防并发维护，函数锁等待5秒；Worker总语句超时5分钟、失败5分钟退避，后台维护不阻塞任务调度，并通知维护失败/分区阻挡。

隔离PGlite执行全部6个迁移，验证完整1/24/48小时（11520条15秒样本）、长窗去重/尾部、删除Key身份保留、同日skip、迟到回看、短保留边界、120天停机补偿、事务失败不推进水位和DEFAULT阻挡/修复。并发DDL锁等待耗时与50节点长期负载尚需实际部署压测。
