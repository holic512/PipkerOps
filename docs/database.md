# 数据库模型与维护

以 `prisma/schema.prisma` 和 `prisma/migrations/` 为准。PostgreSQL 通过 Prisma 连接，连接串由 `prisma.config.ts` 读取；模型和迁移不包含环境凭据。

## 模块与关系

| 模块     | 主要表                                             | 关键约束                                                                            |
| -------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 身份权限 | User、Session、ApiKey                              | 角色为 ADMIN/OPERATOR/VIEWER；会话与 Key 只保存摘要，Key 限定 scope、节点及高危操作 |
| 节点接入 | EnrollmentToken、Node                              | 注册令牌限制有效期和次数；节点须审批；证书序列号/指纹唯一，私钥留在 Agent           |
| 指标     | MetricSample、MetricHourly、MetricDeviceHourly、MetricMaintenanceState | 原始采样按月分区；CPU/内存及设备小时聚合；持久维护水位                                    |
| 应用拓扑 | Application、Deployment、Dependency                | 应用独立存在；同应用/节点/类型/目标不重复；依赖禁止自引用                           |
| 探针     | Probe、ProbeResult                                 | 来源为空表示主控，否则为指定 Agent；保存 HTTP/TCP 配置、字段映射及执行身份          |
| 任务调度 | Task、TaskLog、Schedule                            | 任务持久化；日志按任务内 sequence 去重；计划保存下次执行时间和创建身份              |
| 告警审计 | AlertRule、Notification、AuditEvent                | 规则仅指向一个节点或探针；通知支持已读；审计关联身份、节点及资源                    |
| 运维资源 | Site、CustomAction                                 | 站点保存域名/上游/配置；动作保存类型、动态参数、节点范围和高危标记                  |

时间列使用 `timestamptz(3)`，API 使用 ISO 8601；分区和聚合边界统一 UTC，界面按用户时区显示。Prisma 的 `cuid()`、`@updatedAt` 由客户端生成，直接 SQL 写入须提供相应字段。

## 身份与任务

- 会话、API Key 和注册令牌仅存摘要，创建时返回原文。普通响应只选择公开字段。
- Key 的 `nodeIds=[]` 表示无节点权限，`["*"]` 才表示全部节点；统一业务层校验角色、scope、节点范围和高危操作。
- 注册在事务内校验令牌并增加使用次数、创建待审批节点；数据库 CHECK 限制使用量。获批节点须通过 mTLS 和当前授权检查，吊销后断开连接。
- Task、Schedule、Probe 保留创建 Key 的身份 ID。物理删除 Key 不清空身份；调度/分发重新授权，失效任务取消、计划或探针停用，避免退化为用户全权限。
- 任务正常状态为 `QUEUED → DISPATCHED → RUNNING → SUCCEEDED/FAILED`，另有 `CANCELLED` 和结果不明的 `UNKNOWN`。
- 默认任务非幂等且最多尝试一次，数据库 CHECK 禁止非幂等任务多次尝试。非幂等任务失联后等待 Agent journal 对账。
- `idempotencyKey` 全局唯一；业务层将入口、动作、目标和调用者纳入去重身份。Worker/Gateway 在事务中用条件更新或 `FOR UPDATE SKIP LOCKED` 领取并更新租约。
- `TaskLog(taskId,sequence)` 唯一约束支持重连日志去重。审计随任务创建写入事务，日志与审计不保存密码、令牌或完整环境变量。

## 指标与历史

`MetricSample` 按 UTC 月分区，联合主键为 `(id,recordedAt)`；每个分区继承 `(nodeId,recordedAt DESC)` B-tree 和时间 BRIN 索引。初始化创建当月与后两个月分区，DEFAULT 分区承接范围外采样。

默认保留 30 天原始采样、365 天 CPU/内存小时聚合。`MetricHourly(nodeId,bucketAt)` 保存样本数、均值和峰值，时间列有 BRIN 索引；设备1–48小时详情来自原始数据，更长窗口使用设备小时摘要及未维护原始尾部。

- CPU/内存 1–48 小时查询按请求起点动态分桶，最多 1440 点；长窗口合并小时聚合与原始小时尾部，同桶优先原始聚合，避免重复计数。
- 磁盘、网络和 IO 的详细历史查询为 1–48 小时，按选中设备返回，每个方向最多 720 点。累计字节转换为速率；计数重置或断采样超过 120 秒保留缺口。
- 设备长期查询为49–8760小时，按UTC小时对齐，最多约720桶/方向；每个桶出现任一不可靠计数区间即返回null，完整缺失小时不填零。磁盘按样本均值，网络/IO按字节差总和/有效秒数汇总，不平均各段速率。
- Linux网络身份为boot_id/ifindex/MAC，块设备为boot_id/diskseq。查询仍按网络名、IO名、挂载点选择设备；身份变化、累计值回退和>120秒断采样切断速率。缺少身份的旧网络/IO记录仅保留缺口，不能从旧数据还原设备世代；分区没有diskseq时同样不猜测。1–48小时保留旧数据兼容行为，已知身份变化仍断开。

## 后台维护

Worker 在后台调用维护函数：

```sql
SELECT pipkerops_maintain_metrics();
-- 参数为原始天数、小时聚合天数，须满足 1 <= raw <= hourly。
SELECT pipkerops_maintain_metrics(30, 365);
```

维护使用事务级 advisory lock；已有维护任务时立即跳过。`MetricMaintenanceState` 保存已聚合小时边界、成功时间和摘要。同一 UTC 日、相同参数且没有分区阻挡的成功调用会快速跳过。

1. 按持久水位增量聚合已完成小时，并回看 48 小时吸收迟到样本。首次运行或长时间停机先补聚合，再清理；不重算已经清理的不完整旧小时。
2. 按完整 UTC 小时对齐原始过期边界，删除整月过期分区，清理其余原始记录、过期小时聚合和探针结果。任务、日志和审计不自动删除。
3. 补齐当月及后两个月分区。DEFAULT 中已有对应范围记录时保留数据并返回 `blockedPartitions`，由停采维护窗口搬移后重试。
4. 聚合、清理和水位推进在同一事务中提交；失败整体回滚。`removedRawRows` 只统计 DELETE，不包含直接 DROP 分区的行数。

函数锁等待上限 5 秒，Worker 总语句超时 5 分钟；失败后退避 5 分钟并通知，分区阻挡也会通知。维护独立于任务调度。分区 DDL 会获取锁，生产仍需观察长期维护耗时和采集影响。

## 迁移与恢复

- 部署执行 `prisma migrate deploy`。迁移包含分区、CHECK 和维护函数，不能用 `db push` 替代；无需额外时序数据库或 PostgreSQL 扩展。
- 生产区分迁移与运行角色，限制 Web/Gateway/Worker 总连接数。维护函数需要相应 DDL 权限，未使用 `SECURITY DEFINER` 提权。
- 生产外部数据库连接使用 TLS 或受保护通道，实际凭据只存环境配置。
- 备份包含表、枚举、分区、函数、数据及 PKI；恢复到空目标后检查迁移、业务资源和 `UNKNOWN` 任务，见 [部署与恢复](DEPLOYMENT.md)。

## 验证范围

已有验证包含 Prisma schema 校验、隔离 PGlite 全部迁移与数据行为、实际 PostgreSQL 迁移，以及 Compose 备份恢复。运行方式：

```sh
npm run db:validate
npm test
npm run test:database
```

`npm test` 覆盖历史窗口、设备隔离/速率断点、水位、迟到回看、停机补偿、事务回滚和 DEFAULT 分区阻挡。`test:database` 使用一次性本机 PostgreSQL 17 容器，不读取 `.env`，覆盖 advisory lock、约 5 秒 DDL 锁等待及 `55P03` 回滚、`SKIP LOCKED` 并发领取。

10–50 节点长期负载、磁盘增长及生产灾备仍需部署验收，见 [开发计划](PLAN.md)。

## 设备长期聚合迁移与规模

迁移 `202610290006_device_hourly` 增加 `MetricDeviceHourly`、独立 `deviceAggregatedThrough` 水位，并替换维护函数。运行迁移本身不执行历史清理；下一次维护先从尚存原始范围回填设备摘要，再按已有策略清理，与CPU摘要、水位和分区维护同事务提交。设备版本标志让升级当天也会运行，不被当日成功快捷返回跳过。独立水位避免沿用CPU水位漏掉首次设备回填；48小时回看吸收迟到数据，已清理小时不被稀疏迟到样本覆盖。默认设备摘要保留365天，原始30天，继续使用现有PostgreSQL，无额外数据库。

每个节点每小时行数为 `挂载点数 + 2×网卡数 + 2×IO设备数`，只保存有采样的设备方向。例如8挂载点、4网卡、8IO设备为32行/节点小时，50节点一年约1402万行（50×32×24×365）；这是行数估算，实际字节、索引开销、维护扫描与长期查询延迟需部署测量，不由单节点测试外推。主键按节点/类型/设备/方向/小时定位，小时列BRIN用于过期清理；设备选择和长查询不返回完整payload。

`pipkerops_device_hours` 是维护及查询尾部共用SQL函数。摘要保存样本数、缺口数和加权分子/分母；分母为0的计数小时返回null。长查询重算水位回看范围内的实际原始尾部，同设备同小时优先尾部，避免双计数。小时内任何计数缺口会让该长窗口桶保留null，因此短窗口可能有可见片段而长窗口保守显示缺口。

本轮隔离PGlite真实SQL覆盖加权、重置、身份替换、断采样、旧数据无身份、非法计数、尾部去重、迟到回看、>原始保留期停机补偿、过期清理和失败事务回滚。独立PostgreSQL17测试通过全部迁移、真实聚合、尾部/一年查询及原有并发与锁超时检查；单节点小夹具查询低于2秒，只是测试门槛，不是容量SLA。
