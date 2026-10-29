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

2026-10-30增量：Worker复用数据库逐节点 `LIMIT 1` 查询，同节点CPU/内存规则共用一条最新采样；离线/探针规则不读取指标历史，缺采样不补零。`test:alerts`约40秒通过：保留原Webhook回归，新增专用节点无采样、2000条相反历史值、最新CPU/内存告警及恢复断言；测试节点、规则、采样和Redis窗口按ID清理。TypeScript、ESLint、42项自动测试和生产构建通过。

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

页面验收使用独立浏览器，从应用中心逐个实例进入运维页，核对节点、目标及危险确认，提交后查看任务编号和结果，再检查离线/缺失目标/无权节点及窄屏。用户已授权代理登录，实际结果见下方浏览器验收记录。新增 docker.inspect 和 systemd.list 的 name 筛选需要部署本轮 Agent；旧 Agent 不支持新增详情任务或可能忽略筛选参数，应升级后使用。

拓扑联调现已并入 `test:linux`：创建本轮应用、Docker/Compose关联与同源节点探针，等待实际容器采样，校验准确身份、项目标签、站点端点和解除部署后的关系消失，再按本轮 ID 清理。2026-10-29 最新运行约124秒通过。纯规则测试另覆盖短ID拒绝、同名跨节点隔离、歧义上游、离线/恢复及名称刷新。页面布局与详情交互单独验收，不由规则测试替代。

本轮后续 systemd 联调约287秒完整通过：已加载服务的真实周期发现、准确单元名关联、启动/停止/恢复后的拓扑状态刷新及解除关联，UFW、软件安装，以及HTTPS升级的摘要拒绝、备份和结果ACK后systemd重启。安装检查现为独立子测试，失败仍使总套件失败，但不再阻断后续升级检查；上轮exit 100不因此改记通过。

设备长期历史增量迁移 `202610290006_device_hourly` 已在隔离PGlite、一次性PostgreSQL17及当前环境配置的数据库执行成功。迁移只新增设备小时表/水位并替换函数，历史回填与清理由后续例行维护事务执行。升级Agent后才有可证明连续性的网络/IO身份；旧采样的长期计数速率保留缺口。当前36项测试、schema校验及生产构建通过，独立数据库5项并发/设备SQL检查通过。

设备身份与长查询真实Linux复验：本轮Agent从sysfs返回非空网络身份，节点7天磁盘历史在维护前即可返回真实原始尾部；容器、Compose、拓扑、PTY和任务对账路径同时回归通过。

最新平台/MCP联调约79秒通过：真实本机Agent注册/审批/mTLS/证书轮换、任务结果、探针/计划权限及撤销；标准SDK检查五个核心工具outputSchema，执行节点/应用查询→system.info任务→tasks_get结果/日志，核对structuredContent.data与原文本一致，并验证执行Key吊销拒绝访问。客户端没有使用自建MCP替代实现。

提交响应丢失回归（本轮约84秒平台联调通过）：真实actions.run已落库后模拟调用方未收到响应，通过页面使用的提交器显式重提，返回同一任务ID；真实HTTPS目标POST计数保持1。服务端仍重查授权和当前动作配置，未自动重放任务；页面刷新后不保留内存中的恢复键，结果不明时须先查任务中心。

节点历史MCP契约补充验收：标准SDK现检查七个核心工具的outputSchema，并调用1小时/7天的nodes_metrics和nodes_history，校验结构化数据、原文本一致及正确分辨率；本次真实Agent平台套件约69秒通过，39项自动测试及生产构建通过。

## 计划执行记录验收（2026-10-30）

迁移`202610300001_schedule_task_history`增加Task可空计划关联与索引，Worker同事务记录准确来源；计划页“执行记录”进入共用任务列表，`tasks.list`可选scheduleId且保留节点授权。旧任务不回填，删除计划置空关联并保留任务和日志。当前开发库迁移成功，Web/Worker已重新生成并加载客户端；生产需评估索引DDL锁和升级所有运行进程，见数据库文档。

本次Prisma校验、TypeScript、ESLint、41项自动测试和生产构建通过，一次性PostgreSQL17全部迁移及5项维护/任务并发检查通过。新PGlite用例验证旧任务NULL、准确关联及删除保留。`SCHEDULE_TEST_NODE_ID=<授权专用节点ID> npm run test:schedules`使用真实Agent/Worker和标准MCP SDK，验证实际计划执行、筛选、无权限节点不可见、删除计划后结果可追踪；初次约14秒通过，增强授权MCP查询后约10.5秒再次通过。测试仅创建system.info任务，清理本次计划和Key，不用于生产节点。

真实浏览器另验证非法Cron、非法时区及缺少脚本参数均400拒绝并保留表单，Escape取消通过。创建专用10秒只读计划后，从执行记录进入准确筛选，65条均为该节点/CRON来源，日志入口显示成功与真实系统结果；计划已停用后删除。390px任务详情截图检查通过。搜索无匹配显示空态；后续用原生选择范围+删除键确认恢复100条，前次自动化组合键未实际选择文本，没有发现搜索逻辑缺陷。

完整Mac平台联调本轮两次分别约95/80秒失败于`approved mTLS metrics`等待，未到计划新增断言；重建Agent后仍失败，不能以专用Linux通过覆盖该失败。公开证书SAN包含localhost，抽样数据库无锁阻塞，私有Agent诊断无stderr，根因尚未确认。此前完整平台通过记录仍为历史，不改记本次通过。

后续根因与复验：Mac本机实际采集约447ms，独立Agent很快采样入库，但nodes.list约74.7秒。记录实际SQL发现Prisma嵌套关系take:1未生成LIMIT，三个节点的全部历史payload被传回再截成三条，单次指标SQL约57.7秒。现节点/拓扑/总览统一使用授权节点集合的LATERAL逐节点LIMIT 1，复用已有索引，空范围和无采样保留空数组。相同独立Mac诊断nodes.list约293ms；并行联调期间三个API单次约821/310/140ms，仅为当前开发环境测量，不是生产SLA。

修复后完整Mac平台联调约68.5秒通过，包含此前未执行到的计划关联/筛选、任务权限与标准MCP闭环。42项自动测试、TypeScript、ESLint、生产构建通过；一次性PostgreSQL17的6项检查通过，新增5000条旧payload和跨分区数据验证最新身份、节点范围、空集合与实际Limit执行计划。前两次失败保留，不因本次通过改写。临时Mac诊断节点已清理，诊断源码未入库。

## 已授权浏览器验收增量

2026-10-29用户明确允许代理使用配置的开发账户登录，使用独立agent-browser会话，不接管系统登录态。真实隔离Docker-in-Docker节点与应用Docker/Compose部署关联：从应用中心日志入口核对节点和容器，提交后看到成功日志；生命周期确认准确展示节点/容器/restart，实际重启成功；缺失容器详情任务显示失败和No such container；Compose配置读取返回真实YAML。390px截图检查表单/操作栏，axe为0违规、1个提示覆盖背景的人工对比度确认项。

修复实测问题：登录成功后完整导航清除旧401查询缓存，避免立即回登录；Docker/Compose切换仅在同类任务预填原目标；成功且无文本日志任务显示结构化结果提示而非等待Agent。TypeScript、ESLint和生产构建通过。终端连接失败反馈已看到；使专用Agent连接与票据相同的开发Gateway、并仅在隔离验收浏览器允许自签证书后，容器PTY成功，实际输入printf返回BROWSER_PTY_OK。两个真实容器PTY标签分屏显示两个Shell，截图已检查。此设置不更改系统信任或产品TLS策略；生产仍需可信证书。

2026-10-30继续使用该独立浏览器和专用节点完成以下交互。所有测试资源均独立命名，已有节点和通知未修改；密钥原文不记录到验收输出。

| 页面 | 本次实际验证 |
| --- | --- |
| 文件管理 | 确认写入`/tmp/ui-browser-file.txt`，读取返回相同标记，确认删除成功；另创建专用目录、空列表返回entries=[]/limited=false、删除后实际移除；再次列表失败并显示准确缺失路径；390px错误布局已检查 |
| 计划 | 空状态、新建停用计划、准确回填、改名、启用、停用、确认删除及空状态恢复；使用未来年度Cron和system.info，无副作用脚本 |
| 告警 | 新建、节点/指标回填、编辑、启用、停用、确认删除；CPU阈值100，不触发真实通知 |
| MCP Key | 单节点nodes:read、禁止高危、一天有效期；确认创建、一次性展示后隐藏、权限列表、确认吊销及已吊销状态；390px截图检查 |
| Key权限边界 | 隔离浏览器对本地源附加专用Bearer；docker:read缺失显示拒绝，docker:write但无高危许可的确认请求拒绝，范围外实例链接禁用并通过真实请求核对403；空范围没有节点；四个Key均未创建任务，吊销后请求401 |
| 实例动作 | 应用Docker实例进入动作页，准确预填节点与target；确认后任务日志回显同一容器目标，任务详情显示来源WEB和成功结果 |
| Compose更新 | 专用项目确认部署更新，任务输出Recreated/Started；配置/日志返回新标记、状态running；拓扑只保留新完整容器ID。后续非法YAML明确失败，原配置摘要/容器ID/运行状态保持、暂存文件移除；Escape取消前后部署任务数均4 |
| systemd入口 | 专用节点关联nginx.service，准确查询及停止/启动通过；缺失单元返回明确失败；reload/restart通过且PID变化、服务active；Enter键确认和390px确认/结果布局已检查 |
| 节点离线与恢复 | 停止专用Agent，等心跳有效期后页面显示离线并禁用提交；恢复Agent后按钮可用，真实日志任务再次成功；自然退出容器由页面启动成功 |
| 键盘 | 共用表格有可访问名称和焦点轮廓；390px下方向键使scrollLeft从0增至42，能访问横向溢出的列 |
| 拓扑 | Docker部署与准确容器合并，Compose按项目标签连到同一容器，systemd部署合并实际服务；节点失联详情变故障、恢复变正常；服务停止/启动后详情随发现更新；服务节点键盘下移5px后刷新坐标保留 |
| 站点上游 | 专用节点真实HTTP服务，同节点应用探针健康；站点配置经nginx-t/reload成功，Host请求返回上游内容；唯一端点连到应用，上游停止/恢复使应用故障/恢复；增加第二应用同源端点后不连线，删除歧义资源后唯一关联恢复 |
| 权限/会话/网络 | 临时VIEWER通过真实登录请求重启，403确认框保留错误且未创建任务；仅过期该测试会话后确认框显示401，导航回登录页；无效节点禁用提交；开发浏览器阻断RPC时显示连接错误/重试，解除阻断后定时刷新恢复列表，未计作手工重试通过 |
| 终端恢复 | 真实节点PTY执行生成独立输出标记；专用Agent停止后显示已关闭并保留旧输出；恢复Agent后显式新建票据会话，执行返回新标记；正常exit后输入控件disabled/readOnly均为true |

修复动作确认缺少实际执行位置与参数、离线禁用被误显示为“正在处理”两项反馈问题，并补齐共用表格键盘滚动入口。本次39项自动测试、TypeScript、ESLint及生产构建通过；第一次测试受沙箱IPC限制未启动，使用允许本地IPC的环境重跑通过。服务端权限路径和任务机制沿用现有实现，未用页面检查冒充完整权限矩阵。

拓扑本次修复：画布尺寸变化时重新适配，打开右侧详情后不再裁掉最右侧容器；390px纵向布局保留500px画布，避免flex将其压成2px。桌面、窄屏画布和下方详情截图已检查，尺寸适配不改资源坐标；TypeScript、ESLint、生产构建通过。缩放和平移仍可手动操作，不把默认缩略图视为窄屏所有节点文本可读。

操作切换补充修复：切换运维动作或节点清除上一项任务及提示，避免把部署结果误认为当前状态查询结果；Compose配置读取→状态切换已确认结果区清空。本次TypeScript、ESLint、生产构建通过。临时只读账户及过期会话已清理，已有账户未变更。

终端恢复补充修复：每个会话显示连接中、已连接或已关闭状态，关闭后禁用输入并提示关闭标签后显式新建；不重放旧输入。创建成功提示改为“会话已创建，请查看连接状态”，不把票据返回视为连接成功。桌面断线截图已检查，恢复后的执行标记与输入命令分离，避免只把命令回显当作成功。

站点应用与删除确认补充准确节点/域名，应用时同时展示上游，Escape取消通过。专用站点实际删除任务成功，受管配置、拓扑节点与连线均移除；页面显示结果与日志。专用探针已删除并恢复空态。TypeScript、ESLint和生产构建通过。本轮后续具体页面缺口集中维护在[验收矩阵](UI_ACCEPTANCE.md)。

文件目录验收补充发现并修复共用任务日志空态：运维页与任务详情统一按QUEUED/DISPATCHED/RUNNING/SUCCEEDED/FAILED/CANCELLED/UNKNOWN说明。实际无日志成功/失败任务已在浏览器验证，失败不再误报等待或结果待确认；成功任务保留结构化结果入口。其他状态的文案未计作逐态浏览器通过。本次39项自动测试、TypeScript、ESLint、生产构建和设计静态检查通过，专用目录已删除。

同操作重复提交补充修复：开始提交时清除上次任务ID，避免编辑参数后新请求处理中仍显示旧成功。真实reload提交中确认框busy=true时旧任务链接与结果区均不存在，随后出现新ID且执行成功；TypeScript、ESLint、生产构建和设计静态检查通过。Compose语法失败保护不代表运行阶段所有失败均可回滚，运行失败增量见下文。

Compose运行失败增量：专用项目使用已缓存alpine镜像与不存在用户，YAML校验成功后配置保存、网络和容器创建，但启动失败。新Agent结构化标志明确配置已保存/应用未成功/运行资源可能部分变化；运维页和任务详情显示恢复说明，390px截图检查通过。键盘激活准确节点/项目状态入口，查询实际created状态；显式移除错误用户后新部署成功，容器running且输出独立恢复标记。没有自动回滚或重放。Go测试、TypeScript、ESLint、生产构建和设计静态检查通过；Linux完整联调约102秒通过，新增失败/配置读回/状态查询/显式恢复断言。专用项目清理后只保留真实任务和审计记录。

告警页面增量：专用systemd节点规则先提交节点/探针指标非法组合，服务端明确拒绝且表单保留；改为CPU规则后从实际采样触发通知。页面标为已读后数据库readAt非空；修改阈值后出现恢复通知，键盘Enter完成该条已读。390px截图及文档宽度检查通过；只操作本次两条通知，删除本次规则，保留通知/审计证据。这不替代全部键盘及角色权限矩阵。

文件页面增量：隔离Docker节点创建专用文件和只读绑定目录，页面非空列表返回准确名称/大小/权限；切换操作清除旧结果。390px下Tab/Enter填写提交，确认框展示准确节点/路径；Escape取消后该路径写任务数为0。重新确认后真实写入失败，页面及键盘进入的任务详情显示read-only file system；原文件SHA-256相同，目录无临时文件，截图检查通过。最终卸载绑定并删除本次目录，保留失败任务/审计；不把只读挂载等同于所有用户/目录权限错误。

终端页面增量：两台专用节点各建PTY并执行标记；只停止已核实的Docker节点Agent，其会话关闭/禁用输入/保留输出，systemd会话继续实际执行新标记。随后恢复Agent，键盘关闭故障标签。逐一确认六条真实PTY连接后新建按钮禁用；键盘关闭活动标签恢复按钮，再次确认可建第六条。390px分屏截图、无页面横向溢出、单标签仅显示活动面板、键盘切换首尾标签自动滚入可见区域均通过。结束时关闭本轮全部终端，节点Agent继续在线；票据拒绝/会话过期仍单列待验收。

Key页面验收发现并修复：拼写错误scope曾被保存为生效但无实际能力，创建契约现限定支持枚举，Web/MCP共用；相同输入返回400且未创建记录。已有Key不自动变更，通配和空范围语义保留。运维与终端空节点提示明确检查审批与授权范围。实际页面另验证非法nodeIds对象拒绝、0/366天原生边界反馈和Escape取消；旧问题Key与四个权限测试Key均已吊销，原文临时文件已删除。标准MCP SDK检查运行中keys_create枚举及单节点查询通过；40项自动测试、TypeScript、ESLint和生产构建通过。

仍需补齐：各页面接口失败及完整角色/scope/节点范围/高危许可矩阵、终端票据/会话失效、各模块完整窄屏及键盘交互，以及站点上游和探针的完整图形异常矩阵。真实ACME、10–50节点长期采集、生产TLS/防火墙与异地灾备仍需部署条件。
