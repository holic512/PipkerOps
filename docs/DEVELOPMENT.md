# 开发与验证

PipkerOps 由 Next.js Web/API、主动连接 Gateway、后台 Worker 和 Go Agent 组成。Web、MCP、Cron 复用 `src/lib/services` 的输入契约、授权与持久化任务；PostgreSQL 为任务事实来源，Redis 仅作协调与限流。非幂等任务最多尝试一次，结果不明保留 UNKNOWN，依赖 Agent journal 对账。

## 本地启动

需要 Node.js 24（项目最低22.12）、Go 1.26、PostgreSQL 17、Redis 7。开发时自行准备可达的隔离数据库与 Redis；不使用生产凭据。

```sh
npm ci
mkdir -p config
cp config/app.conf.example config/app.conf
```

编辑 `config/app.conf`，按数据库、缓存 Redis、初始管理员、持久目录、后台任务的顺序填写；不配置外部域名或旧注册网关、PKI 参数。数据库和 Redis 是否使用 TLS 仅由 `DATABASE_SSL_MODE`、`REDIS_TLS` 决定；生产同样支持 `disable`、`false`，无需额外的明文后端开关。

```sh
npm run db:generate
npm run db:deploy
npm run bootstrap
npm run dev
```

另开两个终端运行 `npm run gateway`、`npm run worker`。本地页面为 `http://127.0.0.1:3000`；HTTP 页面可打开；登录和业务接口需通过本机 HTTPS 反向代理访问。初始化不会覆盖已有管理员。Agent 本地编译和配置见 [Agent 文档](../agent/README.md)。生产配置目录和部署菜单见[部署文档](DEPLOYMENT.md)。

## 目录职责

| 目录 | 职责 |
| --- | --- |
| `src/app` | 页面及 API/MCP 入口 |
| `src/components` | 界面和交互，遵循根目录 DESIGN.md |
| `src/lib` | 配置、身份、数据库、任务、系统备份与共享业务服务 |
| `src/server` | Gateway 长连接与 Worker 调度 |
| `prisma` | 模型和只增迁移，生成客户端不手工修改 |
| `agent` | Go 采集执行端、systemd 安装、协议说明 |
| `deploy` | 主控与 Agent 管理菜单、Python 部署模块、镜像运行资源和配置模板 |
| `scripts` | 本地初始化、开发证书、凭据检查和 Agent 打包 |
| `tests` | 单元、真实 SQL、平台与 Linux 集成测试 |
| `.github/workflows` | 检查、双架构构建验收和发布 |
| `skills` | 使用本平台 MCP 的部署、监控、诊断技能 |

系统备份通过 `backups.list/create/delete` 共享服务和受保护下载路由实现。创建操作进入 `platform.backup` 持久任务，由 Worker 执行；归档与校验记录写入 `BACKUP_DIR`，不把备份二进制写回业务数据库。恢复调用同一存储服务的离线入口，不在运行中的 Web 请求里覆盖数据库。

服务端配置在运行时读取，客户端不得接触数据库凭据。容器入口用 Node 原生 env-file 加载挂载文件，不以 shell 执行配置。PostgreSQL `application_name` 标识 web/gateway/worker，便于确认连接切换；Agent 接入协议已切换为独立HTTPS服务，Ops导入接入文件后主动连接。

## 最小验证与构建

```sh
npm run db:generate
npm run db:validate
npm run check
npm run lint
npm test
npm run build
(cd agent && go test -race ./...)
node scripts/check-secrets.mjs
# 检查当前工作树的版本文件与未忽略新文件（CI 使用）
node scripts/check-secrets.mjs --all
# 本地安装包校验、菜单与部署包独立运行
python3 -m unittest discover -s tests -p '*_test.py'
```

新增核心入口维护项目文件索引；配置、私钥、备份、运行状态、生成客户端和构建产物不入库。具体数据库约束和容量测试见[数据库文档](database.md)。

```sh
# 隔离 PostgreSQL 17：全部迁移、指标维护、任务并发
npm run test:database
# 隔离 PostgreSQL 17 + 临时真实 Agent：分类、批量移动、权限、删除提升与重新接入
# 自动构建宿主机测试Agent，不连接现有业务库或节点
npm run test:node-organization
# 额外生成50节点30天摘要，非完整生产采集压力
npm run test:history-capacity
# 真实生产镜像、映射文件、外部后端与系统备份
# 不需要本地配置文件，不访问现有业务库
# 本地构建使用原生架构；CI 两个原生架构各执行一次

docker build --provenance=false -f deploy/resources/Dockerfile -t pipkerops:test .
sudo env IMAGE=pipkerops:test sh tests/deployment.integration.sh
```

部署集成测试需要 root 权限以验证 UID 10001 的目录和文件权限。测试只将部署工具复制到临时目录，使用独立配置源和运行副本，创建随机 Compose 项目、临时 PostgreSQL/Redis/registry 和证书，只清理自身资源，不读取仓库中的部署私有配置。测试包含 Python 菜单与启停更新、配置 A/B 切换、空库初始化、登录、三角色连接、错误配置、系统备份 API/Worker/持久文件、离线恢复和镜像无凭据检查。

Agent 双架构 CI 使用真实发布安装包和同目录校验文件，验证安装权限、重装保留配置状态、安装不自动启动、运行中拒绝重装，以及实际 systemd 启动、自启、重启、停止和状态菜单。测试拒绝已有 Agent 安装，使用本地测试证书和身份，不连接真实主控。

## 独立部署与页面更新验收

`npm run build` 后执行下列测试。测试自行创建临时配置、PostgreSQL、Redis、Linux Agent 和真实 HTTPS 代理，不读取已有部署配置。发布服务响应由本地文件夹具提供；制品打包、校验、分发、持久任务、Python 脚本替换和数据库操作均实际执行。

```sh
# Linux runner 使用 sudo，才能读取容器创建的 0700 私有状态目录
sudo env PATH="$PATH" MANAGED_AGENT_IMAGE=python:3.12-slim \
  node --import tsx --test tests/managed-deployment.integration.ts
```

覆盖 HTTP 登录拒绝、带端口 HTTPS 代理、独立 Agent 接入、错误 Key、任务执行、同源终端、节点凭证备份、断线恢复，以及摘要失败/本地文件冲突时不替换、成功更新脚本后配置和身份不变。同版本 Agent 更新直接报告无需更新，不生成重启任务。真实 GHCR Ops 版本升级仍需部署环境验收，不能用此发布响应夹具证明公网下载和镜像服务可达。

独立的 `npm run test:agent-upgrade` 使用 `tests/fixtures/Dockerfile.systemd` 构建的独立 systemd 镜像，构建两份不同版本号的当前 Agent，验证 HTTPS 上传、ACK 前不重启、ACK 后真实 systemd 重启与新版本心跳、身份保持和重复任务去重。该测试不依赖 Ops 或已有业务数据库，结束清理自身容器。

## 平台与 Linux 联调

以下测试会创建真实资源，需专用开发环境，不能直接指向生产节点。先启动 Web、Gateway、Worker，编译 Agent。HTTPS Webhook 夹具需要单独生成开发验收证书：

```sh
npm run pki:init
npx tsx scripts/dev-linux-pki.ts
NODE_EXTRA_CA_CERTS="$PWD/.data/pki/ca.crt" npm run worker
AGENT_BINARY=/absolute/path/pipker-agent npm run test:integration
```

Worker 使用开发 CA 信任本地 HTTPS 夹具。证书生成拒绝覆盖已有文件；这些证书仅服务于开发 HTTPS 夹具；生产 Agent 自行生成和维护身份，Ops 不签发 Agent 证书。

```sh
docker build -f tests/fixtures/Dockerfile.agent -t pipkerops-agent-fixture:local .
docker build -f tests/fixtures/Dockerfile.systemd -t pipkerops-systemd-fixture:local .
npm run gateway
```

另开终端，指定 Linux 架构 Agent：

```sh
LINUX_AGENT_BINARY=/absolute/path/pipker-agent-linux-arm64 npm run test:linux
LINUX_AGENT_BINARY=/absolute/path/pipker-agent-linux-arm64 npm run test:systemd
LINUX_AGENT_BINARY=/absolute/path/pipker-agent-linux-arm64 npm run test:connectivity
npm run test:alerts
```

| 测试 | 实际验证及前置条件 |
| --- | --- |
| `test:integration` | 真实 Agent 独立HTTPS接入、任务、探针、MCP SDK 与权限撤销 |
| `test:linux` | 独立 Docker-in-Docker 的容器/Compose/PTY/Nginx/拓扑；需要 privileged 夹具，不挂宿主 Docker socket |
| `test:systemd` | 私有 cgroup 的独立 systemd/UFW/APT/升级重启；需要 privileged 及可达软件源 |
| `test:connectivity` | 两个独立节点双向 HTTP/TCP、故障阈值与恢复 |
| `test:alerts` | 本地真实 HTTPS Webhook、去重、恢复、缺采样和最新指标；Worker 需信任夹具 CA |
| `test:schedules` | 设置 `SCHEDULE_TEST_NODE_ID` 为专用授权节点，验证计划任务、过滤、权限和删除保留 |
| `test:recovery` | 停止自己启动的 Worker 后设置 `RECOVERY_WORKER_EXCLUSIVE=true`，测试自身子进程崩溃和不重复副作用 |
| `test:capacity` | 设置 `CAPACITY_NODES=10` 或50，要求充足资源与已启动的 Gateway；短时结果不代表长期 SLA |

集成测试按自身 ID 清理资源并保留审计。软件源、域名或外部网络失败应报告真实失败，不能用模拟结果替代。不要停止未知进程；恢复测试结束后重新启动自己的开发 Worker。

## CI 与发布

工作流为 `.github/workflows/ci.yml`。每次 master 推送在检查及双架构验收成功后发布正式 Release；一次推送包含多个提交时发布目标提交。PR 和手动触发只执行检查。

Ops 版本在 `package.json`，Agent 版本在 `agent/VERSION`，部署脚本版本在 `deploy/VERSION`，Skill 版本在 `skills/VERSION`。提交前递增受影响组件的版本；CI 比较推送前后的组件源码，版本未递增时失败。Agent Markdown 文档修改不要求 Agent 升版，源码、安装文件和打包脚本变化仍需升版。Release 标题使用 `Ops v<版本> · Agent v<版本> · Scripts v<版本> · Skill v<版本>`；标签 `release-<运行编号>-<提交短哈希>` 独立于组件版本，运行编号不是组件版本，同一次运行重试复用标签。

Release 包含带各自版本的双架构 Agent 二进制和安装包、部署包、PipkerOpsSkill 包及 `SHA256SUMS`。附件直接显示实际文件名，正文记录提交信息、组件版本和各附件用途。Agent 安装包和同一 Release 的校验文件需人工上传到目标节点，再通过统一菜单安装；部署包默认拉取对应 Ops 版本镜像。GHCR 发布 Ops 版本、`edge`、`latest` 和提交 SHA 标签。双架构镜像经过原生验收后直接发布，不重新构建。标题及附件展示调整仅应用于后续发布，历史 Release 保持原状。

发布需要仓库允许工作流写入内容和 GHCR 包。首次发布需核验 Actions 权限和 GHCR 包访问设置。

本地打包示例：

```sh
sh scripts/package-agent.sh 0.1.0 amd64 /tmp/pipkerops-agent-release
sh scripts/package-agent.sh 0.1.0 arm64 /tmp/pipkerops-agent-release
```

## 当前实现与验收边界

已有节点审批与证书轮换、设备长期历史、应用实例入口、探针/告警、定时任务、Docker/Compose、systemd、文件、PTY、拓扑及 MCP 能力。API、数据库和 Agent 专题文档描述准确契约；空数据不填充演示值。

历史联调记录包括 Linux/systemd、真实 MCP SDK、崩溃对账、专用节点调度、短时10/50节点、独立 Compose 备份恢复与 SQL 容量检查。历史记录不代表本次变更已复测；每次交付只报告实际执行的结果。旧流程的内置后端部署记录不作为新外部后端部署的证明。

剩余验收：真实授权域名的 ACME 签发续期、生产 TLS/防火墙与异地灾备、10–50节点长期采集/维护耗时/公网稳定性、多 Worker/Gateway 持续运行，以及下列页面权限和异常矩阵。界面测试使用专用资源与隔离浏览器；后端测试或构建不能替代页面验收。

### 页面矩阵（历史记录，2026-10-30）

| 页面 | 已实际验证 | 尚需验证 |
| --- | --- | --- |
| 应用运维入口 | Docker日志、详情缺失失败、启动/重启确认、容器PTY；Compose配置/状态/更新；systemd状态/管理；动作准确预填；Docker入口Key缺scope/高危许可拒绝与范围外403；解除关联确认展示应用/实例/节点/目标，Esc保留关联；旧链接只预填不自动执行，显式只读查询保留容器成功 | 其他实例类型的Key拒绝路径；旧链接资源已删除时的完整反馈矩阵 |
| Docker/Compose | 专用资源和失败详情、离线恢复/无效节点；旧结果清除、VIEWER拒绝和会话过期；语法保护及取消；运行失败报告部分变化、状态查询/显式修正；390px键盘项目/YAML/确认/详情；真实部署后响应丢失同键找回原任务，1任务/attempts=1/容器ID不变 | 其他容器操作完整键盘路径；更多运行失败类型 |
| 文件管理 | 真实目录创建、写入/读回、空/非空列表、删除文件与空目录；缺失目录/只读挂载失败、摘要不变无临时文件；390px原生节点名称选择、键盘填写/Tab/Enter与Escape取消，6任务逐一核对及实际路径清理 | 其他文件系统权限错误和角色/scope/节点范围拒绝 |
| 系统服务 | 准确节点/单元查询、停止/启动、不存在单元失败；reload/restart及PID更新；专用单元enable/disable和启动失败；390px管理表单键盘选节点/填单元/选reload、取消无任务、确认真实成功及日志详情 | 其他角色/scope/节点范围拒绝 |
| 终端 | 节点/容器实际执行、双标签分屏；断线保留输出、显式新建恢复；exit禁用输入；单节点故障隔离和六会话上限；390px键盘选节点/Tab新建、取消零会话、确认真实PTY输出、键盘关闭；缺失容器明确失败/关闭/禁用输入；票据缺terminal:write/高危许可/docker:write逐项403且无票据审计；真实Key吊销/本隔离登录会话过期后PTY关闭、保留输出/禁用输入，重新登录新建恢复 | 其他角色与范围变更导致活动连接关闭；票据过期/重复消费的页面反馈 |
| 定时调度 | 新建/编辑/启停/删除；非法配置拒绝、真实执行失败及日志、删除保留任务；持久配置失效停用/通知；390px停用Docker计划键盘填写节点/类型/JSON，回填编辑、取消不保存、确认更新和删除且无任务 | 其他任务类型原生键盘选取；权限/节点离线调度失败页面反馈 |
| 告警 | 创建/编辑/启停/删除及非法来源反馈；真实CPU与离线触发/恢复、去重/键盘已读；390px停用CPU规则原生节点/指标键盘选择、阈值/时长填写、编辑回填更新、删除取消保留/确认移除且无通知；停用探针规则创建/编辑/删除、混选来源400保留原记录、切换来源清除旧引用，零通知/探测结果 | 探针规则中文指标原生键盘选取（其余填写/保存/删除键盘已验证）；其他角色/scope/节点范围拒绝 |
| MCP Key | 单节点只读/禁止高危、创建确认、原文隐藏、列表/吊销；390px表格键盘滚动；拼写错误scope在修复后拒绝、节点范围错误类型拒绝、0/366天原生边界提示；空节点范围无可访问节点；吊销后真实401及回登录；390px键盘填写名称/scope/节点/天数/高危，确认展示准确设置，Escape零创建请求 | 管理员权限不足；其他非法参数组合；窄屏键盘确认创建后的完整流程 |
| 拓扑 | 真实Docker/systemd合并、Compose项目容器；节点/服务/应用健康故障恢复；详情刷新、布局保留；站点唯一端点、歧义不连线及恢复；双节点HTTP/TCP矩阵故障恢复，未配置保持未检测；固定列序及390px方向键横滚；Enter/空格详情、Esc清除；未知Docker/Compose/systemd目标保留待确认和未关联，无猜测运行资源边；390px/1280px键盘放大/缩小/适配全部，锁定阻止方向键移动且刷新保持，解锁恢复移动且不开放手工连线 | 旧Agent缺少完整发现身份的展示；窄屏平移及其他图形键盘操作 |
| 设备历史 | 真实磁盘/网络/IO详细及7天/30天/一年查询窗口，设备/分桶/缺口一致；长期全null空态，缩短窗口恢复曲线；eth0选择跨窗口保留；390px图表方向键横滚及焦点，最近20条采样键盘展开/聚焦 | 只覆盖当前约10小时数据，不等于一年持续采集；完整键盘选择及其他角色权限拒绝 |

### 共用状态与证据边界

- 会话：真实登录成功导航、401确认框错误、重新导航回登录页已验证。临时VIEWER提交容器重启得到403且任务数为0；不是所有资源写操作的逐项授权验收。
- 终端授权：用户明确授权后创建三把仅限专用Docker节点、一天有效的临时Key。三种拒绝均无terminal.ticket审计记录；有权限的节点Shell实际执行后，Key吊销关闭PTY。仅过期本任务浏览器登录会话，PTY关闭并禁用输入，RPC返回过期401；正常表单重登后执行新标记成功。三把Key全部吊销，原文未持久化。
- Key授权：隔离浏览器仅对本地源附加专用Bearer，验证共用运维入口缺scope/高危许可拒绝、范围外节点禁用，另发真实请求确认服务端403；四个专用Key创建任务数为0。吊销后浏览器请求401，原文临时文件已移除；这不是新增Key网页登录功能。
- 查询：真实空态与非空态已见于上述页面。本地浏览器阻断RPC时显示连接错误和重试入口；恢复连接后定时刷新恢复列表。文件页独立浏览器延迟真实节点查询，确认带aria-busy的加载态再恢复选择器；中断一次查询后键盘激活重试，真实API成功、页面恢复。未扩大为所有页面均通过。
- 任务：运维页及详情真实QUEUED等待派发、CANCELLED未执行、RUNNING等待日志、成功/失败无日志均已验证；取消确认显示准确任务ID/类型/节点，Escape保留排队，确认后attempts=0/startedAt为空，运行任务完成后才显示实际输出。DISPATCHED/UNKNOWN无日志说明尚未逐态浏览器验收；非幂等未知结果不得换键盲目重提。
- 重复提交：修改同一操作参数后确认新任务，提交中旧结果/链接已清空；新任务返回后展示新ID与真实最终状态，避免旧成功留在处理中的确认框后方。
- 自定义动作：真实复现切换动作仍显示旧任务链接，现切换和开始执行均清除旧任务/URL及过期提示。同动作新请求被延迟时DOM无旧任务链接；真实提交后丢弃响应，显式同键找回原任务且attempts=1，后续独立提交产生新任务/对应日志，专用动作已清理。
- 响应丢失：系统脚本、自定义Shell动作及Compose真实提交成功后丢弃响应，确认框明确说明可能已入队及保留页面/原参数；无自动重试。显式再次确认同幂等键返回原任务，attempts=1；系统脚本另核对专用标记文件1行，Compose另核对单容器ID不变。390px提示/日志截图通过。页面刷新会失去本地待定键，提示明确警告，不扩大为其他动作类型均通过。
- 计划记录：按持久scheduleId筛选并保留节点授权；真实页面65条均为指定节点/CRON来源，日志入口打开成功系统信息结果。搜索无匹配空态及原生选择+删除后恢复100条均验证；前次自动化组合键未选中文本，不计作页面缺陷。
- 可访问性：共用表格已验证键盘横向滚动和焦点轮廓，Docker页历史axe检查为0违规/1人工确认项；不能据此宣称所有页面可访问性通过。
- 配置确认：Key展示名称、scope、节点范围及空范围/全部语义、高危许可和有效期；计划展示名称、状态、准确节点名/ID、类型、Cron/时区和参数。390px键盘取消没有创建Key/计划请求；停用计划真实创建/编辑/取消/确认/删除复验通过且零任务。长参数确认框限制在390px/1280px视口内，内部滚动后Tab能访问操作按钮。
- 响应式导航：390px关闭侧栏现从可访问树/键盘顺序隐藏，Tab从跳转链接进入菜单按钮；打开后键盘导航到拓扑并关闭、遮罩按钮键盘关闭通过。1280px主导航保持可用，缩回390px重新隐藏；未宣称打开菜单的完整焦点约束通过。
