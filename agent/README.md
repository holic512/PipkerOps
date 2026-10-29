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

证书过期或私钥损坏会明确失败，不自动删除身份或重新消耗注册令牌。当前未实现证书自动轮换，需通过审批/重新注册流程处理。

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
| `docker.action` | `{id,action:'start'\|'stop'\|'restart'\|'remove'}` |
| `docker.logs` | `{id,tail?}`，默认 200，最多 5000 行 |
| `docker.pull` | `{image}` |
| `compose.deploy` | `{project,yaml}`，先验证后写入并 `up -d --remove-orphans` |
| `systemd.list` | `{}`，使用 systemctl JSON 输出 |
| `systemd.action` | `{name,action:'start'\|'stop'\|'restart'\|'reload'\|'enable'\|'disable'}` |
| `files.list/read/write/mkdir/remove` | `{path,content?}`，只接受绝对路径；删除不递归 |
| `nginx.check/reload` | `{}`，reload 前先做语法检查 |
| `nginx.apply` | `{domain,config}`，验证失败还原旧配置，成功后 reload |
| `firewall.list` | `{}`，使用 UFW |
| `firewall.rule` | `{action:'allow'\|'deny'\|'reject'\|'delete',port,protocol:'tcp'\|'udp'}`，delete 删除对应 allow 规则 |
| `software.install` | `{name}`，仅 nginx/git/curl/wget/htop/unzip/docker/certbot/ufw，使用 apt-get 或 dnf |
| `agent.upgrade` | `{url,sha256}`，仅 HTTPS，校验 SHA-256、ELF 和架构后原子替换；返回 `requiresRestart:true` |

除 `system.info`、`probe.run` 外，所有运维任务只允许在 Linux 执行。Docker/Compose、Nginx、systemd、UFW 及软件包管理依赖相应主机工具；缺失时返回真实错误，不静默替代。软件安装不自动更新包索引，也不添加第三方软件源。

命令参数不会经 shell 拼接，只有显式 `shell.exec` 使用 shell。子进程不继承 `PIPKEROPS_*` 环境变量。默认命令超时 5 分钟，可设置 1–3600 秒；输出最多保存 256 KiB，stdout/stderr 分别限制实时日志字节数；协议帧最大 2 MiB，结构化结果最多 1 MiB。

文件接口拒绝符号链接穿越及 Agent 状态、`/proc`、`/sys`、`/dev` 访问，不进行递归删除。它属于已授权的主机管理能力，不是用于隔离恶意本机 root 用户的安全沙箱。写文件采用原子替换、0600 权限，父目录需已存在。

HTTP 探针支持 method/headers/body/expectedStatus，限制请求体 128 KiB、响应体 1 MiB，拒绝跨来源重定向，HTTPS 校验证书。mapping 使用 `{"业务字段":"$.data.items.0.count"}` 点路径及数字数组索引；不执行 JSONPath 表达式或代码。HTTP/TCP 探针连接被指定目标，用于基础设施内部检查；Agent 与主控、升级分发始终要求 TLS。

## PTY

Gateway 发送顶层字段：

```json
{"type":"terminal.open","sessionId":"opaque-session-id","cols":120,"rows":32}
{"type":"terminal.input","sessionId":"opaque-session-id","data":"ls\r"}
{"type":"terminal.resize","sessionId":"opaque-session-id","cols":100,"rows":30}
{"type":"terminal.close","sessionId":"opaque-session-id"}
```

返回 `terminal.output` 的 `data`、`terminal.exit` 的 `exitCode`，失败返回 `terminal.error.error`。每个连接最多八个会话，输入每帧最多 32 KiB，窗口尺寸 2–500。断线时关闭全部 PTY 并终止进程组，不在重连后复活旧终端。

主控必须完成用户/API Key scope、节点权限、高危操作确认及审计校验，Agent 的 mTLS 身份和参数检查不替代这些校验。systemd 默认以 root 运行是为了明确授权的主机管理功能，应把平台管理权限视作节点管理员权限。

## 当前验证边界

已在 macOS 开发机使用真实本地 HTTP/TCP/TLS 服务验证注册、信任拒绝、探针与 JSON 映射，验证 journal 去重/UNKNOWN 恢复、命令组超时、输出上限、路径保护。Linux systemd、Docker、Nginx、UFW、安装和升级需要在专用 Linux 节点进行联调；交叉编译不能代替这些系统级执行验证。
