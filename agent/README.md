# PipkerOps Linux Agent

独立 Go 二进制，主动通过 mTLS WebSocket 连接主控。当前依赖 `gopsutil/v4 v4.26.9` 要求 Go **1.26+**；开发环境使用 Go 1.26.3。运行节点不需要安装 Go。

## 编译与安装

```sh
cd agent
go mod download
go test -race ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o /tmp/pipker-agent-linux-amd64 ./cmd/pipker-agent
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags='-s -w' -o /tmp/pipker-agent-linux-arm64 ./cmd/pipker-agent
```

将对应架构的已核验二进制及本目录的安装文件复制到 Linux 节点，然后执行：

```sh
sudo sh agent/install.sh /path/to/pipker-agent-linux-amd64
sudoedit /etc/pipkerops/agent.env
# 通过可信渠道安装主控 CA 公钥证书 /etc/pipkerops/ca.pem。
sudo systemctl enable --now pipkerops-agent
sudo journalctl -u pipkerops-agent -f
```

安装脚本保留已有 `agent.env` 和状态目录，不自动开启服务。环境文件权限必须为 0600，状态目录为 0700。首次启动需要由平台创建的注册令牌，优先存入 0600 的 `/etc/pipkerops/enrollment.token`，避免作为进程参数传递；获批并获得证书后可删除令牌文件。不要将真实 `agent.env`、状态、私钥或证书提交到 Git。

参数优先于环境变量：

| 参数 | 环境变量 | 说明 |
| --- | --- | --- |
| `--gateway` | `PIPKEROPS_GATEWAY` | `wss://ops.example.com:9443/agent` |
| `--enroll-url` | `PIPKEROPS_ENROLL_URL` | `https://ops.example.com:9444`，不包含 `/enroll` |
| `--token-file` | `PIPKEROPS_TOKEN_FILE` | 优先使用的首次注册令牌文件，只接受 0600/0400 常规文件 |
| `--token` | `PIPKEROPS_TOKEN` | 兼容直接传入令牌，优先使用 token-file |
| `--name` | `PIPKEROPS_NAME` | 节点名称，默认主机名 |
| `--state-dir` | `PIPKEROPS_STATE_DIR` | 绝对路径，默认 `/var/lib/pipkerops-agent` |
| `--ca` | `PIPKEROPS_CA` | 首次信任的 CA PEM；省略时只信任系统 CA |
| `--version` | — | 显示版本 |

## 注册与通信

1. 本地生成 RSA2048 私钥及 CSR（兼容主控 node-forge PKI），分别保存为 0600 的 `agent.key`、`agent.csr`。私钥不会上传。
2. POST `/enroll` 发送 `{token,name,hostname,os,arch,agentVersion,csrPem}`，获取节点 ID。每 10 秒 POST `/enroll/status` `{token,nodeId,csrPem}` 等待审批。
3. 获批后验证证书链、私钥匹配、clientAuth 用途及证书 CN 与节点 ID 的绑定；保存公钥证书与 CA。注册 HTTPS 必须事先可信，不接受 `InsecureSkipVerify`。
4. 使用客户端证书连接 Gateway。每 15 秒发送心跳及真实指标，标准 WebSocket ping/pong 检测半开连接，读取超时 60 秒。重连采用 1–30 秒指数退避并加随机抖动。
5. 相同状态目录通过文件锁防止两个 Agent 同时运行。

已连接 Agent 在客户端证书剩余有效期不足 14 天时自动请求轮换；正常心跳中检查，每小时最多尝试一次。沿用当前私钥及 CSR，Gateway 校验当前 mTLS 身份后签发。证书过期、私钥损坏或节点长期离线错过轮换窗口时会明确失败，不自动删除身份或重新消耗注册令牌，需要重新审批/注册处理。

轮换消息精确契约：

```json
{"type":"cert.renew","requestId":"random-uuid-v4","csrPem":"existing CSR PEM"}
{"type":"cert.renewed","requestId":"same-request-id","certificatePem":"new client certificate PEM","caCertificatePem":"optional CA PEM"}
{"type":"cert.renew.error","requestId":"same-request-id","error":"reason"}
```

仅接受匹配当前请求且 15 分钟内的回复。新证书必须匹配现有私钥、节点 ID、clientAuth 用途及受信链，并延长当前到期时间。验证成功后把证书与可选 CA 一起原子保存至 `identity.json`，然后重连使用新身份；失败保持旧身份。`ca.pem` 是初次引导兼容文件，自动轮换以 `identity.json` 的 CA 为准，避免跨两个文件更新产生半完成状态。服务端应保留旧证书指纹短暂宽限期，以便“数据库已提交但回复丢失”时仍可重试获取同一张新证书；本轮协议不要求更换 CA。

## 指标

`metrics.payload` 包含 CPU/内存百分比、内存详情、文件系统使用量、逐网卡累计字节/包数、磁盘累计 IO、进程及监听端口、Docker 容器。网络/IO 为累计计数，速率应由相邻采样差值计算；Agent 不伪造瞬时速率。

单次最多返回 64 个文件系统、64 个网卡、80 个进程、256 个端口、200 个容器。进程样本不是“CPU 最高进程”排行榜。权限不足、Docker 未安装等情况写入 `collectionErrors`；失败字段不会填入模拟值。主控只有在 CPU/内存数据均有效时才可保存对应数值样本。

## 任务与持久化

下发 `{type:'task',task:{id,type,payload}}`。Agent 返回 `task.started`、带单调 `sequence` 的 `task.log`，最后返回 `task.result`（`taskId,success,output,error?,result`）。最多并行四个任务；容量不足返回 `task.busy`，该任务没有开始执行。

`tasks/<id>.json` 保存执行状态、参数摘要、前 128 条日志帧及最终结果，文件和目录均同步落盘。任务参数本身不落盘。相同任务 ID/参数只执行一次；更改参数复用 ID 会被拒绝。运行中断后结果为 `UNKNOWN`，**不会自动重试**。连接短暂断开时正在运行的任务继续执行；退出 Agent 时命令进程组被终止，未确认结果重启后仍按 UNKNOWN 处理。

完成结果会在重连后重放。Gateway 持久化结果后应回复 `{type:'task.ack',taskId}`；收到确认后停止自动重放，但保留 journal 以防重复下发。当前不自动清理 journal，运维应监控状态目录容量。数据库恢复后不得复用旧任务 ID 或贸然清空 journal。

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
| `nginx.acme` | `{domain,email,staging?,timeoutSeconds?}`，certbot webroot 签发，默认超时 10 分钟 |
| `nginx.certificate` | `{domain,staging?}`，只读公钥证书域名及到期时间 |
| `nginx.renew` | `{domain?,staging?,timeoutSeconds?}`，certbot renew 后检查并 reload Nginx，默认 15 分钟 |
| `firewall.list` | `{}`，使用 UFW |
| `firewall.rule` | `{action:'allow'\|'deny'\|'reject'\|'delete',port,protocol:'tcp'\|'udp'}`，delete 删除对应 allow 规则 |
| `software.install` | `{name}`，仅 nginx/git/curl/wget/htop/unzip/docker/certbot/ufw，使用 apt-get 或 dnf |
| `agent.upgrade` | `{url,sha256,restart?}`，仅 HTTPS，校验 SHA-256、ELF 和架构后保留回滚副本并原子替换；restart=true 时等结果持久确认后重启 |

除 `system.info`、`probe.run` 外，所有运维任务只允许在 Linux 执行。Docker/Compose、Nginx、systemd、UFW 及软件包管理依赖相应主机工具；缺失时返回真实错误，不静默替代。软件安装不自动更新包索引，也不添加第三方软件源。

命令参数不会经 shell 拼接，只有显式 `shell.exec` 使用 shell。子进程不继承 `PIPKEROPS_*` 环境变量。默认命令超时 5 分钟，可设置 1–3600 秒；输出最多保存 256 KiB，stdout/stderr 分别限制实时日志字节数；协议帧最大 2 MiB，结构化结果最多 1 MiB。

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

`nginx.renew` 可按域名续期，省略 domain 则检查该存储下所有证书。`renewalChecked:true` 仅表示 certbot 检查成功，未临期证书可能无需续期；后续 Nginx 语法通过才 reload。生产签发和续期均必须由主控明确授权，本开发测试不会执行真实签发。

升级默认只替换二进制，返回 `requiresRestart:true`，由操作者在任务成功后执行 `systemctl restart pipkerops-agent.service`。可选 `restart:true` 仅接受实际运行于 Linux systemd 的 `pipkerops-agent.service` MainPID：升级前和重启前均验证，容器/手动进程或其他单元均不允许自动重启。

自动重启严格先完成任务结果的同步落盘、发送结果、接收并持久化 Gateway `task.ack`，再延迟 2 秒并持久写入“一次性重启已分发”标记，最后执行 `systemctl --no-block restart pipkerops-agent.service`。重复 ACK 不会反复重启。未确认结果不会触发重启；systemd 分发失败或在标记落盘后进程中断时不自动猜测重试，应查看日志后人工重启。重启可能中断并行运维任务，升级前应排空节点上其他任务；不使用 shell.exec 在结果确认前杀死 Agent。

升级把上一个二进制备份到当前可执行路径的 `.previous`，替换及备份均同步落盘，返回 `rollbackPath`。若新版本不能启动，可在节点执行：

```sh
sudo systemctl stop pipkerops-agent.service
sudo install -m 0755 /usr/local/bin/pipker-agent.previous /usr/local/bin/pipker-agent
sudo systemctl start pipkerops-agent.service
```

保留私有状态目录和任务 journal，回滚不重新注册、不清空去重记录。再次升级会更新 `.previous`，应在确认新版本正常后再发起下一次升级。

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

主控必须完成用户/API Key scope、节点权限、高危操作确认及审计校验，Agent 的 mTLS 身份和参数检查不替代这些校验。systemd 默认以 root 运行是为了明确授权的主机管理功能，应把平台管理权限视作节点管理员权限。

## 当前验证边界

已在 macOS 开发机使用真实本地 HTTP/TCP/TLS 服务验证注册、信任拒绝、探针与 JSON 映射，验证 journal 去重/UNKNOWN 恢复、命令组超时、输出上限、路径保护。Linux systemd、Docker、Nginx、UFW、安装和升级需要在专用 Linux 节点进行联调；交叉编译不能代替这些系统级执行验证。

Docker/Compose 新任务通过临时 CLI fixture 验证参数及 JSON 输出结构；ACME 通过参数生成、staging 隔离、临时公钥证书到期解析和 renew/check/reload 顺序验证，未联系 ACME CA。容器 PTY 单元测试仅验证参数边界，实际 Docker/PTY 行为需主线程 Linux 隔离环境联调。

证书轮换使用临时 CA/客户端证书验证阈值、节流、请求匹配、节点/私钥/到期检查、原子落盘失败及重启加载；升级自动重启用惰性回调验证结果/ACK/分发标记顺序及重复确认去重，测试绝不调用真实 systemd 重启。
