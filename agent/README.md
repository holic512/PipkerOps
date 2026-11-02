# PipkerOps Linux Agent

独立 Go 二进制，自行提供 HTTPS/WSS 服务，由 Ops 使用导入的接入包主动连接。Agent 首次运行自动生成身份和证书，运行节点无需域名、外部证书或 Go 环境。源码构建需要 Go **1.26+**。

## 安装与接入

首次从同一 GitHub Release 获取适合节点架构的 `.tar.gz` 安装包和 `SHA256SUMS`，人工上传至节点。使用部署菜单“Agent 管理 → 安装／重新安装”校验并安装，或在已经验证安装包后运行：

```sh
sudo sh install.sh ./pipker-agent /opt/pipkerops
sudoedit /opt/pipkerops/config/agent/agent.env
sudo systemctl enable --now pipkerops-agent
```

`PIPKEROPS_URL` 填写 **Ops 可以访问的 Agent HTTPS 地址**，例如 `https://192.168.1.10:9443`。IP 和域名均可，URL 不含路径。监听地址与发布地址独立；直接由 Agent 终止 TLS，Ops 严格验证接入包中的 CA，不使用跳过验证选项。

配置位于 `<deployRoot>/config/agent/agent.env`，私有身份、任务 journal 和制品位于 `<deployRoot>/data/agent`。安装脚本将该组件合并登记到 `<deployRoot>/.pipkerops-installation.json`，保留已有 Ops 组件记录。安装不自动启动，已有配置和状态不覆盖；菜单中的启动会同时设置开机自启。运行中的重装应先停止服务。

Agent 首次运行在 `data/agent/identity/identity.json` 自动创建稳定 `agentId`、32 字节随机调用 Key、自建私有 CA 与 HTTPS 服务证书。私有目录 0700、身份文件 0600。普通启动日志和查看详情不输出 Key；使用菜单“导出接入文件”或以下显式命令导出一份接入 JSON：

```sh
sudo /usr/local/bin/pipker-agent \
  --deploy-root /opt/pipkerops \
  --url https://192.168.1.10:9443 \
  --name linux-node-01 --export-connection > connection.json
chmod 600 connection.json
```

在 Ops “添加节点”上传该 JSON，Ops 校验连接与 Agent 身份后开始纳管，无需先创建注册令牌或审批客户端证书。接入包包含 `format:1`、`protocolVersion:1`、`agentId`、`url`、`caPem`、`accessKey`、`deployRoot`。它含调用凭证，应按密钥保管；CA 私钥和服务私钥不导出。

服务证书有效期 90 天，在剩余不足 14 天时按同一 CA 和服务私钥续签，下次 TLS 握手直接使用新证书。证书覆盖配置 URL 的主机以及 `localhost`、`127.0.0.1`、`host.docker.internal`。普通启动、Agent 升级和脚本升级保持 `agentId`、CA、调用 Key 不变。地址变化后更新配置并重启，再导出当前接入包。

需要吊销已泄露的调用 Key 时，在节点停止服务后显式重置：

```sh
sudo systemctl stop pipkerops-agent
sudo /usr/local/bin/pipker-agent --deploy-root /opt/pipkerops \
  --url https://192.168.1.10:9443 --reset-key
sudo systemctl start pipkerops-agent
```

重置后重新导出并更新 Ops 中的接入信息。文件锁拒绝在 Agent 运行期间重置。重置不改变 CA 和稳定 Agent ID；丢失或删除整个 identity 目录将产生新身份，不能视作普通升级。

## 配置参数

参数优先于环境变量：

| 参数 | 环境变量 | 说明 |
| --- | --- | --- |
| `--listen` | `PIPKEROPS_LISTEN` | 默认 `0.0.0.0:9443` |
| `--url` | `PIPKEROPS_URL` | Ops 可达的 HTTPS origin，必填 |
| `--name` | `PIPKEROPS_NAME` | 默认主机名 |
| `--deploy-root` | `PIPKEROPS_DEPLOY_ROOT` | 绝对部署目录，默认当前目录 |
| `--state-dir` | `PIPKEROPS_STATE_DIR` | 默认 `<deployRoot>/data/agent` |
| `--export-connection` | — | 显式输出含 Key 的接入 JSON 后退出 |
| `--reset-key` | — | 停止 Agent 后重置 Key，可与导出选项组合 |
| `--version` | — | 显示版本后退出 |

手工命令不会自动读取 systemd 的 EnvironmentFile；部署菜单负责读取已保存配置。不要把真实配置、接入包、data 或私钥提交到 Git。

## HTTPS 接口

除健康检查外，所有接口均要求 `Authorization: Bearer <accessKey>`，不接受 URL 查询参数中的凭证：

| 接口 | 行为 |
| --- | --- |
| `GET /health` | 只返回存活状态 |
| `GET /v1/info` | `agentId,name,hostname,os,arch,agentVersion,protocolVersion:1,deployRoot` |
| `GET /v1/installation?root=<绝对目录>` | 验证安装标记，返回 `root,components,scriptsVersion` |
| `GET /v1/connect` | WebSocket 升级，首先发送 `{type:"connected",agentId}` |
| `PUT /v1/artifacts/<sha256>` | 流式接收不超过 128 MiB 的制品，哈希匹配后原子保存并返回 `{sha256,size}` |

当前保持一条 Ops 管理连接，新连接替换旧连接。连接中每 15 秒发送心跳及真实指标，标准 ping/pong 检测半开连接。Ops 在连接断开后重连；Agent 持续服务，不向 Ops 发起注册或外连。

## 构建与发布

```sh
cd agent
go mod download
go test -race ./...
cd ..
sh scripts/package-agent.sh 0.1.1 amd64
sh scripts/package-agent.sh 0.1.1 arm64
```

发布版本包含 amd64/arm64 原始 ELF、对应 `.tar.gz` 安装包和 `SHA256SUMS`。初次安装使用人工上传的安装包；纳管后的 Ops 从 GitHub 获取发布制品并校验，再通过受信 Agent HTTPS 连接分发。Agent 自身不再接受任意远程升级下载 URL。Agent 版本独立存放于 `agent/VERSION`；直接 `go build` 为 `dev`，发布构建注入版本。

## 指标

`metrics.payload` 包含 CPU/内存百分比、内存详情、文件系统使用量、逐网卡累计字节/包数、磁盘累计 IO、进程及监听端口、Docker 容器。网络/IO 为累计计数，速率应由相邻采样差值计算；Agent 不伪造瞬时速率。

单次最多返回 64 个文件系统、64 个网卡、80 个进程、256 个端口、200 个容器。进程样本不是“CPU 最高进程”排行榜。权限不足、Docker 未安装等情况写入 `collectionErrors`；失败字段不会填入模拟值。主控只有在 CPU/内存数据均有效时才可保存对应数值样本。

## Docker 直接操作

0.1.2 起，交互管理无需任务：`POST /v1/docker/query` 接收 `{method,params}`，只允许 Docker/Compose 只读方法；`POST /v1/docker/operations` 接收 `{id,method,params}`，只允许 `docker.action`、`docker.pull`、`compose.deploy`，立即执行并返回操作快照（202）。`GET /v1/docker/operations/:id` 获取进度和结果。所有入口沿用受信 HTTPS/Bearer 认证。

写操作先在 `<state-dir>/docker-operations/<id>.json` 同步保存请求摘要和执行记录，再运行；相同 ID/参数返回原记录，不同参数返回409。页面关闭、HTTP 断开后继续执行；Agent 重启时未完成记录标为 UNKNOWN，不重跑。查询不落日志文件。执行容量与普通任务共用四个槽位，升级/维护期间和容量满时直接409，不排队。

WebSocket 返回 `docker.operation.started`、`docker.operation.log`（operationId/sequence/stream/message）、`docker.operation.result`（payload 为完整快照）。Gateway 保存后发送 `docker.operation.ack`；重连回传未确认日志和结果，不进入 `tasks/` journal。输出及日志有大小限制，快照包含 `truncated`。操作日志目录当前不自动清理。

容器列表转换为有类型的资源；Compose 列表合并 `docker compose ls` 与受管配置目录，保存配置但尚无运行资源的项目仍可管理。外部项目可查状态，配置读取与更新只操作平台受管路径。旧任务协议与类型继续兼容；发布时先更新 Agent，再迁移并更新 Ops。

## 任务与持久化

下发 `{type:'task',task:{id,type,payload}}`。Agent 返回 `task.started`、带单调 `sequence` 的 `task.log`，最后返回 `task.result`（`taskId,success,output,error?,result`）。最多并行四个普通任务；Agent、Ops 和部署脚本更新独占执行，不能与其他活动任务重叠；容量不足返回 `task.busy`，该任务没有开始执行。

`tasks/<id>.json` 保存执行状态、参数摘要、前 128 条日志帧及最终结果，文件和目录均同步落盘。任务参数本身不落盘。相同任务 ID/参数只执行一次；更改参数复用 ID 会被拒绝。运行中断后结果为 `UNKNOWN`，**不会自动重试**。连接短暂断开时正在运行的任务继续执行；退出 Agent 时命令进程组被终止，未确认结果重启后仍按 UNKNOWN 处理。

完成结果会在重连后重放。Ops 持久化结果后应回复 `{type:'task.ack',taskId}`；收到确认后停止自动重放，但保留 journal 以防重复下发。当前不自动清理 journal，运维应监控状态目录容量。数据库恢复后不得复用旧任务 ID 或贸然清空 journal。

| 任务类型 | 参数 |
| --- | --- |
| `system.info` | `{}`，返回实际指标 |
| `shell.exec` | `{script,timeoutSeconds?}`，显式使用 `/bin/sh -c` |
| `probe.run` | `{probeId,type:'HTTP'\|'TCP',target,timeoutMs?,config?,mapping?}` |
| `docker.list` | `{}`，Docker CLI JSON Lines 输出 |
| `docker.stats` | `{id?}`，一次性 CPU/内存/IO 统计；result.containers 保留 Docker 原始字段 |
| `docker.action` | `{id,action:'start'\|'stop'\|'restart'\|'remove'}` |
| `docker.logs` | `{id,tail?}`，默认 200，最多 5000 行 |
| `docker.pull` | `{image}` |
| `compose.deploy` | `{project,yaml}`，先验证后写入并 `up -d --remove-orphans` |
| `compose.read` | `{project}`，返回已受管项目的 result.yaml，读取上限 128 KiB |
| `compose.status` | `{project}`，返回 result.services，允许查询已有非受管项目状态 |
| `compose.list` | `{}`，返回 result.projects，使用 `docker compose ls --all --format json` |
| `systemd.list` | `{}`，使用 systemctl JSON 输出 |
| `systemd.action` | `{name,action:'start'\|'stop'\|'restart'\|'reload'\|'enable'\|'disable'}` |
| `files.list/read/write/mkdir/remove` | `{path,content?}`，只接受绝对路径；删除不递归 |
| `nginx.check/reload` | `{}`，reload 前先做语法检查 |
| `nginx.apply` | `{domain,config}`，验证失败还原旧配置，成功后 reload |
| `nginx.remove` | `{domain}`，仅删除匹配私有受管记录的站点配置；备份后检查/reload，失败恢复并验证 |
| `nginx.acme` | `{domain,email,staging?,timeoutSeconds?}`，certbot webroot 签发，默认超时 10 分钟 |
| `nginx.certificate` | `{domain,staging?}`，只读公钥证书域名及到期时间 |
| `nginx.renew` | `{domain?,staging?,timeoutSeconds?}`，certbot renew 后检查并 reload Nginx，默认 15 分钟 |
| `firewall.list` | `{}`，使用 UFW |
| `firewall.rule` | `{action:'allow'\|'deny'\|'reject'\|'delete',port,protocol:'tcp'\|'udp',ruleAction?:'allow'\|'deny'\|'reject'}`，delete 按 ruleAction 删除，默认 allow |
| `software.install` | `{name}`，仅 nginx/git/curl/wget/htop/unzip/docker/certbot/ufw，使用 apt-get 或 dnf |
| `agent.upgrade` | `{artifactId,sha256,restart:true}`，使用已上传的本地制品，校验 SHA-256、ELF 和架构后原子替换，ACK 后重启 |
| `deployment.update` | `{deployRoot,artifactId,sha256}`，验证安装标记和本地制品后调用 `script/update_scripts.py` |
| `ops.update` | `{deployRoot,version}`，需安装标记含 Ops，调用 `script/update.py` 拉取镜像并更新 |

除 `system.info`、`probe.run` 外，所有运维任务只允许在 Linux 执行。Docker/Compose、Nginx、systemd、UFW 及软件包管理依赖相应主机工具；缺失时返回真实错误，不静默替代。APT 软件安装先 `apt-get update`，成功后才安装，复用同一任务超时并保留两步输出/实时日志；更新失败不会继续安装。DNF 使用其原有安装流程；不添加第三方软件源。

命令参数不会经 shell 拼接，只有显式 `shell.exec` 使用 shell。子进程不继承 `PIPKEROPS_*` 环境变量。默认命令超时 5 分钟，三类更新默认 30 分钟，可设置 1–3600 秒；输出最多保存 256 KiB，stdout/stderr 分别限制实时日志字节数；协议帧最大 2 MiB，结构化结果最多 1 MiB。

文件接口拒绝符号链接穿越及 Agent 状态、`/proc`、`/sys`、`/dev` 访问，不进行递归删除。它属于已授权的主机管理能力，不是用于隔离恶意本机 root 用户的安全沙箱。写文件采用原子替换、0600 权限，父目录需已存在。

HTTP 探针支持 method/headers/body/expectedStatus，限制请求体 128 KiB、响应体 1 MiB，拒绝跨来源重定向，HTTPS 校验证书。mapping 使用 `{"业务字段":"$.data.items.0.count"}` 点路径及数字数组索引；不执行 JSONPath 表达式或代码。HTTP/TCP 探针连接被指定目标，用于基础设施内部检查；Agent 与主控、升级分发始终要求 TLS。

ACME 任务依赖已安装的 certbot、正确的域名 DNS、对外 80 端口和 Nginx challenge 路由。`nginx.apply` 接收完整配置，平台生成的 HTTP server 应包含：

```nginx
location ^~ /.well-known/acme-challenge/ {
    root /var/lib/pipkerops/acme;
    default_type text/plain;
    try_files $uri =404;
}
```

生产证书由 certbot 保存于 `/etc/letsencrypt`；`staging:true` 使用独立 `/var/lib/pipkerops/acme-staging/{config,work,logs}`，避免测试证书替换生产证书。域名只接受 ASCII 完整主机名（不接受 IP/通配符），IDN 应先转 punycode。签发前检查 Nginx 语法，固定 `--cert-name domain`；签发不自动替用户重写 HTTPS 配置，主控应在证书确认后生成 443 配置并走 `nginx.apply`。查询只返回到期元数据，不返回私钥或证书正文。

`nginx.apply` 成功后，在私有状态目录 `nginx-managed/<domain>.json` 记录配置路径和 SHA-256。`nginx.remove` 只接受 `/etc/nginx/conf.d/<domain>.conf` 中与该记录一致的常规文件，拒绝符号链接、非受管配置和手工改写后的配置；旧版 Agent 写入的站点需重新 apply 一次确认接管。文件不存在时幂等成功，保留的受管摘要不会让不同内容的外部重建配置被删除。

删除前保存 0600 的 `nginx-backups/<domain>-<sha256>.conf`，删除后先 `nginx -t` 再 reload。任一步失败则恢复原文件及权限，并在独立 30 秒恢复窗口中检查和 reload；恢复失败会明确报告，不能将站点数据库记录标为删除成功。该操作不删除 ACME 证书和私钥，避免影响其他站点或续期配置。

`nginx.renew` 可按域名续期，省略 domain 则检查该存储下所有证书。`renewalChecked:true` 仅表示 certbot 检查成功，未临期证书可能无需续期；后续 Nginx 语法通过才 reload。生产签发和续期均必须由主控明确授权，本开发测试不会执行真实签发。

Agent 升级从已上传制品原子替换二进制，保留 `.previous` 副本。`restart:true` 仅接受实际运行于 Linux systemd 的 `pipkerops-agent.service` MainPID：升级前和重启前均验证，容器/手动进程或其他单元均不允许自动重启。

自动重启严格先完成任务结果的同步落盘、发送结果、接收并持久化 Ops `task.ack`，再延迟 2 秒并持久写入“一次性重启已分发”标记，最后执行 `systemctl --no-block restart pipkerops-agent.service`。重复 ACK 不会反复重启。未确认结果不会触发重启；systemd 分发失败或在标记落盘后进程中断时不自动猜测重试，应查看日志后人工重启。Agent 更新执行前排空其他活动任务，结果成功后保持维护状态直至重启；不使用 shell.exec 在结果确认前杀死 Agent。

升级把上一个二进制备份到当前可执行路径的 `.previous`，替换及备份均同步落盘，返回 `rollbackPath`。若新版本不能启动，可在节点执行：

```sh
sudo systemctl stop pipkerops-agent.service
sudo install -m 0755 /usr/local/bin/pipker-agent.previous /usr/local/bin/pipker-agent
sudo systemctl start pipkerops-agent.service
```

保留私有身份目录和任务 journal，回滚沿用当前接入包、不清空去重记录。再次升级会更新 `.previous`，应在确认新版本正常后再发起下一次升级。

Ops 更新由 Compose 外的同机 Agent 执行；更新过程中的管理连接中断不会取消任务。部署脚本完成健康检查后，Agent 持久化最终结果，等待恢复的 Ops 连接并重放。Ops 更新不等待停止前的最终 ACK，也不同时更新 Agent。若 Agent 本身或宿主中断，保留 UNKNOWN，禁止盲目重复执行更新。

## PTY

Gateway 发送顶层字段：

```json
{"type":"terminal.open","sessionId":"opaque-session-id","cols":120,"rows":32}
{"type":"terminal.open","sessionId":"container-session-id","containerId":"container-name-or-id","cols":120,"rows":32}
{"type":"terminal.input","sessionId":"opaque-session-id","data":"ls\r"}
{"type":"terminal.resize","sessionId":"opaque-session-id","cols":100,"rows":30}
{"type":"terminal.close","sessionId":"opaque-session-id"}
```

返回 `terminal.output` 的 `data`、`terminal.exit` 的 `exitCode`，失败返回 `terminal.error.error`。每个连接最多八个会话，输入每帧最多 32 KiB，窗口尺寸 2–500。断线时关闭全部 PTY 并终止进程组，不在重连后复活旧终端。

非空 `containerId` 使用独立参数执行 `docker exec -it <containerId> /bin/sh`，不拼接到 shell。容器必须已运行并含 `/bin/sh`，镜像无 shell 时会返回 Docker 的真实错误。进程及终端清理规则与主机 PTY 一致。

主控必须完成用户/API Key scope、节点权限、高危操作确认及审计校验，Agent 的调用 Key 和参数检查不替代这些校验。systemd 默认以 root 运行是为了明确授权的主机管理功能，应把平台管理权限视作节点管理员权限。

## 当前验证边界

已在 macOS 开发机使用真实本地 HTTP/TCP/TLS 服务验证 HTTPS/WSS 接入、信任拒绝、制品上传、断线重放、探针与 JSON 映射，验证 journal 去重/UNKNOWN 恢复、命令组超时、输出上限、路径保护。Linux systemd、Docker、Nginx、UFW、安装和升级需要在专用 Linux 节点进行联调；交叉编译不能代替这些系统级执行验证。

Docker/Compose 新任务通过临时 CLI fixture 验证参数及 JSON 输出结构；ACME 通过参数生成、staging 隔离、临时公钥证书到期解析和 renew/check/reload 顺序验证，未联系 ACME CA。容器 PTY 单元测试仅验证参数边界，实际 Docker/PTY 行为需主线程 Linux 隔离环境联调。

证书轮换验证临期阈值、CA/Key/Agent ID 保持不变、SAN、原子落盘失败及重启加载；升级自动重启用惰性回调验证结果/ACK/分发标记顺序及重复确认去重，测试绝不调用真实 systemd 重启。

HTTP探针与主控保持一致：拒绝自动重定向，包括同来源307/308，防止POST等请求被自动重放；如需检查最终地址，应显式配置该地址。
