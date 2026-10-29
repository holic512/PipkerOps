# PipkerOps

面向个人开发者与 10–50 台 Linux 节点的轻量集群运维平台。Go Agent 主动连接主控；Next.js 管理端、Gateway 与 Worker 共用 PostgreSQL 任务事实源。

项目正在开发，整体尚未验收完成。功能阶段、验收缺口及技术决策见 [开发计划](docs/PLAN.md)，数据模型见 [数据库文档](docs/database.md)，部署与恢复见 [部署文档](docs/DEPLOYMENT.md)，接口与工具参数见 [API契约](docs/API.md)。页面不填充模拟节点或业务数据。

## 本地启动

需要 Node.js 22.12+、Go（以 agent/go.mod 为准）、PostgreSQL 与 Redis。生产公网必须使用 HTTPS/TLS；本地开发 Web 可绑定 127.0.0.1。

```sh
npm ci
cp .env.example .env
# 编辑 .env，设置数据库、Redis、管理员随机密码和服务地址
npm run db:generate
npm run db:deploy
npm run bootstrap
npm run pki:init
# 本地开发设置 APP_ORIGIN=http://127.0.0.1:3000
npm run dev
# 分别在另外两个终端运行
npm run gateway
npm run worker
```

打开 http://127.0.0.1:3000，使用 `.env` 的管理员邮箱和密码登录。`bootstrap` 不覆盖已有账户。API、页面及后台都连接真实数据库；后端不可用会显示明确错误。

在节点管理生成注册令牌，将 CA 公钥安全复制到节点，按 [Agent 安装说明](agent/README.md) 安装 Agent；核对节点后在管理端批准。CA 私钥只留在主控。TLS 注册端口默认9444，mTLS长连接默认9443。

`.env`、PKI、Agent身份、构建产物和浏览器状态均被忽略。Git 仅保存 `.env.example` 等示例。提交前执行 `node scripts/check-secrets.mjs` 检查暂存区。

## 验证

```sh
npm run db:validate
npm run check
npm run lint
npm test
npm run build
cd agent && go test ./...
```

真实联调使用 `AGENT_BINARY=/absolute/path/to/pipkerops-agent npm run test:integration`（需运行Web/Gateway/Worker，Worker用 NODE_EXTRA_CA_CERTS 指向私有CA以验证本地HTTPS夹具）。`npm run test:linux`另需Docker-in-Docker镜像与9543/9544验收Gateway，见部署文档。真实联调会创建唯一前缀资源并清理，保留审计。权限、任务恢复及部署验证记录维护在开发计划中，不将单独构建成功视为整体功能通过。

## API 与 MCP

Web 使用 `POST /api/rpc`，请求为 `{ "method":"nodes.list", "params":{} }`，返回 `{ "data":... }` 或 `{ "error":"..." }`。会话必须同源；独立 API Key 使用 `Authorization: Bearer ...`。接口均在服务端验证角色、scope、节点范围及高危限制。

MCP 为 `/api/mcp` 的标准无状态 Streamable HTTP。工具名称由方法名中的 `.` 替换为 `_`，参数为 `params` 对象，执行同一业务服务。API Key 空节点列表表示没有节点权限；`["*"]` 才表示全节点。原始密钥只显示一次，吊销立即阻止后续请求。

## 任务约束

远程操作返回持久化任务编号，日志/结果在任务中心查询。任务状态包括 QUEUED、DISPATCHED、RUNNING、SUCCEEDED、FAILED、CANCELLED、UNKNOWN。非幂等任务只允许一次执行尝试，失联时保留 UNKNOWN，等待 Agent 本地 journal 对账，禁止盲目重试。

Apache-2.0，详见 LICENSE。
