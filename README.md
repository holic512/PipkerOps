# PipkerOps

面向个人开发者和 10–50 台 Linux 节点的轻量集群运维平台，集中管理节点监控、应用、探针、拓扑和远程任务，并通过 MCP 向 AI Agent 开放平台能力。

Go Agent 主动连接主控；Next.js 提供管理界面与 API，Gateway 维护 Agent 连接，Worker 执行调度。PostgreSQL 保存业务与任务数据，Redis 用于临时协调和限流。

项目仍在开发。主要模块已实现，剩余功能和验收条件见 [开发计划](docs/PLAN.md)。

## 本地启动

需要 Node.js 22.12+、Go 1.26+、PostgreSQL 和 Redis。先启动数据库与 Redis，再运行：

```sh
npm ci
cp .env.example .env
```

编辑 `.env`，填写连接配置、管理员邮箱和随机密码；本地设置 `APP_ORIGIN=http://127.0.0.1:3000`。

```sh
npm run db:generate
npm run db:deploy
npm run bootstrap
npm run pki:init
npm run dev
```

另开两个终端，分别运行 `npm run gateway` 和 `npm run worker`。打开 http://127.0.0.1:3000，用配置的管理员账户登录；`bootstrap` 不覆盖已有账户。

在节点管理生成注册令牌，将 CA 公钥复制到节点，按 [Agent 安装说明](agent/README.md) 安装并审批。CA 私钥留在主控。默认 mTLS 端口为 9443，注册与终端 TLS 端口为 9444。生产部署使用 HTTPS/TLS，见 [部署文档](docs/DEPLOYMENT.md)。

## 开发验证

```sh
npm run db:validate
npm run check
npm run lint
npm test
npm run build
cd agent && go test ./...
```

`npm run test:database` 使用一次性 PostgreSQL 17 容器验证并发，不读取 `.env`。平台、Linux、systemd、连通性、告警、恢复和容量联调的运行条件见 [部署文档](docs/DEPLOYMENT.md)，需先启动对应服务和夹具。

提交前运行 `node scripts/check-secrets.mjs` 检查暂存区。配置、私钥、Agent 状态、备份和构建产物不入库。

## API 与任务

Web 使用 `POST /api/rpc`，请求格式为 `{ "method":"nodes.list", "params":{} }`。MCP 使用 `/api/mcp` 的无状态 Streamable HTTP；工具名将方法名的 `.` 换成 `_`，参数放在 `params` 中。

独立 API Key 使用 `Authorization: Bearer ...`。服务端统一校验角色、scope、节点范围及高危操作许可。空节点列表表示无节点权限，`["*"]` 表示全部节点。

应用中心的部署实例可直接进入对应 Docker/Compose、systemd 和终端页面，预填节点与目标；自定义动作预填已声明的同名实例参数，检查后确认执行。拓扑按准确容器身份、Compose 标签和同节点唯一应用探针端点展示资源关系，未确定目标保留未关联。

远程操作返回任务编号，在任务中心查看日志和结果。非幂等任务最多尝试一次；失联后结果无法确认时标记 `UNKNOWN`，等待 Agent journal 对账。

## 文档

- [开发计划与验收范围](docs/PLAN.md)
- [部署、备份与恢复](docs/DEPLOYMENT.md)
- [数据库模型与维护](docs/database.md)
- [API 与 MCP 参数](docs/API.md)
- [Agent 安装与配置](agent/README.md)

许可证：[Apache-2.0](LICENSE)。
