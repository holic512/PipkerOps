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
