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

Next.js 提供界面与 API，Gateway 维护 Agent 连接，Worker 负责调度。Agent 的安装、接入和任务协议详见 [Agent 文档](agent/README.md)。

## 开始部署

准备 Linux 服务器、Docker Compose v2、外部 PostgreSQL 17、独立 Redis 逻辑库。克隆仓库后，在项目目录执行：

```sh
sudo python3 deploy/menu.py
```

选择“主控管理 → 启动”生成配置模板，填写 `deploy/config/ops/app.conf` 和 `deploy/config/ops/compose.env`，再执行启动。默认提供 `127.0.0.1:8080` HTTP 入口，由自己的反向代理提供 HTTPS 后登录，无需在 Ops 配置域名或 Web 证书。Ops 与 Agent 的 config/data 分目录保存。也可下载 Release 中的独立部署包使用同一菜单，完整步骤见[部署指南](docs/DEPLOYMENT.md)。

## 接入节点

从同一条 [GitHub Release](https://github.com/holic512/PipkerOps/releases) 下载对应架构的 `pipker-agent-<版本>-linux-amd64.tar.gz` 或 `arm64.tar.gz` 和 `SHA256SUMS`，人工上传到目标 Linux 主机的同一目录。使用部署菜单中的“Agent 管理 → 安装／重新安装”，输入本地包路径；工具校验后安装，不自动下载或启动。

仅安装 Agent 的节点需要 Python 3、Linux 和 systemd。设置 Ops 可达的 Agent 地址并启动后，Agent 自动生成自己的证书与访问 Key；从脚本导出一份接入文件，在 Ops 上传、测试并添加节点。纳管后通过“版本更新”手动选择正式版本，Ops 下载校验后分发 Agent 程序或部署脚本；同机 Agent 可执行 Ops 自更新。

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
