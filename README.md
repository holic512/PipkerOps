# PipkerOps

**一个面向 Linux 节点的集中运维平台，让节点观察、远程操作和 AI 工具调用使用同一套能力。**

[English](README.en.md) · [部署指南](docs/DEPLOYMENT.md) · [API 与 MCP](docs/API.md) · [Agent](agent/README.md)

PipkerOps 面向个人开发者和维护 10–50 台 Linux 节点的小团队。它将节点与设备历史、应用健康、探针和拓扑集中呈现，并提供可追踪的远程任务。

> 项目仍在开发中。生产公网和长期稳定性的验收边界，请参阅[开发与验证](docs/DEVELOPMENT.md)。

## 可以做什么

- **观察基础设施**：查看节点与设备历史、应用健康、探针和拓扑。
- **执行远程任务**：通过 Agent 管理主机，并追踪任务状态和结果。
- **接入 AI 工作流**：通过 MCP 向 AI Agent 开放平台能力；Web、MCP 和 Cron 共享授权与任务服务。
- **处理不确定结果**：非幂等任务结果不明时保留 `UNKNOWN`，通过 Agent journal 对账。

## 工作方式

```text
Web / MCP / Cron
       │
       ▼
  授权与任务服务 ── PostgreSQL（业务与任务事实）
       │          └─ Redis（临时协调与限流）
       ▼
 Gateway / Worker
       │
       │  Agent 主动建立 TLS 连接
       ▼
  Linux 节点上的 Go Agent
```

Next.js 提供界面与 API，Gateway 维护 Agent 连接，Worker 负责调度。Agent 的安装、注册和任务协议详见 [Agent 文档](agent/README.md)。

## 开始部署

准备 Linux 服务器、Docker Compose v2、外部 PostgreSQL 17、独立 Redis 逻辑库及 Web HTTPS 证书。克隆仓库后，在项目目录执行：

```sh
sudo sh deploy/menu.sh
```

1. 选择“安装”，生成配置模板。
2. 填写 `deploy/config/app.conf`，并将 `fullchain.pem` 和 `privkey.pem` 放入 `deploy/certs/web`。
3. 再次选择“安装”，拉取镜像、初始化并启动。

宿主机路径和版本配置位于 `deploy/compose.env`，应用凭据放在映射配置中。修改 `deploy/config/app.conf` 后，选择“重启并重读配置”。切换到空数据库时会执行迁移和管理员初始化；配置切换不会搬迁数据。

完整步骤、权限、私有镜像登录和恢复说明见[部署指南](docs/DEPLOYMENT.md)。

## 接入节点

从 [GitHub Releases](https://github.com/holic512/PipkerOps/releases) 下载适用于 Linux amd64 或 arm64 的 Agent 安装包和 `SHA256SUMS`，校验后安装。在管理端生成注册令牌，通过可信渠道向节点提供主控 CA 公钥证书，配置 Agent 并审批接入。安装包同时保留原始二进制供在线升级使用。

具体命令和配置见 [Agent 安装与协议](agent/README.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [部署与运维](docs/DEPLOYMENT.md) | 配置、容器菜单、版本、TLS、备份与恢复 |
| [开发与验证](docs/DEVELOPMENT.md) | 本地开发、目录职责、测试、CI 与验收边界 |
| [API 与 MCP](docs/API.md) | 方法、授权、任务和结构化输出 |
| [数据库模型与维护](docs/database.md) | 迁移、指标保留和容量验证 |
| [Agent](agent/README.md) | 安装、配置、任务协议和升级 |
| [产品定位](PRODUCT.md) · [界面规范](DESIGN.md) | 产品方向与设计约定 |

生产使用 HTTPS/TLS；真实配置、私钥、备份及运行状态不入库。

## 许可证

[Apache License 2.0](LICENSE)
