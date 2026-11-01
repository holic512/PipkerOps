# 部署与运维

生产通过预构建镜像部署，仅包含 init、Web、Gateway、Worker、Nginx 代理。PostgreSQL 与 Redis 由外部提供；部署脚本不创建数据库、不管理宿主 Docker 服务。

## 准备环境

- Linux、Docker Engine、Docker Compose v2（需支持 `up --wait` 与 `pull --policy missing`）。安装时使用 root 或 sudo；日常操作需要 Docker 权限和部署文件读取权限。
- PostgreSQL 17：预先创建空数据库和专用用户。该用户需拥有目标数据库及 public schema 的建表、索引、函数与分区权限；Worker 的例行维护也使用该身份。首次迁移只初始化结构，不创建演示数据。
- Redis 7：为 PipkerOps 分配独立逻辑库，启用认证。Redis 不是任务事实来源，不与其他应用复用同一逻辑库。
- 可信 Web TLS 证书及可解析的域名。默认端口：Web HTTPS 443、Agent mTLS 9443、注册及终端 TLS 9444。外部后端只向主应用开放访问；公网后端连接必须启用 TLS。

镜像为 `ghcr.io/holic512/pipkerops`，支持 Linux amd64/arm64。正式部署建议使用固定版本；`edge` 跟随 master，`latest` 指向最近发布的稳定版本。

GHCR 新包默认可能为私有。需要匿名拉取时在 GitHub 包设置中公开包；使用私有包时先以具有 `read:packages` 的身份执行 `docker login ghcr.io`，与安装脚本使用同一 Docker 凭据上下文。不要将 Token 写进 Compose 或仓库。

## 安装与目录

克隆或下载项目，进入项目目录运行：

```sh
sudo sh deploy/menu.sh
# 也可直接调用
sudo sh deploy/install.sh
```

首次安装只创建模板，提示填写后退出。完成下列文件后再次选择安装：

| 文件／目录 | 用途 |
| --- | --- |
| `deploy/compose.env` | 镜像、版本、项目名、宿主端口和映射路径；不放应用凭据 |
| `deploy/config/app.conf` | 运行配置，目录只读映射到 `/app/config` |
| `deploy/data/pki/` | Agent CA 与 Gateway 证书，映射到 `/app/.data/pki` |
| `deploy/data/backups/` | 系统备份归档与校验记录，映射到 `/app/.data/backups` |
| `deploy/certs/web/fullchain.pem` | 浏览器 HTTPS 完整证书链 |
| `deploy/certs/web/privkey.pem` | 浏览器 HTTPS 私钥 |

容器使用 UID/GID `10001:10001`。安装脚本将配置目录和 PKI 目录授权给该身份，`app.conf` 为 0600；编辑配置需管理员权限。已有 PKI 文件不被覆盖。Web 证书由 Nginx root 主进程读取；配置目录中的自定义后端 CA 文件也需允许 UID 10001 读取。

默认路径相对仓库根目录解析。自定义位置先复制 `deploy/compose.env.example`，编辑绝对路径或相对根目录的路径，再执行安装。`compose.env` 使用不带引号、不含变量引用的 `KEY=value` 字面量。可通过绝对路径环境变量 `PIPKEROPS_COMPOSE_ENV` 选择另一份部署配置；sudo 时用 `sudo env PIPKEROPS_COMPOSE_ENV=/absolute/compose.env sh deploy/install.sh` 显式传递。

安装会拉取缺少的镜像，依次执行数据库迁移、首次管理员创建、PKI 初始化，再启动三个应用进程与代理并等待健康。管理员已存在时不重置密码；PKI 完整时不重新签发。

## 运行配置

以 `deploy/app.conf.example` 为准。采用文本键值语法，应用通过 `parseEnv` 直接读取文件，不写入进程环境，不接受业务环境变量覆盖。密码填写原文，包含 `#` 或空格时使用引号；连接串由应用内部编码拼接。修改后重启生效。

| 配置 | 含义 |
| --- | --- |
| `DATABASE_HOST / DATABASE_PORT / DATABASE_USERNAME / DATABASE_PASSWORD / DATABASE_NAME` | PostgreSQL 地址、端口、用户名、原文密码和库名 |
| `DATABASE_SSL_MODE / DATABASE_CA_FILE` | TLS 模式与可选 CA 文件；公网必须 require、verify-ca 或 verify-full |
| `REDIS_HOST / REDIS_PORT / REDIS_USERNAME / REDIS_PASSWORD / REDIS_DATABASE / REDIS_TLS` | Redis 分项参数；公网必须启用 TLS |
| `APP_ORIGIN` | 浏览器访问源，生产必须是 HTTPS；包含非默认 Web 端口 |
| `BOOTSTRAP_EMAIL/PASSWORD/NAME` | 首次管理员，密码至少16位且不包含占位符 |
| `GATEWAY_PUBLIC_URL` | 节点可达的 `wss://域名:端口/agent` |
| `ENROLL_PUBLIC_URL` | 节点可达的 `https://域名:端口`，不带 `/enroll` |
| `PKI_HOSTS` | Gateway 证书的 DNS/IP SAN，以逗号分隔；健康检查使用第一项校验证书 |
| `PKI_DIR` | 容器内固定为 `/app/.data/pki` |
| `BACKUP_DIR` | 容器内固定为 `/app/.data/backups`，实际存于宿主数据映射目录 |
| `GATEWAY_HOST/GATEWAY_PORT/ENROLL_PORT` | 容器内使用 `0.0.0.0/9443/9444`；宿主端口在 Compose 配置中调整 |
| `WORKER_INTERVAL_MS` | 调度间隔，默认2000毫秒 |
| `REDIS_CA_FILE` | 可选，Redis 私有 CA 的容器内 PEM 路径，如 `/app/config/backend-ca.pem` |

同一镜像不包含实际配置。每次容器启动，统一入口重新读取文件，校验配置并检查 PostgreSQL/Redis 连接。修改文件可由编辑器原子替换，因映射的是目录，重启后仍读取新文件。编辑或替换后保持 `app.conf` 属于 `10001:10001` 且权限为0600；若编辑器改变了所有者，先用 `sudo chown 10001:10001 deploy/config/app.conf` 修正。

修改 `app.conf` 后运行：

```sh
sudo sh deploy/restart.sh
```

此操作先停止应用，再对当前连接运行 init，成功后重建服务。适用于切换到全新空库。目标已初始化时，也可用下面的直接重启，仅重启三个应用进程：

```sh
docker compose --env-file deploy/compose.env restart web gateway worker
```

配置切换不会复制原库数据。修改 `compose.env` 中的镜像、路径、端口需要菜单启动/重启重建容器。修改 `PKI_HOSTS` 不会覆盖已有 PKI，域名变更需要另行签发包含正确 SAN 的服务证书，不能删除原 CA 作为续期方式。

## 菜单与命令

```sh
sudo sh deploy/menu.sh
```

各入口均从脚本位置定位仓库，可在其他工作目录调用其绝对路径。

| 操作 | 命令 |
| --- | --- |
| 安装 | `sudo sh deploy/install.sh` |
| 启动 | `sh deploy/start.sh` |
| 停止 | `sh deploy/stop.sh` |
| 重读配置并重启 | `sh deploy/restart.sh` |
| 更新固定版本 | `sh deploy/update.sh 0.1.0` |
| 更新 master 测试版 | `sh deploy/update.sh edge` |
| 状态与镜像 | `sh deploy/status.sh` |
| 最近100条日志 | `sh deploy/logs.sh gateway` |
| 持续日志 | `sh deploy/logs.sh worker --follow` |

停止保留配置、PKI 和外部数据。更新先拉取目标镜像；拉取失败不停止现有应用。拉取成功后停止、更新版本配置、迁移并启动；失败时保持实际状态，查看 init 和服务日志后处理。数据库迁移不支持自动降级，不将 `down -v` 或全局 prune 当作更新步骤。

## Agent 安装

从 [Releases](https://github.com/holic512/PipkerOps/releases) 下载对应架构安装包及 `SHA256SUMS`，先校验再安装。手动操作与配置见 [Agent 文档](../agent/README.md)。测试版在 Actions 附件中，不与稳定版 `latest` 混用。

从 `deploy/data/pki/ca.crt` 安全复制 **CA 公钥**给节点；CA 私钥仅保留主控。Web TLS 与 Agent 私有 CA 用途独立。生成注册令牌、配置节点、启动 Agent 后，在管理端核对身份并审批。

## 系统备份与恢复

管理员在 Web 的“平台 → 系统备份”创建、查看、下载和删除备份。创建后立即获得系统任务编号，由 Worker 后台执行；页面显示排队、执行、成功或失败，可跳转共用任务详情。操作沿用系统管理员授权和审计，非管理员不能读取含业务和私钥的归档。

备份包含 PostgreSQL 业务数据库和 Agent PKI，归档与校验记录存于 `deploy/data/backups/`，通过只读配置中的 `BACKUP_DIR` 指定容器内位置。重建、更新、停止容器都保留这些文件。实际目录可通过 `PIPKEROPS_DATA_DIR` 改到另一块持久磁盘；容器内路径应保持模板默认值。

运行配置、Web HTTPS 证书不打进备份，需单独安全保管。Redis 仅保存临时协调数据，不做整库快照。归档包含 CA 私钥和业务数据；管理员下载后另存到独立存储，并保存完整备份目录（含元数据和摘要），避免主机磁盘故障丢失唯一副本。

备份使用 PostgreSQL 事务一致快照，但不能与远端系统副作用组成分布式事务。需要完整运维恢复点时，先暂停新任务和调度并等待正在执行的任务结束。前端不会为备份阻塞整个系统。

恢复属于停机维护，调用应用内维护入口，部署菜单不承担备份或恢复业务。准备相同版本镜像、空 PostgreSQL 目标、独立 Redis 逻辑库和空 PKI 目录，保留或复制选定备份的完整目录。停止原应用、填写目标连接后执行：

```sh
docker compose --env-file deploy/compose.env stop web gateway worker proxy init
docker compose --env-file deploy/compose.env run --rm --no-deps -T init restore <备份完整UUID> --confirm-empty-target
# 核对数据、CA、UNKNOWN任务与 Agent journal 后显式启动
sh deploy/start.sh
```

恢复先验证归档与内部文件摘要，拒绝非空 public schema 和非空 PKI 目录，不覆盖已有数据。恢复中的 DISPATCHED/RUNNING 任务标记 UNKNOWN，Redis 只清理目标专用逻辑库的 `pko:*` 临时键；禁止盲目重放远端操作。浏览器未过期 Session 随 PostgreSQL 恢复，如需重新登录应先清理 Session。使用原始域名，或另行签发正确 SAN 的 Gateway 证书。

系统备份页面的文件列表来自持久目录，任务状态来自业务数据库；将备份目录挂入新实例后，完整归档仍可被识别。删除归档会保留任务与审计历史。

## 故障定位

- 配置不存在或不可读：核对映射目录、`app.conf` 和 UID 10001 权限；不会回退到镜像内旧配置。
- 初始化失败：入口仅显示失败阶段以避免输出凭据；检查协议、数据库权限、后端可达性和 TLS CA。需要数据库诊断时在可信管理环境查看服务端日志。
- Web 不健康：`/api/health` 同时验证 PostgreSQL 和 Redis；查看 Web、init 状态。
- Gateway 不健康：检查 PKI 文件、首个 SAN、容器内9444端口；Agent 还需正确 CA、域名与审批。
- 更新或恢复失败：先核对实际数据库迁移和服务状态，再显式重试；不要假定失败意味着数据或容器毫无变化。

本地部署测试及待完成的公网、长期容量验收见[开发文档](DEVELOPMENT.md)。
