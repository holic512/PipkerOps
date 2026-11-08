# API 与 MCP 契约

Web/RPC：`POST /api/rpc`，JSON `{method,params}`，成功 `{data}`，失败 `{error}`；HTTP状态区分400/401/403/404/409/422/500/502。业务接口只允许 HTTPS；反向代理保留的协议和 Host 动态决定同源地址，HTTP 返回403“请以 HTTPS 访问”。会话写请求必须与当前外部地址同源。独立API Key使用Bearer。MCP为 `/api/mcp` 标准无状态Streamable HTTP，只接受Bearer；方法中的点替换为下划线，工具参数 `{params:{...}}`。`tools/list`公开每个方法的字段/必填项/枚举/默认值，`tasks_create`按任务类型公开对应payload；与Web调用共用 `src/lib/services/contracts.ts` 输入契约。工具参数中的confirmed没有默认true，不能将工具发现视为操作者授权。

所有节点操作在服务端校验角色、scope、节点范围与高危许可。VIEWER不能写；节点接入管理、Key管理、平台审计需要ADMIN。Key空 `nodeIds`无节点权限，`["*"]`全节点。Key原文仅创建时返回一次。当前Key不能创建其他Key；持久Cron和探针保留创建Key身份并在每次调度与执行前重授权；升级前没有授权创建者的旧探针会停用，重新保存后恢复。API列表至多返回近期记录，不能当作全量数据导出。

`keys.create.scopes`只接受以下已知权限，拼写错误返回400；MCP输入Schema同步公开枚举。已有Key不因该创建校验自动变更；`*`仍受节点范围、高危许可及用户角色限制。

| 范围 | 支持的scope |
| --- | --- |
| 全部工具 | `*` |
| 节点 | `nodes:read`、`nodes:write`、`nodes:approve` |
| 长期资源 | `resources:read`、`resources:write` |
| 应用/探针 | `apps:read`、`apps:write`、`probes:read`、`probes:write` |
| 容器/文件/系统 | `docker:read`、`docker:write`、`files:read`、`files:write`、`system:read`、`system:write` |
| 站点/动作 | `sites:read`、`sites:write`、`actions:read`、`actions:write` |
| 计划/告警 | `schedules:read`、`schedules:write`、`alerts:read`、`alerts:write` |
| 任务/终端 | `tasks:read`、`tasks:write`、`terminal:write` |
| 密钥/平台 | `keys:write`、`admin:write` |

长期资源方法见 [RESOURCES.md](RESOURCES.md)：`resources.list/get/preview/register/update/rebind/associate/unlink/discover/resolve/logs/action`。Resource UUID 与实例 containerId 独立，应用通过共享资源选择器建立关系。

## 资源方法

| 方法 | 参数要点 | 权限/返回 |
| --- | --- | --- |
| users.me | 无 | 当前身份基本信息 |
| overview | 无 | nodes:read；节点/最新监控，任务计数另需tasks:read |
| nodes.list / nodes.metrics | metrics需要nodeId,hours(1–8760) | nodes:read；<=48h按窗口聚合最多1440点（不返回payload），超过为小时历史+最新原始小时桶去重合并 |
| nodes.history | nodeId,kind(disk/network/io),hours(1–8760),device? | nodes:read+目标节点；返回设备列表及选中设备；<=48小时原始详情，>48小时UTC小时摘要加原始尾部，每个方向约最多720个时间桶，磁盘为%，网络/IO为B/s；省略设备选字典序首个 |
| nodes.update | id,name,labels?,folderId? | nodes:write+目标节点；更新名称、标签和分类，省略folderId保留归属，null移至根目录 |
| nodes.move | nodeIds:[id,...],folderId:id或null | nodes:write+每个目标节点；最多100个节点，整批原子移动，保留名称、标签与历史 |
| nodeFolders.list | 无 | nodes:read；返回id,name,parentId,createdAt,updatedAt，受限Key仅见授权节点所在文件夹及祖先 |
| nodeFolders.save | id?,name,parentId? | nodes:write；创建/重命名/移动，省略parentId时新建位于根目录、更新保留原父级；拒绝同级同名和移入自身/后代 |
| nodeFolders.delete | id,confirmed:true | nodes:write；将直属节点与子文件夹提升到上一级再删除，提升后同名冲突返回409并完整回滚 |
| nodes.test | connection:{format:1,protocolVersion:1,agentId,url,caPem,accessKey,deployRoot} | nodes:approve；验证受信HTTPS及远端身份，不存凭证 |
| nodes.import | connection,id?,name?,folderId?,labels?,confirmed:true | nodes:approve高危；id指定原节点则保留历史，省略分类/标签时保留原值；访问Key独立保存 |
| nodes.revoke | id,confirmed:true | nodes:approve高危；停止连接和派发 |
| nodes.deployment | nodeId,deployRoot,component(agent/ops/scripts),confirmed:true | nodes:approve高危；验证安装标记并登记绝对目录 |
| updates.releases | 无 | nodes:approve；手动查询有新版更新清单的正式发布 |
| updates.create | nodeId,component,releaseTag,deployRoot,confirmed:true,idempotencyKey | nodes:approve高危（Ops更新另需admin:write）；返回持久更新父任务，result.executionTaskId关联实际宿主任务 |
| applications.list / save / delete | save:{id?,name,description?,labels?,businessData?}；delete:{id,confirmed:true} | apps:read/write；应用独立于节点 |
| deployments.save | id?,applicationId,nodeId,name,type,target,healthUrl?,metadata? | apps:write+目标节点；容器/Compose 关联改用resources.associate，此旧接口保留systemd/process/database/nginx；healthUrl另需probes:write并自动建立节点健康探针，null清除 |
| deployments.delete | id,confirmed:true | apps:write高危+目标节点；解除关联并删除自动健康探针，不删除实际服务 |
| dependencies.delete | id,confirmed:true | apps:write高危；删除依赖边 |
| dependencies.save | fromApplicationId,toApplicationId,type?,description? | apps:write；有向依赖 |
| probes.list / save | id?,name,type(HTTP/TCP),target,sourceNodeId?,applicationId?,intervalSeconds(10–86400),timeoutMs(100–30000),failureThreshold(1–100),enabled,config,mapping | probes:read/write；省略sourceNodeId由主控执行 |
| probes.run / history / delete | id；delete及有副作用HTTP的run另需confirmed:true | 执行返回Task；history最多500条及本窗口成功率/平均延迟 |
| topology | 无 | apps:read+nodes:read；探针/站点数据另受对应读取scope限制 |
| sites.list / save | id?,name,nodeId,domain,upstream,config? | sites:read/write；config空时生成反代及ACME challenge路径 |
| sites.apply | id,confirmed:true | sites:write高危；Nginx写入、语法检查、成功后reload，失败回滚 |
| sites.certificate / acme / renew / https | id,staging?；acme另需email；写操作confirmed:true | 生产到期信息由真实结果更新；https先检查有效证书，Web默认建立每日续期计划 |
| sites.delete | id,confirmed:true | sites:write高危；返回nginx.remove任务，受管配置删除并reload成功后才移除站点/续期计划；保留证书 |
| actions.list / save / run | save:{id?,name,type,config,parameters?,nodeIds?,confirmed:true}；run:{id,nodeId?,values,idempotencyKey?,confirmed:true} | actions:read/write；Shell/docker.action/HTTP/URL；HTTP与URL无需nodeId |
| actions.delete | id,confirmed:true | actions:write高危+原节点范围 |
| schedules.list / save / delete | save:{id?,enabled?,name,cron,timezone,taskType,nodeId?,payload,confirmed:true}；delete:{id,confirmed:true} | schedules:read/write与任务本身权限；每次执行重授权，失效停用并通知 |
| alerts.list / save | id?,enabled?,name,nodeId?或probeId?,metric,operator(gt/lt),threshold,durationSeconds,webhookUrl? | alerts:read/write；指标cpuPercent/memoryPercent/offline/probeFailure |
| alerts.delete | id,confirmed:true | alerts:write+来源节点范围 |
| notifications.list / read | read:{id} | alerts:read；仅当前用户及授权范围通知 |
| keys.list / create / revoke | create:{name,scopes,nodeIds,allowDangerous,days,confirmed:true}；revoke:{id,confirmed:true} | keys:write；API Key只能查看/吊销自身 |
| audit.list | 无 | admin:write；最多200条，Key按节点/自身过滤 |
| terminal.ticket | nodeId,containerId?,confirmed:true | terminal:write高危，容器另需docker:write；一次性60秒的同源WebSocket path |

HTTP探针公网目标必须HTTPS；私网/回环允许HTTP用于内网健康检查。HTTP探针config支持 `method`、`headers`、`body`、`expectedStatus`，mapping形如 `{version:"data.version"}`。缺少映射字段会明确失败。TCP target为 `host:port`。主控和Agent HTTP均不跟随重定向（含同来源307/308），避免自动重放有副作用请求。GET/HEAD/OPTIONS及TCP可重试；其他HTTP方法作为非幂等处理，保存及手工执行均需高危许可和confirmed:true；自动执行保留保存时的授权身份，每次重授权。业务字段来自实际响应，不生成模拟值。

节点文件夹是管理域内的共享分类，结构修改要求API Key具有全节点范围（`nodeIds:["*"]`）；受限Key的移动目标只能是其授权节点所在文件夹、这些文件夹的祖先或根目录。节点分类、标签和文件夹修改均保留审计，与数据在同一事务提交。标签沿用`labels`，输入去首尾空白并去重，最多50个、每个120字符。同级文件夹名称区分大小写，根目录也执行唯一约束；删除仅提升直属内容，不递归展开子树。

## 持久化任务

共用Web运维/动作提交在网络失败或5xx无法明确结果时提示任务可能已入队，保留当前页面同参数的原幂等键供用户显式找回；不自动重放。4xx继续显示准确权限/参数错误。页面刷新或修改参数会丢失/改变待定提交身份，不能据此盲目重提非幂等操作。

`tasks.create`：`{type,nodeId?,payload,confirmed?,idempotencyKey?}`；Key最少8最多200字符，同一身份同一键只对应相同类型/节点/规范化参数，参数变化返回409。所有远程操作返回Task，须通过 `tasks.get:{id}` / `tasks.list` 检查最终结果和日志。`tasks.list:{scheduleId?}`可筛选某计划最近100条任务，仍叠加当前scope/节点范围。任务的可空`scheduleId`由Worker写入，调用方不能通过创建参数指定；删除计划后置空但保留任务/日志/来源，旧历史不自动回填。MCP结构化任务响应保留可选字段以兼容旧数据和客户端。`tasks.cancel:{id,confirmed:true}`仅取消QUEUED。其他状态不暗示Agent停止。

| type | payload | scope | 高危 |
| --- | --- | --- | --- |
| system.info / firewall.list | {} | system:read | 否 |
| shell.exec | script,timeoutSeconds(1–300) | system:write | 是 |
| systemd.list | name?（准确服务名；省略列出全部，未加载或不存在时任务失败） | system:read | 否 |
| systemd.action | name,action(start/stop/restart/reload/enable/disable) | system:write | 是 |
| firewall.rule | action(allow/deny/reject/delete),port,protocol(tcp/udp),ruleAction?(allow/deny/reject) | system:write | 是 |
| software.install | name(nginx/docker/git/curl/wget/htop/unzip/certbot/ufw) | system:write | 是 |
| docker.list / compose.list | {} | docker:read | 否 |
| docker.inspect | id（准确容器名称或 ID）；返回 containers 详情（状态、镜像、挂载及端口，不返回环境变量和启动命令） | docker:read | 否 |
| docker.stats / docker.logs | stats:{id?}；logs:{id,tail(1–2000)} | docker:read | 否 |
| docker.action / docker.pull | action:{id,action(start/stop/restart/remove)}；pull:{image} | docker:write | action是 |
| compose.read / compose.status | project | docker:read | 否 |
| compose.deploy | project,yaml | docker:write | 是 |
| files.list / files.read | path(绝对路径) | files:read | 否 |
| files.write / mkdir / remove | path；write另需content | files:write | 是 |
| container.files.list / read | containerId,path（容器内绝对路径） | files:read + docker:read | 否 |
| container.files.write / mkdir / remove | containerId,path；write另需content | files:write + docker:write | 是 |
| nginx.check / nginx.certificate | check:{}；certificate:{domain,staging?} | sites:read | 否 |
| nginx.reload / nginx.apply / nginx.remove | reload:{}；apply:{domain,config}；remove:{domain} | sites:write | 是 |
| nginx.acme / nginx.renew | acme:{domain,email,staging?,timeoutSeconds?}；renew:{domain?,staging?,timeoutSeconds?} | sites:write | 是 |
| agent.upgrade | artifactId,sha256,restart?；制品先经受信HTTPS上传 | nodes:approve | 是 |
| deployment.update | deployRoot,artifactId,sha256 | nodes:approve | 是 |
| ops.update | deployRoot,version | admin:write+目标节点 | 是 |
| probe.run | probeId,type,target,timeoutMs,config,mapping | probes:write | 按配置；服务端重读已保存探针并验证source，不接受冒用probeId |
| http.request | url(HTTPS),method,headers?,body?,timeoutMs?,mapping?；无nodeId | actions:write | 是 |

QUEUED→DISPATCHED→RUNNING→SUCCEEDED/FAILED；失去执行证据为UNKNOWN。非幂等任务最多一次尝试，UNKNOWN等待Agent journal对账；不要换idempotencyKey盲目重提。幂等只读任务最多3次。任务日志有递增sequence去重，结果和审计持久化；Agent收到结果ACK后才完成本地清理/可选升级重启。

Compose部署先暂存并校验YAML，通过后保存配置再运行`up`。语法失败不替换原配置；运行阶段失败可能已经创建或修改资源。新Agent的结果包含`configurationSaved`、`applySucceeded`，运行失败另有`runtimeMayBePartial:true`；Web运维页和任务详情提供准确项目状态入口。保留此次尝试的配置，不自动回滚或重放，先查状态/日志，再显式修正配置。旧Agent没有这些附加标志，需升级才能得到完整恢复提示；原任务状态和结果对象保持兼容。

## Docker / Compose 直连管理

交互入口使用共享 Web/MCP 直连服务，不创建 `Task` 或 `TaskLog`。Ops 从服务端使用节点公开 CA 和私有调用凭证访问 Agent；浏览器不接触凭证。旧 Docker 任务类型保留，供已有定时计划、自定义操作和历史客户端兼容使用。

| 方法 | 输入 | 结果 |
| --- | --- | --- |
| `docker.list` | `nodeId` | `containers:[{id,name,image,state,status,ports,createdAt}]`，完整 ID |
| `docker.inspect` | `nodeId,id` | `containers`，仅返回受限详情，不包含环境变量和命令 |
| `docker.stats` | `nodeId,id?` | `containers`，保留真实 CLI 统计字段；缺采样不补零 |
| `docker.logs` | `nodeId,id,tail?`，默认200、最多2000 | `output,truncated` |
| `compose.list` | `nodeId` | `projects:[{name,status,managed}]`，合并运行项目及已保存的受管配置 |
| `compose.status/read` | `nodeId,project` | `services` / `project,yaml`；外部项目可查询状态，配置编辑限平台受管项目 |
| `docker.action` | `nodeId,id,action(start/stop/restart/remove),confirmed:true,idempotencyKey` | 独立操作记录；删除不强制停止，不删除挂载卷 |
| `docker.pull` | `nodeId,image,idempotencyKey` | 独立操作记录 |
| `compose.deploy` | `nodeId,project,yaml,confirmed:true,idempotencyKey` | 独立操作记录；YAML 上限128 KiB，与配置读取一致 |
| `docker.operations.list` | `nodeId` | 最近50条操作摘要，不附带输出正文 |
| `docker.operations.get` | `id` | 完整操作、日志和执行结果；活动/未知记录通过 Agent 快照对账 |

读取使用 `docker:read`；写入使用 `docker:write`，生命周期与 Compose 部署另需高危许可和显式确认；不依赖 `tasks:*`。所有接口继续校验角色和节点范围。MCP 同名方法以点替换为下划线，公开输入/输出结构和正确的只读标记。

写操作状态为 `REQUESTED`（请求中）、`RUNNING`、`SUCCEEDED`、`FAILED`、`UNKNOWN`；没有排队、领取或自动重试。相同请求身份只查询原记录，参数或调用者变化返回409。初始响应不代表完成，应使用返回 ID 读取操作日志。连接失败可能已发生实际操作，UNKNOWN 时先核对资源，不换键重提。

Agent 通过 `POST /v1/docker/query` 即时读取，`POST /v1/docker/operations` 立即启动写入，`GET /v1/docker/operations/:id` 返回快照。写操作在独立 `docker-operations` 目录留存身份、日志及结果；关闭页面或 HTTP 连接不取消执行。普通任务和直接操作共用四个执行位，升级独占；忙时返回409，不进入队列。

Gateway 接收 `docker.operation.started/log/result`，日志按 `(operationId,sequence)` 去重，结果持久化后回复 `docker.operation.ack`。断线恢复只重放执行证据；Agent 重启中断的操作标为 UNKNOWN，不重新执行。沿用命令输出大小上限，达到上限明确标记截断。自动列表/统计刷新不落持久操作记录；写入记录审计，不保存完整 YAML 或凭证。Agent 日志当前不自动清理，应监控状态目录容量。

页面左侧按现有文件夹选择节点，右侧同页管理容器和 Compose。列表每5秒刷新，活动操作日志每秒更新；详情展示字段及表格，配置展示 YAML，执行输出展示文本。`node/target/action` 旧链接定位资源并允许自动读取；写操作仍须用户确认。旧 Agent 返回不支持时明确提示升级，不回退到任务执行。发布顺序为 Agent 0.1.2，再迁移数据库并部署 Ops 0.1.7；配套 Skill 0.1.1 使用直连工具。

## 终端消息

获取ticket后将返回的 `path` 与浏览器当前地址组合为同源wss URL，浏览器Origin必须匹配当前外部协议及Host（含端口）。发送 `{type:"terminal.input",data}` 或 `{type:"terminal.resize",cols,rows}`；接收terminal.output(data)、terminal.exit、terminal.error。ticket一次消费；关闭、注销、会话过期、Key吊销或节点吊销会结束会话。终端内容可能含敏感信息，平台审计记录建立/结束，不把交互内容作为任务脚本自动重放。

专项技能位于 `skills/pipkerops-skill/SKILL.md`，可复制到用户技能目录使用；不会自动安装或写入外部客户端配置。

## 应用实例运维入口

应用中心的部署实例提供 Docker 详情/日志/生命周期/终端、Compose 状态/配置/部署更新、systemd 状态/管理及自定义动作入口。运维页面支持 `node`、`target`、`action` 查询参数，终端使用 `node`、`target`；Docker 页面可自动读取对应资源，写入不会自动执行；其他运维页仍只预填。切换节点后不沿用原节点目标。Docker 直接操作查看独立日志，其他任务查看任务详情；服务端照常校验角色、scope、节点范围和高危许可。

解除实例关联只移除平台关联和该实例的健康探针，不删除节点资源；确认框展示应用、实例、节点、类型及目标。已保存的运维链接仍是共用页面的参数预填，解除关联不会使其失效或自动执行；用户显式提交时继续按当前权限和实际目标执行，资源已删除则由对应直连查询或任务报告失败。

自定义动作页接收 `node`、`target`、`applicationId`、`deploymentId`，仅为动作声明的同名参数预填；用户选择动作并检查全部参数后确认执行，不猜测其他参数含义。节点选项受动作节点范围限制。

## 拓扑资源身份

`topology` 返回授权范围内长期 resources 和应用的 resources 引用，持久顶点使用 resourceId；运行实例变化不改变应用边。尚未登记的发现容器与 systemd 服务仍由 `topologyLinks` 使用准确身份展示。已登记资源只使用明确固定策略，不以采样中的容器身份替代长期身份。

Nginx 上游仅在同代理节点发起的已启用 HTTP 探针中，找到唯一应用的相同 URL origin 才关联到应用；不使用名称、DNS 猜测或跨来源回环端点匹配。此关系证明配置指向相同端点，不等于确认实际 Nginx 生效配置。无匹配或多个应用共享端点时详情显示“上游未关联”。

systemd 周期采样新增 `payload.services`，仅包含已加载的服务单元 `{name,active,sub}`，最多200项，约3秒命令超时；不读取服务环境或命令。拓扑按同节点完整单元名匹配 systemd 部署并共用顶点，只显示关联服务；不将 `nginx` 猜测为 `nginx.service`。非 systemd 主机返回空集，采集失败保留 collectionErrors。

设备长期接口不对缺采样补零；任一计数重置、身份变化或断采样会令对应长期桶返回null。旧Agent无设备身份时，网络/IO长期速率保守为空；请升级Agent后积累有效身份采样。磁盘长期使用率不依赖累计计数身份。

## MCP核心结构化输出

`nodes_list`、`nodes_metrics`、`nodes_history`、`applications_list`、`tasks_create`、`tasks_get`、`tasks_list` 的 `tools/list` 声明 `outputSchema`。成功响应同时提供 `structuredContent: {data: <业务结果>}` 与原有 `content[0].text = JSON.stringify(<业务结果>)`，现有文本客户端无需改动。日期统一JSON ISO字符串；Schema约束资源身份、任务状态/来源/尝试次数、结果对象及日志字段。`tasks_get`要求返回日志数组，即使尚无日志也返回空数组。SDK在服务端和标准客户端校验输出，未声明的方法继续使用已有文本返回。

任务创建只表示已记录执行意图，用返回ID调用 `tasks_get` 追踪到最终状态；FAILED/UNKNOWN必须检查error和日志，非幂等UNKNOWN不可盲目重提。工具错误保留isError及现有文本反馈，不伪装成成功data。结构化返回复用统一业务结果，不另建MCP业务查询或执行逻辑。

运维表单及自定义动作在当前页面实例中为尚未收到成功响应的同一请求保留幂等键，显式再次提交时可恢复已创建任务；不自动重放。成功响应后新一次操作使用新键。`actions.run`将可选幂等键传入统一任务服务，键对应的配置改变时返回409。页面重载或切换后若旧结果不明，应先在任务中心核对，不能通过新键盲目重提。任务找回不意味着重新入队，页面提示“任务已记录”，实际状态以任务详情为准。

节点指标历史输出通过resolution区分raw与hour，分别约束recordedAt/cpuPercent/memoryPercent和bucketAt/cpuAvg/memoryAvg；两种分支均声明样本数和峰值。设备历史约束单位、设备选择、方向和时间点，保留null及空集；接受PostgreSQL JSON时间的显式UTC偏移，不将缺口转换为零。标准客户端覆盖1小时和7天两种窗口。

## 系统备份

备份仅管理员可操作；API Key 还须具备 `admin:write` 与高危许可。所有创建、下载、删除均记录审计。

| 方法 | 输入与结果 |
| --- | --- |
| `backups.list` | `{}`，返回 `items` 完成归档与最近20条 `jobs`；归档含 `id/createdAt/sizeBytes/sha256` |
| `backups.create` | `{confirmed:true,idempotencyKey}`，创建 `platform.backup` 主控任务，返回任务记录；无 Agent 节点 |
| `backups.delete` | `{id:UUID,confirmed:true}`，删除持久归档，保留任务和审计历史 |
| `GET /api/backups/:id` | 认证后流式下载归档，支持管理员 Session 或合规 Bearer Key，不公开绝对文件路径 |

Worker 在实际执行前重新校验创建者权限。备份超时、失败或执行状态不明不会自动重放；页面可通过原幂等键找回任务。归档文件保存在 Docker 持久目录，更新容器不清理。离线恢复步骤见部署文档，运行中的业务接口不提供覆盖恢复。

### 远程工作台与容器文件

`/terminal` 为「远程工作台」，`/files` 保留查询参数跳转至该入口；`node` 指定节点，`target` 指定容器名称或 ID，省略 `target` 表示宿主机。文件树和活动终端共用目标，文件目录浏览不自动改变 Shell 工作目录。「在终端进入」只粘贴转义后的 `cd` 命令，等待用户回车执行。

文件操作继续通过 `tasks.create` 提交、`tasks.get` 查询结果。宿主机使用 `files.*`，容器使用独立的 `container.files.*`（Agent 0.1.3 起），不回退为宿主机任务。容器 ID 使用与终端相同的名称约束；创建及派发前同时校验文件与 Docker scope。写操作必须 `confirmed:true` 且有高危许可，提交失败沿用幂等键找回原任务；UNKNOWN 不自动重放。

目录结果为 `{path,containerId?,entries:[{name,directory,symlink,size,mode,modifiedAt}],limited}`，最多 1000 项。读取正文在任务 `output`，`result` 包含 `path`、`containerId?`、`truncated`、`binary`；最多 256 KiB，截断和非 UTF-8 文本禁止在页面编辑覆盖。写入采用同目录临时文件原子替换，权限 0600；新建目录权限 0750，删除不递归，拒绝符号链接穿越及受保护路径。

## Redis 会话与节点遥测（Ops 0.1.17 / Agent 0.1.5）

浏览器 Session 只存 Redis `pko:session:<tokenHash>`，固定 8 小时，不滑动续期。升级统一重新登录。Cookie、HTTPS 开关与同源规则保留；用户/角色/API Key 继续在 PostgreSQL 校验。会话服务不可用返回 503，不存在/过期返回 401。MCP 仍只接受独立 API Key。

新增只读方法均需要 `nodes:read`，并检查 Key 节点范围：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| nodes.get | nodeId | 单节点安全元数据、连接状态，metrics 为空数组；不读取全量节点 |
| nodes.summary | {} | 授权节点与紧凑 CPU/内存摘要；stale 表示过期/回退，payload 不携带清单 |
| nodes.monitoring | {} | 仅授权节点的集群监控投影：CPU/内存、最高容量/inode、服务/容器异常、最近采样、长期无采样和异常上下文；不返回完整清单 |
| nodes.snapshot | nodeId,category? | 分类快照及合并 payload；category 为 fast/disks/details/static/legacy，分类有 sampledAt/receivedAt/durationMs/errors/truncated/stale |
| nodes.history | nodeId,kind:metric,metric,hours(1–8760),device? | 新数值历史，设备选择、unit、bucketSeconds、series；metric 如 cpu.iowait、load.1、swap.in、disk.inodePercent、network.recvPackets、io.readIOPS、io.readLatency |

`nodes.list`、原 disk/network/io 历史继续兼容。CPU/内存允许 null，表示部分采集失败；客户端不得转成零。新数值历史单位包含 %、B、B/s、pps、/s、ms、IOPS 或无量纲空字符串；短窗口按样本均值，长窗口按小时均值显示，小时内显式空值保留缺口。吞吐累计总量/加权设备速率仍使用原设备历史接口，不从新瞬时速率图反推全窗口流量。

旧 Agent 的 `metrics` 帧及已持久化旧快照在读取时兼容转换已上报的基础数值为 `series`，保留 `legacy` 分类和原始 payload。新接收的旧采样同时写入数值历史；已有历史不自动回填。缺失/无效值不转为零，单次网络/IO 累计计数不转换为速率。CPU 各核、负载、Swap 和详细系统信息需节点实际运行支持 v2 的 Agent（0.1.5 起），Gateway 连接通过 `telemetry=2` 协商；仅更新 Ops 或版本文件不会升级远端 Agent。

`GET /api/nodes/events` 是同源 SSE 变更通知，复用 Cookie/Bearer 鉴权，按节点范围过滤，每 5 秒复核会话和当前角色；退出后关闭。`nodes` 事件仅包含 nodeId，客户端重新查询；ready/重连时全量刷新，15 秒轮询兜底，不依赖 Pub/Sub 保存事件历史。


### 节点监控告警指标

`alerts.save.metric` 新增 `diskPercent` / `inodePercent`（所有已观察文件系统的最高百分比）、`collectionFailure`（过期/失败/未采样的采集类别数）、`serviceFailure`（失败服务数）、`containerFailure`（不健康、dead/restarting、累计重启≥3 的容器数）。这些指标选择 nodeId，不选择 probeId；持续时间与阈值契约沿用现有规则。部分采集只能证明已观察到的异常，不能证明恢复；缺采样会中断未触发窗口的持续计时，已触发事件保留直到有效采样证明恢复。恢复消息与触发消息均写入通知并发送到规则配置的 HTTPS Webhook。

告警窗口通过 Redis Lua 原子评估；通知使用稳定事件 ID 幂等落库，数据库写入失败后可重新认领。Webhook 请求中的 id 是事件身份，发送后、确认前进程退出时可能重试，接收方须按 id 幂等处理。首次迁移保留旧版已触发状态，规则版本变化重置当前评估窗口；缺采样不产生恢复事件。

监控时间约定：应用 PostgreSQL 连接固定 UTC 会话，服务器默认时区不变。nodes.monitoring.lastSampleAt 指实时资源 fast/legacy 的最近采样或最近资源历史回退，不由静态清单更新推进；longMissing 按该资源采样超过 5 分钟或从未采样计算。nodes.snapshot 的 stale 按连接状态、采样及接收时间判断，分类 cacheFallback 仅说明持久快照来源，不单独表示过期。nodes.summary 的粗粒度回退提示保持兼容。
# 对象监控历史（Ops 0.1.22 / Agent 0.1.7）

Ops 0.1.24 新增只读 `updates.preview`：输入 `{releaseTag}`，沿用 nodes:approve 权限，返回 tag、name、versions（ops/agent/scripts）与实际发布中存在的 artifacts 键。版本来自验证后的正式发布清单，不依赖标题解析；下载和执行时继续重新获取清单、验证SHA-256及目标身份。更新准备过程将当前 preparationStage 与文本状态写入父任务，创建执行子任务后通过 executionTaskId 关联，不以页面时间或动画推断进度。

Agent 0.1.8 的进程 `user` 兼容原有显示字段，并可选附带真实 UID `uid` 与 `usernameResolved`。真实 UID 可读但宿主机账号库没有对应用户名时，`user` 显示 `UID <数字>`，不计入字段/分类失败；权限、读取失败及其他账号库查询错误仍报告。用户名解析缓存仅在一次运行明细采集内生效，不跨采样保留。未知 UID 不会被推断为 root。

兼容扩展 `nodes.history` 的 kind：`process`、`container`、`service`、`diagnostics`。参数包含 nodeId、metric、hours（对象最多720小时）、可选 ISO from/to（最多30天窗口）、objectIds（最多5个）。返回 unit、bucketSeconds、resolution、对象 identity、coverage/reason、retention 和 series；每对象最多1440点，点含 value、mean、maximum、validCount、gapCount、bootId。value 在缺口或跨启动分段时为 null。CPU 按单核计算，不限制100%。容器速率使用完整ID、bootId与startedAt重建基线。

`nodes.events.list`：nodeId、kind、可选准确 objectId、hours/from/to、cursor {recordedAt,id}；返回 events、nextCursor、固定查询范围和采样观察语义，每页100条。分页后应沿用首请求的 from/to。

`nodes.processWatches.list` 使用 nodes:read；save/delete 使用 nodes:write 并审计。save 必须提交 bootId、正整数pid、字符串startTicks，并在当前有效采样中匹配；delete 提交 objectId。每节点共享20个额度，返回 revision、ackRevision、ackedAt 和 watches。确认退出或PID身份改变后自动结束关注；榜外和权限失败不会结束关注。

Agent `connected` 和 `/v1/info` 可选 capabilities 包含 object-history-v1、process-watches-v1。v2帧 data 可选 historyVersion=1、processHistory（CPU Top20∪内存Top20∪关注，最多60）、watchResults、watchRevision，实时Top80边界保留。`monitoring.configure` 下发 revision/watches；`monitoring.configure.ack` 走可靠消息串行处理，每30秒重发核对，连接与变更时同步。旧Agent没有这些字段时显示需要升级。

新增 MonitoringSample / MonitoringAggregate / MonitoringEvent 独立存储，UTC每日分区，原始7天、5分钟聚合与事件30天。dirty bucket、维护水位及事务保证先聚合后清理；资源历史保留策略不变。数据库兼容迁移必须先于 Ops 发布。
