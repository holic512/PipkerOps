# API 与 MCP 契约

Web/RPC：`POST /api/rpc`，JSON `{method,params}`，成功 `{data}`，失败 `{error}`；HTTP状态区分401/403/400/404/409/500。会话写请求必须与 `APP_ORIGIN` 同源。独立API Key使用Bearer。MCP为 `/api/mcp` 标准无状态Streamable HTTP，只接受Bearer；方法中的点替换为下划线，工具参数 `{params:{...}}`。`tools/list`公开每个方法的字段/必填项/枚举/默认值，`tasks_create`按任务类型公开对应payload；与Web调用共用 `src/lib/services/contracts.ts` 输入契约。工具参数中的confirmed没有默认true，不能将工具发现视为操作者授权。

所有节点操作在服务端校验角色、scope、节点范围与高危许可。VIEWER不能写；节点审批、Key管理、平台审计需要ADMIN。Key空 `nodeIds`无节点权限，`["*"]`全节点。Key原文仅创建时返回一次。当前Key不能创建其他Key；持久Cron和探针保留创建Key身份并在每次调度与执行前重授权；升级前没有授权创建者的旧探针会停用，重新保存后恢复。API列表至多返回近期记录，不能当作全量数据导出。

## 资源方法

| 方法 | 参数要点 | 权限/返回 |
| --- | --- | --- |
| users.me | 无 | 当前身份基本信息 |
| overview | 无 | nodes:read；节点/最新监控，任务计数另需tasks:read |
| nodes.list / nodes.metrics | metrics需要nodeId,hours(1–8760) | nodes:read；<=48h按窗口聚合最多1440点（不返回payload），超过为小时历史+最新原始小时桶去重合并 |
| nodes.history | nodeId,kind(disk/network/io),hours(1–48),device? | nodes:read+目标节点；返回设备列表及选中设备，每个方向最多720个时间桶，磁盘为%，网络/IO为B/s；省略设备选字典序首个 |
| nodes.update | id,name,labels? | nodes:write+目标节点；更新名称和标签 |
| nodes.token | name,maxUses(1–50),hours(1–168) | nodes:approve；单次返回token/gateway/enrollUrl |
| nodes.approve / reject / revoke | id,confirmed:true | nodes:approve；审批签发mTLS，吊销断开 |
| applications.list / save / delete | save:{id?,name,description?,labels?,businessData?}；delete:{id,confirmed:true} | apps:read/write；应用独立于节点 |
| deployments.save | id?,applicationId,nodeId,name,type,target,healthUrl?,metadata? | apps:write+目标节点；type为docker/compose/systemd/process/database/nginx；healthUrl另需probes:write并自动建立节点健康探针，null清除 |
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
| actions.list / save / run | save:{id?,name,type,config,parameters?,nodeIds?,confirmed:true}；run:{id,nodeId?,values,confirmed:true} | actions:read/write；Shell/docker.action/HTTP/URL；HTTP与URL无需nodeId |
| actions.delete | id,confirmed:true | actions:write高危+原节点范围 |
| schedules.list / save / delete | save:{id?,enabled?,name,cron,timezone,taskType,nodeId?,payload,confirmed:true}；delete:{id,confirmed:true} | schedules:read/write与任务本身权限；每次执行重授权，失效停用并通知 |
| alerts.list / save | id?,enabled?,name,nodeId?或probeId?,metric,operator(gt/lt),threshold,durationSeconds,webhookUrl? | alerts:read/write；指标cpuPercent/memoryPercent/offline/probeFailure |
| alerts.delete | id,confirmed:true | alerts:write+来源节点范围 |
| notifications.list / read | read:{id} | alerts:read；仅当前用户及授权范围通知 |
| keys.list / create / revoke | create:{name,scopes,nodeIds,allowDangerous,days,confirmed:true}；revoke:{id,confirmed:true} | keys:write；API Key只能查看/吊销自身 |
| audit.list | 无 | admin:write；最多200条，Key按节点/自身过滤 |
| terminal.ticket | nodeId,containerId?,confirmed:true | terminal:write高危，容器另需docker:write；一次性60秒TLS WebSocket URL |

HTTP探针公网目标必须HTTPS；私网/回环允许HTTP用于内网健康检查。HTTP探针config支持 `method`、`headers`、`body`、`expectedStatus`，mapping形如 `{version:"data.version"}`。缺少映射字段会明确失败。TCP target为 `host:port`。主控和Agent HTTP均不跟随重定向（含同来源307/308），避免自动重放有副作用请求。GET/HEAD/OPTIONS及TCP可重试；其他HTTP方法作为非幂等处理，保存及手工执行均需高危许可和confirmed:true；自动执行保留保存时的授权身份，每次重授权。业务字段来自实际响应，不生成模拟值。

## 持久化任务

`tasks.create`：`{type,nodeId?,payload,confirmed?,idempotencyKey?}`；Key最少8最多200字符，同一身份同一键只对应相同类型/节点/规范化参数，参数变化返回409。所有远程操作返回Task，须通过 `tasks.get:{id}` / `tasks.list` 检查最终结果和日志。`tasks.cancel:{id,confirmed:true}`仅取消QUEUED。其他状态不暗示Agent停止。

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
| nginx.check / nginx.certificate | check:{}；certificate:{domain,staging?} | sites:read | 否 |
| nginx.reload / nginx.apply / nginx.remove | reload:{}；apply:{domain,config}；remove:{domain} | sites:write | 是 |
| nginx.acme / nginx.renew | acme:{domain,email,staging?,timeoutSeconds?}；renew:{domain?,staging?,timeoutSeconds?} | sites:write | 是 |
| agent.upgrade | url(HTTPS),sha256,restart? | nodes:approve | 是 |
| probe.run | probeId,type,target,timeoutMs,config,mapping | probes:write | 按配置；服务端重读已保存探针并验证source，不接受冒用probeId |
| http.request | url(HTTPS),method,headers?,body?,timeoutMs?,mapping?；无nodeId | actions:write | 是 |

QUEUED→DISPATCHED→RUNNING→SUCCEEDED/FAILED；失去执行证据为UNKNOWN。非幂等任务最多一次尝试，UNKNOWN等待Agent journal对账；不要换idempotencyKey盲目重提。幂等只读任务最多3次。任务日志有递增sequence去重，结果和审计持久化；Agent收到结果ACK后才完成本地清理/可选升级重启。

## 终端消息

获取ticket后连接返回的wss URL，浏览器Origin必须匹配APP_ORIGIN。发送 `{type:"terminal.input",data}` 或 `{type:"terminal.resize",cols,rows}`；接收terminal.output(data)、terminal.exit、terminal.error。ticket一次消费；关闭、注销、会话过期、Key吊销或节点吊销会结束会话。终端内容可能含敏感信息，平台审计记录建立/结束，不把交互内容作为任务脚本自动重放。

专项技能位于 `skills/pipkerops-{deploy,monitor,troubleshoot}/SKILL.md`，可复制到用户技能目录使用；不会自动安装或写入外部客户端配置。

## 应用实例运维入口

应用中心的部署实例提供 Docker 详情/日志/生命周期/终端、Compose 状态/配置/部署更新、systemd 状态/管理及自定义动作入口。运维页面支持 `node`、`target`、`action` 查询参数，终端使用 `node`、`target`；参数只预填，不触发执行。切换节点后不继续预填原节点目标。任务入队后查看页面结果或任务详情；服务端照常校验角色、scope、节点范围和高危许可。

自定义动作页接收 `node`、`target`、`applicationId`、`deploymentId`，仅为动作声明的同名参数预填；用户选择动作并检查全部参数后确认执行，不猜测其他参数含义。节点选项受动作节点范围限制。

## 拓扑资源身份

`topology` 继续返回授权范围内原始资源；界面用共用 `topologyLinks` 计算关系，不新增持久化猜测边。Docker 仅匹配同节点完整 ID 或准确名称（可去除名称前导 `/`）；Compose 使用 `com.docker.compose.project` 的准确标签。Docker 匹配后共用发现容器顶点，Compose 保留项目顶点和成员边。容器数据使用最新采样，最多沿用 Agent 的200容器采集上限，不再只显示前12个。

Nginx 上游仅在同代理节点发起的已启用 HTTP 探针中，找到唯一应用的相同 URL origin 才关联到应用；不使用名称、DNS 猜测或跨来源回环端点匹配。此关系证明配置指向相同端点，不等于确认实际 Nginx 生效配置。无匹配或多个应用共享端点时详情显示“上游未关联”。

systemd 周期采样新增 `payload.services`，仅包含已加载的服务单元 `{name,active,sub}`，最多200项，约3秒命令超时；不读取服务环境或命令。拓扑按同节点完整单元名匹配 systemd 部署并共用顶点，只显示关联服务；不将 `nginx` 猜测为 `nginx.service`。非 systemd 主机返回空集，采集失败保留 collectionErrors。
