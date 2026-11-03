# 安装与更新

首次安装由用户手工上传发布包。安装并纳管后，可从 Ops 页面手动选择版本下载和分发更新。Ops、Agent 和部署脚本各自维护版本。

## 先安装 Ops

准备 Linux、Python 3、Docker Compose v2、外部 PostgreSQL 17 和独立 Redis 逻辑库。从同一 GitHub Release 下载 `pipkerops-deploy-<脚本版本>.tar.gz` 和 `SHA256SUMS`，核对相应文件的 SHA-256 后解压。包内 `pipkerops/deploy` 可以放到任意固定目录；以下以 `/opt/pipkerops/deploy` 为例。

```sh
sudo python3 /opt/pipkerops/deploy/menu.py
```

选择“主控管理 → 安装 Ops（不启动）”。安装检查现有 Docker Engine、Compose 和 daemon，创建配置及数据目录，准备 Ops 和 Nginx 镜像，成功后登记安装；不安装 Docker，不连接数据库，不执行数据库迁移，也不创建或启动容器。已有服务运行时须先停止才能重新安装。

然后手动编辑 `config/ops/app.conf` 和 `config/ops/compose.env`，再选择“启动”。应用配置依次为数据库、缓存 Redis、初始管理员、持久目录、后台任务；TLS 参数与各自后端相邻。启动才进行数据库迁移和管理员初始化，并只使用已准备的本地镜像。缺少镜像时先停止服务、重新安装；需要切换版本时使用“更新”。重复安装保留实际配置和数据，已有本地镜像可直接复用。

Ops 0.1.9 的 standalone 运行入口与部署脚本 0.1.2 配套。已有部署先更新脚本，再通过“更新”切换 Ops 至 0.1.9 或更新版本；完成镜像切换后再执行普通重启。新 Compose 的 Gateway 健康检查使用镜像内预编译的 JavaScript，旧版 Ops 镜像没有该入口。实际 `compose.env` 保留用户已设置的版本，不会被示例配置覆盖。

数据库与 Redis 是否使用 TLS 完全由 `DATABASE_SSL_MODE`、`REDIS_TLS` 决定，生产环境也支持 `disable`、`false`，不需要额外开关。启用 TLS 时仍可指定各自 CA。脚本不处理 Web TLS，不要求提供域名或证书。私有镜像需要先由执行部署命令的账户完成对应仓库的 `docker login`。

```sh
sudo python3 /opt/pipkerops/deploy/script/install.py
# 手动编辑 config/ops/app.conf 和 compose.env 后执行：
sudo python3 /opt/pipkerops/deploy/script/start.py
```

默认 HTTP 入口为 `127.0.0.1:8080`。HTTP 页面可以打开，但登录页面禁用密码提交，业务 API 返回 `403` 和“请以 HTTPS 访问”。健康检查允许 HTTP。

用现有 Nginx、Caddy 或 1Panel 将 HTTPS 站点反向代理到此入口，保留 Host（含端口），覆盖 `X-Forwarded-Proto`，支持 WebSocket。Nginx 示例见 `resources/reverse-proxy.conf.example`。随后使用 HTTPS 地址登录，无需再填写 APP_ORIGIN 或公网网关地址。浏览器终端也经同一个站点访问，无需安装内部 CA。

后端默认只监听本机。跨容器/跨主机代理时必须限制后端入口只可由可信代理访问，再调整 WEB_BIND；不能把后端公开后依赖客户端声明的转发头判断 TLS。

## 国内镜像源与测速

安装和更新分别为 Ops（GHCR）及 Nginx（Docker Hub）获取目标版本、Docker Engine 架构对应的 manifest，限量下载最多 1 MiB 镜像层，显示响应耗时和速率，按速率降序、响应耗时升序选择候选。每个网络请求最多等待 4 秒，候选测速阶段预算 12 秒，每次完整拉取最多 600 秒；失败项会跳过，完整拉取失败按排名尝试下一项。全部失败则操作失败，更新不会停止原服务。

`config/ops/mirrors.conf` 使用 `键=值`，多个地址以英文逗号分隔，不包含协议、版本或凭据：

| 配置项 | 用途 |
| --- | --- |
| `GHCR_MIRRORS` | GHCR 代理前缀，默认南京大学和 DaoCloud |
| `DOCKER_HUB_MIRRORS` | Docker Hub 代理前缀，默认南京大学、DaoCloud 和腾讯云内网候选 |
| `OPS_REPOSITORIES` | 已同步的 Ops 完整仓库路径，不含版本 |
| `NGINX_REPOSITORIES` | 已同步的 Nginx 完整仓库路径，不含版本 |

例如 `m.daocloud.io/ghcr.io` 会映射为 `m.daocloud.io/ghcr.io/holic512/pipkerops:<版本>`，Docker Hub 的官方 Nginx 使用 `library/nginx` 路径。阿里云、华为云账号专属 Docker Hub 加速地址可追加到 `DOCKER_HUB_MIRRORS`；其云环境、白名单及缓存范围限制仍然适用，不当作 GHCR 通用代理。已同步到阿里云 ACR、腾讯云 TCR 或华为云 SWR 的公开仓库可填入对应 `*_REPOSITORIES`，必须自行提供相同版本标签和目标架构。公共候选最终是否可用，以目标主机测速和实际拉取为准。

某项留空表示关闭该项候选，原始官方源仍参与测速。默认公开仓库之外的自定义镜像直接交给 Docker 拉取，不经过公共代理；需要认证时使用执行脚本账户已有的 Docker 登录。通过 `compose.env` 的 `PIPKEROPS_IMAGE` 指定不含版本的 Ops 仓库，通过 `PIPKEROPS_PROXY_IMAGE` 指定含版本的完整 Nginx 镜像。

原始镜像配置保留，选源结果单独保存在 `data/ops/image-sources.json`，由脚本调用 Compose 时注入。镜像配置或目标版本变化后，旧选源结果不再覆盖该镜像。普通启动、停止和重启不会访问镜像源。直接调用 Compose 不会读取选源结果，正常运维请使用脚本入口。

“镜像源测速”仅展示当前版本排名，不拉取完整镜像、不切换正在使用的源；安装或更新时自动应用最快可用结果。首次安装失败时可修改已经生成的配置后重新安装。

```sh
sudo python3 /opt/pipkerops/deploy/script/mirrors.py
```

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
| `config/ops/mirrors.conf` | 国内镜像代理前缀及额外仓库配置，不进入应用容器 |
| `config/agent/` | Agent 配置 |
| `data/ops/config/` | Ops 启动时同步的运行副本，不直接编辑 |
| `data/ops/image-sources.json` | 与原始镜像及版本匹配的实际镜像源选择 |
| `data/ops/credentials/` | Ops 保存的节点访问 Key，普通查询不返回 |
| `data/ops/releases/` | 已校验的发布缓存 |
| `data/ops/backups/` | 数据库和节点连接凭证备份 |
| `data/agent/` | Agent 身份、任务 journal、制品及脚本更新回滚副本 |
| `.pipkerops-installation.json` | 原部署目录和已安装组件标记 |
| `managed-files.json`、`VERSION` | 发布程序清单和部署脚本版本 |

脚本根据自己的绝对路径定位配置，从其他工作目录调用也使用同一套数据。安装时原 `config/app.conf`、`config/compose.env` 存在且新配置不存在，则复制并保留原文件；新副本去掉旧注册/网关/PKI 和明文后端开关，HTTP 入口改为 `127.0.0.1:8080`。旧镜像版本不会被悄悄修改，首次迁移时请通过本地 `script/update.py 0.1.4` 切换到支持新流程的 Ops，并调整自己的外部 HTTPS 代理。已有有效 Ops 安装标记与配置可继续使用，不要求重新安装，也不自动生成或覆盖已有文件。旧 data 和旧 Agent 身份不删除。旧节点在 Ops 中选择“关联已有节点”导入新接入文件，保留其 ID、历史和关联资源。

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
sudo python3 /opt/pipkerops/deploy/script/update.py 0.1.4
sudo python3 /opt/pipkerops/deploy/script/update_scripts.py /tmp/upload/pipkerops-deploy-0.1.1.tar.gz <SHA256>
```

系统备份包含数据库和节点连接凭证，属于私密文件。新归档格式为 2；旧格式备份请用对应旧版本恢复后再迁移。离线恢复仅接受空数据库和空凭证目录，恢复中的在途任务标记 UNKNOWN，保留对账。
