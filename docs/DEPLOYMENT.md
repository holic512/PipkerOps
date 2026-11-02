# 安装与更新

首次安装由用户手工上传发布包。安装并纳管后，可从 Ops 页面手动选择版本下载和分发更新。Ops、Agent 和部署脚本各自维护版本。

## 先安装 Ops

准备 Linux、Python 3、Docker Compose v2、外部 PostgreSQL 17 和独立 Redis 逻辑库。从同一 GitHub Release 下载 `pipkerops-deploy-<脚本版本>.tar.gz` 和 `SHA256SUMS`，核对相应文件的 SHA-256 后解压。包内 `pipkerops/deploy` 可以放到任意固定目录；以下以 `/opt/pipkerops/deploy` 为例。

```sh
sudo python3 /opt/pipkerops/deploy/menu.py
```

选择“主控管理 → 启动”，按提示填写 `config/ops/app.conf` 和 `config/ops/compose.env`，再启动。配置示例逐项解释默认值和修改方式。脚本不处理 Web TLS，不要求提供域名或证书。私有镜像需要先由执行部署命令的账户完成 `docker login ghcr.io`。

默认 HTTP 入口为 `127.0.0.1:8080`。HTTP 页面可以打开，但登录页面禁用密码提交，业务 API 返回 `403` 和“请以 HTTPS 访问”。健康检查允许 HTTP。

用现有 Nginx、Caddy 或 1Panel 将 HTTPS 站点反向代理到此入口，保留 Host（含端口），覆盖 `X-Forwarded-Proto`，支持 WebSocket。Nginx 示例见 `resources/reverse-proxy.conf.example`。随后使用 HTTPS 地址登录，无需再填写 APP_ORIGIN 或公网网关地址。浏览器终端也经同一个站点访问，无需安装内部 CA。

后端默认只监听本机。跨容器/跨主机代理时必须限制后端入口只可由可信代理访问，再调整 WEB_BIND；不能把后端公开后依赖客户端声明的转发头判断 TLS。

## 再安装 Agent

1. 把对应架构的 `pipker-agent-<Agent版本>-linux-amd64.tar.gz` 或 `arm64.tar.gz` 和同一 Release 的 `SHA256SUMS` 上传到目标主机。
2. 在该主机的部署菜单选择“Agent 管理 → 安装／重新安装”，提供本地归档路径。脚本核对归档和 ELF 架构，安装 systemd 服务；不自动启动。仅安装 Agent 不需要 Docker、数据库或 Redis。
3. 检查 `config/agent/agent.env`，将 `PIPKEROPS_URL` 设置为 Ops 可访问的 HTTPS 地址，例如 `https://10.0.0.12:9443`。监听地址默认 `0.0.0.0:9443`，按网络需要限制防火墙。然后选择“启动并设为开机自启”。
4. Agent 自动在 `data/agent/identity/identity.json` 中生成并保存自己的 CA、证书、私钥、稳定 ID 和访问 Key。无需向 Ops 请求注册令牌或等待证书审批。
5. 选择“导出接入文件”，把输出保存为权限 0600 的 JSON，在 Ops“节点管理”中上传或粘贴，测试连接成功后确认添加。文件含访问 Key，不要放入 Git、聊天或公开目录。

同机 Docker 中的 Ops 不能通过自己的 `127.0.0.1` 访问宿主 Agent。Compose 已提供 `host.docker.internal`，Agent 证书包含此名称；可将接入文件中的 URL 改为 `https://host.docker.internal:9443` 后导入，或使用容器可达的宿主 IP。TLS 始终校验地址和 CA。

```sh
sudo python3 /opt/pipkerops/deploy/script/agent.py install /tmp/upload/pipker-agent-0.1.1-linux-amd64.tar.gz
sudo python3 /opt/pipkerops/deploy/script/agent.py start
sudo sh -c 'umask 077; python3 /opt/pipkerops/deploy/script/agent.py export > /root/agent-connection.json'
sudo python3 /opt/pipkerops/deploy/script/agent.py status
sudo journalctl -u pipkerops-agent -f
```

重装前停止服务；重装保留已有配置和 data。Key 泄露后先停止 Agent，在菜单明确执行“重置访问 Key”，再启动并重新导入。证书自动续期沿用 CA 和私钥，普通程序升级不会改变身份或 Key。

## 同机目录与保留规则

| 路径（相对于原部署目录） | 用途 |
| --- | --- |
| `config/ops/` | 人工维护的 Ops 业务和 Compose 配置 |
| `config/agent/` | Agent 配置 |
| `data/ops/config/` | Ops 启动时同步的运行副本，不直接编辑 |
| `data/ops/credentials/` | Ops 保存的节点访问 Key，普通查询不返回 |
| `data/ops/releases/` | 已校验的发布缓存 |
| `data/ops/backups/` | 数据库和节点连接凭证备份 |
| `data/agent/` | Agent 身份、任务 journal、制品及脚本更新回滚副本 |
| `.pipkerops-installation.json` | 原部署目录和已安装组件标记 |
| `managed-files.json`、`VERSION` | 发布程序清单和部署脚本版本 |

脚本根据自己的绝对路径定位配置，从其他工作目录调用也使用同一套数据。原 `config/app.conf`、`config/compose.env` 存在时，只在新配置不存在时复制，原文件保留；新副本去掉旧注册/网关/PKI 参数，HTTP 入口改为 `127.0.0.1:8080`。旧镜像版本不会被悄悄修改，首次迁移时请通过本地 `script/update.py 0.1.3` 切换到支持新流程的 Ops，并调整自己的外部 HTTPS 代理。旧 data 和旧 Agent 身份不删除。旧节点在 Ops 中选择“关联已有节点”导入新接入文件，保留其 ID、历史和关联资源。

## 页面更新与本地恢复

管理员进入“版本更新”，选择 Agent 程序、部署脚本或 Ops 应用，再选择节点并验证登记原部署目录。Ops 应用更新必须选择安装在 Ops 宿主上的 Agent。检查正式发布后选择版本，明确确认才执行，不自动升级。

Ops 从 GitHub 获取 `release-manifest.json` 和对应制品，校验 SHA-256 和架构，再通过受信 HTTPS 上传到 Agent。Agent 不需要访问 GitHub。没有新版发布清单的历史 Release 不出现在可更新列表中。

- Agent 升级只替换二进制并保留 `.previous`，结果持久化且 Ops ACK 后才重启。Ops 等待新版本重新上报后再确认整个更新完成；已经是目标版本时直接提示无需更新，不替换或重启。
- 部署脚本只替换 `managed-files.json` 中的程序文件。实际 config、data 和额外文件保留；发现本地程序修改或删除会拒绝更新并列出冲突。旧文件备份保存在 `data/agent/updates/`。源码目录没有正式发布清单时会在登记阶段明确拒绝，请先使用正式部署包。
- Ops 自更新由 Compose 外的同机 Agent 执行，先保存系统备份，再拉取目标镜像；拉取失败不会停止应用。重启 Ops 时 Agent 任务继续执行，恢复连接后重放结果。
- 更新不自动回滚数据库迁移。失败时保留实际日志和 UNKNOWN 状态，先检查原任务，再使用本地菜单恢复，不能盲目重复提交。

```sh
sudo python3 /opt/pipkerops/deploy/script/status.py
sudo python3 /opt/pipkerops/deploy/script/restart.py
sudo python3 /opt/pipkerops/deploy/script/update.py 0.1.3
sudo python3 /opt/pipkerops/deploy/script/update_scripts.py /tmp/upload/pipkerops-deploy-0.1.0.tar.gz <SHA256>
```

系统备份包含数据库和节点连接凭证，属于私密文件。新归档格式为 2；旧格式备份请用对应旧版本恢复后再迁移。离线恢复仅接受空数据库和空凭证目录，恢复中的在途任务标记 UNKNOWN，保留对账。
