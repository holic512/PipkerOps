# 部署、备份与恢复

## Docker Compose

使用 Docker Compose v2、可解析的管理域名、可信 Web TLS 证书。Web 对外443，Agent mTLS 9443，注册与终端 TLS 9444；PostgreSQL/Redis不发布宿主端口，内部服务通过独立Compose网络访问。不要将数据库内部明文端口直接暴露公网。

1. `cp .env.example .env`，使用随机、URL安全的 `POSTGRES_PASSWORD` / `REDIS_PASSWORD` 和至少16位管理员密码。设置 `APP_ORIGIN=https://ops.example.com`、`PKI_HOSTS`、Gateway/注册 URL。真实配置与私钥已被 Git 忽略。
2. 在 `WEB_TLS_DIR` 放置可信的 `fullchain.pem` 与 `privkey.pem`。此证书用于浏览器；Agent使用初始化生成的私有CA，二者用途独立。
3. `docker compose build`，再执行 `docker compose up -d`。init执行数据库迁移、首次管理员创建和PKI初始化；不覆盖已有管理员或已有PKI。数据库与Redis健康、init成功后才启动Web/Gateway/Worker。
4. `docker compose ps` 与 `docker compose logs --tail 50 init web gateway worker proxy`，访问 `/api/health` 与登录界面。首次部署不创建任何演示资源。
5. 将CA公钥从Gateway卷安全导出到节点；不要复制CA私钥。按 [Agent说明](../agent/README.md) 编译/安装并在管理端核对审批。注册令牌仅显示一次。确认DNS SAN与连接地址一致。

Next.js、Gateway、Worker采用同一镜像。生产镜像使用非root用户；Agent为了执行受授权的系统运维任务由systemd以root托管。主控后端连接公网地址必须启用TLS；仅本地开发可显式配置 `ALLOW_INSECURE_BACKENDS=true`，生产忽略此例外。

`pki`、`postgres-data`、`redis-data`为持久卷。更换管理端镜像可以保留这些卷。不要把 `docker compose down -v` 当作升级步骤。升级前先备份，检查迁移与兼容性；数据库迁移不支持自动降级。Agent升级输入受信HTTPS地址和SHA-256；可选自动重启仅适用于实际受systemd托管的Agent，执行前排空节点任务，并保留 `.previous` 二进制供人工回滚。

## 备份

```sh
sh scripts/backup.sh /absolute/private/backups/unique-directory
```

脚本拒绝覆盖已有目录，使用0700/0600权限，生成 PostgreSQL 自定义格式dump、PKI压缩包、Redis快照及SHA-256校验。`.env`需通过独立受保护渠道备份，脚本不把密码复制到输出。备份包含用户、Key摘要、任务和CA私钥，必须私密保存。

如需一致的运维恢复点，先暂停新写入/调度并等待正在执行任务结束，再备份。PG单次dump自身事务一致，但不能把运行中的远端Shell副作用与数据库快照做分布式事务。恢复时这些执行结果必须与Agent journal对账。

脚本默认使用当前项目 `.env`；自定义位置可设置 `PIPKEROPS_ENV_FILE`，项目/文件选择沿用 `COMPOSE_PROJECT_NAME`、`COMPOSE_FILE`。示例配置不得包含真实密码。

## 恢复到全新目标

在独立Compose项目/新卷上准备相同版本镜像和受保护的 `.env`，先只启动 `postgres redis`：

```sh
docker compose up -d postgres redis
# 等待健康后，空目标恢复；脚本拒绝非空 public schema
sh scripts/restore.sh /absolute/private/backups/unique-directory --confirm-empty-target
# 核对数据库/PKI、UNKNOWN任务与Agent journal后显式启动
docker compose up -d
```

恢复保留数据库ID与私有CA；请使用原始域名或重新签发包含正确SAN的Gateway服务证书。脚本校验文件摘要，恢复PG/PKI、检查迁移，将快照中的DISPATCHED/RUNNING标记UNKNOWN；Redis只清理该栈 `pko:*` 临时键，不恢复旧票据、缓存或执行租约。浏览器Session保存在PG，原有未过期Session也随数据库恢复；需要全员重新登录时由管理员清理会话后再开放Web。不得对未知任务自动重试。

恢复拒绝非空数据库，避免覆盖已有业务数据。演练应使用独立项目和新卷；确认恢复成功后再按实际切换计划迁移流量，不在恢复脚本内自动切换域名或删除旧环境。

## 已执行的验收

2026-10-29：独立Compose项目全新PostgreSQL/Redis、迁移、PKI、非root Web/Gateway/Worker、HTTPS代理健康和安全Cookie登录通过。创建真实应用后备份，向第二个空项目恢复，重新HTTPS登录并核对原应用ID/业务字段一致。镜像检查没有本地 `.env`、CA私钥或Git目录。开发机容器验收不等同于公网域名、真实ACME或生产防火墙已完成验收。

## 平台联调

按 README 完成本地初始化，启动 Web 和默认 9443/9444 Gateway，并按 [Agent 说明](../agent/README.md) 编译本机二进制。HTTPS 测试需要 `.data/pki/server-linux.crt` 和对应私钥，缺失时运行：

```sh
npx tsx --env-file=.env scripts/dev-linux-pki.ts
```

将 Worker 的启动命令改为 `NODE_EXTRA_CA_CERTS="$PWD/.data/pki/ca.crt" npm run worker`，使其信任本地 HTTPS 夹具，再执行：

```sh
AGENT_BINARY=/absolute/path/pipkerops-agent npm run test:integration
```

测试覆盖注册审批、mTLS 采集、任务回传、应用与探针、Key 权限和 MCP，按本次创建的 ID 清理资源，保留审计。

## 隔离 Linux 联调

```sh
docker build -f tests/fixtures/Dockerfile.agent -t pipkerops-agent-fixture:local .
# 已生成开发PKI后，额外生成包含host.docker.internal SAN的本地验收证书（拒绝覆盖）
npx tsx --env-file=.env scripts/dev-linux-pki.ts
GATEWAY_HOST=0.0.0.0 GATEWAY_PORT=9543 ENROLL_PORT=9544 GATEWAY_TLS_CERT=.data/pki/server-linux.crt GATEWAY_TLS_KEY=.data/pki/server-linux.key npm run gateway
# 另一终端：指定已交叉编译Linux Agent路径
LINUX_AGENT_BINARY=/absolute/path/pipkerops-agent-linux-arm64 npm run test:linux
```

此测试使用privileged Docker-in-Docker来获得真实容器能力，不挂载宿主Docker socket或文件系统。它只删除自己创建的容器/匿名卷和数据库记录，保留审计。systemd/UFW在下面的独立Ubuntu夹具内验收。开发Gateway附加端口只应在可信开发机开放；常规部署继续使用9443/9444。

## 隔离 systemd 联调

沿用上面的Web/Gateway/Worker和9543/9544验收Gateway，运行：

```sh
docker build -f tests/fixtures/Dockerfile.systemd -t pipkerops-systemd-fixture:local .
LINUX_AGENT_BINARY=/absolute/path/pipkerops-agent-linux-arm64 npm run test:systemd
```

夹具以privileged和私有cgroup命名空间运行自己的systemd，不挂载宿主文件系统、cgroup或Docker socket。真实验证服务查询/启停/reload、UFW规则增删（不启用全局防火墙）、APT索引更新后安装htop、错误升级摘要拒绝、HTTPS二进制替换/.previous备份及结果ACK后实际systemd进程重启。只清理本次资源，审计保留。首次镜像构建和APT安装依赖可达软件源，测试上限10分钟；不接受用模拟输出替代失败结果。

2026-10-29该测试通过，用时216.9秒；Agent重启后重新接入并成功执行system.info。Linux容器/Compose/PTY/Nginx与此测试分别运行，实际ACME公网签发仍需要授权域名及DNS条件。

## 双节点连通性联调

沿用9543/9544验收Gateway与已构建的Linux夹具：

```sh
LINUX_AGENT_BINARY=/absolute/path/pipkerops-agent-linux-arm64 npm run test:connectivity
```

测试为两个独立Linux容器建立临时网络，Agent通过mTLS审批接入，分别执行A到B的HTTP/TCP和B到A的HTTP，验证JSON字段来自目标节点。停止B的Nginx后验证连续失败阈值、拓扑依赖中的真实故障结果，再启动服务确认恢复。无需privileged，不启动嵌套Docker，不挂载宿主文件；本次资源按ID清理。2026-10-29实际通过，用时37.6秒。

## 告警联调

开发Worker需使用 `NODE_EXTRA_CA_CERTS=/absolute/path/ca.crt` 信任本地HTTPS夹具，Web/Gateway/Worker运行后执行 `npm run test:alerts`。测试真实HTTP健康目标与本地HTTPS Webhook，验证连续失败、只发送一次、恢复通知、下一次故障重新发送，以及失败HTTP状态的审计记录；不会向第三方服务发消息。2026-10-29实际通过，用时26秒。

## 进程崩溃与执行对账

在可信开发环境先停止自己启动的Worker（本测试需要独占开发任务调度；不停止未知进程），保持Web运行，然后执行：

```sh
RECOVERY_WORKER_EXCLUSIVE=true AGENT_BINARY=/absolute/path/pipkerops-agent npm run test:recovery
```

测试启动并仅杀死自己的9643/9644 Gateway、Worker和本机Agent进程：Agent执行有副作用POST期间SIGKILL Gateway，结果通过Agent持久journal在重连后对账成功，实际请求计数始终1；主控POST开始后SIGKILL Worker，将本次测试任务租约设为过期后重启，任务进入UNKNOWN、attempts=1且不重放。新任务仍可执行。2026-10-29实际通过，用时21.2秒。完成后重新启动开发Worker；不对任何未知或生产进程执行kill。

## 多节点短时容量验收

```sh
CAPACITY_NODES=10 npm run test:capacity
CAPACITY_NODES=50 npm run test:capacity
```

使用真实独立Linux容器Agent；仅在开发机资源充足且9543/9544验收Gateway运行时执行，节点数限定2–50。创建独立注册令牌，审批所有节点，等待实际mTLS指标；随后向每个节点分发system.info并检查全部成功，查询真实总览。容器不需要privileged或宿主挂载。测试按本次前缀和ID清理，审计保留。

2026-10-29：10台接入/首采样13.9秒，10任务批次3.6秒，总览166ms；50台接入/首采样25.8秒，50任务批次11.5秒，总览279ms，采样87条。以上是同一开发机和当前数据库网络条件下的短时观测，包含本地容器启动与注册审批，不能外推为跨公网50台的长期SLA。

## 本轮运维入口验证（2026-10-29）

使用现有隔离 Linux 镜像、9543/9544 Gateway 和重新编译的 Agent，`test:linux` 本轮通过（约128秒），覆盖新增 docker.inspect 及资源不存在失败反馈，原有日志、Compose、生命周期、PTY 与任务对账路径。`test:systemd` 的准确 nginx.service 查询及服务操作通过，随后软件安装 exit 100 导致全套失败；未把这次记录计为完整 systemd 验收。

页面验收需用户在独立验收浏览器登录后，从应用中心逐个实例进入运维页，核对节点、目标及危险确认，提交后查看任务编号和结果；再验证离线/缺失目标/无权节点及窄屏。此项本轮待登录，不由 API 联调替代。新增 docker.inspect 和 systemd.list 的 name 筛选需要部署本轮 Agent；旧 Agent 不支持新增详情任务或可能忽略筛选参数，应升级后使用。

拓扑联调现已并入 `test:linux`：创建本轮应用、Docker/Compose关联与同源节点探针，等待实际容器采样，校验准确身份、项目标签、站点端点和解除部署后的关系消失，再按本轮 ID 清理。2026-10-29 最新运行约124秒通过。纯规则测试另覆盖短ID拒绝、同名跨节点隔离、歧义上游、离线/恢复及名称刷新。页面布局与详情交互没有用规则测试替代，仍待登录验收。

本轮后续 systemd 联调约287秒完整通过：已加载服务的真实周期发现、准确单元名关联、启动/停止/恢复后的拓扑状态刷新及解除关联，UFW、软件安装，以及HTTPS升级的摘要拒绝、备份和结果ACK后systemd重启。安装检查现为独立子测试，失败仍使总套件失败，但不再阻断后续升级检查；上轮exit 100不因此改记通过。

设备长期历史增量迁移 `202610290006_device_hourly` 已在隔离PGlite、一次性PostgreSQL17及当前环境配置的数据库执行成功。迁移只新增设备小时表/水位并替换函数，历史回填与清理由后续例行维护事务执行。升级Agent后才有可证明连续性的网络/IO身份；旧采样的长期计数速率保留缺口。当前36项测试、schema校验及生产构建通过，独立数据库5项并发/设备SQL检查通过。

设备身份与长查询真实Linux复验：本轮Agent从sysfs返回非空网络身份，节点7天磁盘历史在维护前即可返回真实原始尾部；容器、Compose、拓扑、PTY和任务对账路径同时回归通过。

最新平台/MCP联调约79秒通过：真实本机Agent注册/审批/mTLS/证书轮换、任务结果、探针/计划权限及撤销；标准SDK检查五个核心工具outputSchema，执行节点/应用查询→system.info任务→tasks_get结果/日志，核对structuredContent.data与原文本一致，并验证执行Key吊销拒绝访问。客户端没有使用自建MCP替代实现。

提交响应丢失回归（本轮约84秒平台联调通过）：真实actions.run已落库后模拟调用方未收到响应，通过页面使用的提交器显式重提，返回同一任务ID；真实HTTPS目标POST计数保持1。服务端仍重查授权和当前动作配置，未自动重放任务；页面刷新后不保留内存中的恢复键，结果不明时须先查任务中心。

节点历史MCP契约补充验收：标准SDK现检查七个核心工具的outputSchema，并调用1小时/7天的nodes_metrics和nodes_history，校验结构化数据、原文本一致及正确分辨率；本次真实Agent平台套件约69秒通过，39项自动测试及生产构建通过。
