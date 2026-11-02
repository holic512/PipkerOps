# PipkerOps

面向个人开发者和维护 10–50 台 Linux 节点的小团队的运维平台。集中查看节点与设备历史、应用健康、探针和拓扑，执行可追踪的远程任务，并通过 MCP 向 AI Agent 开放同一套能力。

Go Agent 主动建立 TLS 连接；Next.js 提供界面与 API，Gateway 维护 Agent 连接，Worker 负责调度。PostgreSQL 保存业务和任务事实，Redis 负责临时协调与限流。项目仍在开发，生产公网和长期稳定性验收范围见[开发文档](docs/DEVELOPMENT.md)。

## 部署

准备 Linux 服务器、Docker Compose v2、外部 PostgreSQL 17、独立 Redis 逻辑库及 Web HTTPS 证书。克隆仓库后进入目录：

```sh
sudo sh deploy/menu.sh
```

选择“安装”，脚本创建配置模板。填写 `deploy/config/app.conf`，在 `deploy/certs/web` 放置 `fullchain.pem` 和 `privkey.pem`，再次安装即可拉取镜像、初始化并启动。宿主机路径和版本放在 `deploy/compose.env`，应用凭据只放在映射配置中。

修改 `deploy/config/app.conf` 后选择“重启并重读配置”。切换到空数据库时会先执行迁移和管理员初始化；配置切换不搬迁数据。完整步骤、权限、私有镜像登录和恢复说明见[部署文档](docs/DEPLOYMENT.md)。

## Agent

从 [GitHub Releases](https://github.com/holic512/PipkerOps/releases) 下载 Linux amd64/arm64 安装包和 `SHA256SUMS`，校验后手动安装。每次 master 推送通过验证后发布包含独立组件版本的 Release。

在管理端生成注册令牌，将主控 CA **公钥**交给节点，配置 Agent 并审批接入。安装包同时保留原始二进制供在线升级使用，详见 [Agent 安装与协议](agent/README.md)。

## 文档

- [部署与运维](docs/DEPLOYMENT.md)：配置、容器菜单、版本、TLS、备份恢复。
- [开发与验证](docs/DEVELOPMENT.md)：本地开发、目录职责、测试、CI、当前验收边界。
- [API 与 MCP](docs/API.md)：方法、授权、任务和结构化输出。
- [数据库模型与维护](docs/database.md)：迁移、指标保留和容量验证。
- [Agent](agent/README.md)：安装、配置、任务协议和升级。
- [产品定位](PRODUCT.md)与[界面规范](DESIGN.md)。

Web、MCP、Cron 共享授权与任务服务；远程操作返回任务编号，结果不明的非幂等任务保留 `UNKNOWN`，通过 Agent journal 对账。生产使用 HTTPS/TLS，真实配置、私钥、备份及运行状态不入库。

许可证：[Apache-2.0](LICENSE)。
