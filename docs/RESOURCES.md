# 节点、长期资源与应用

节点承载运行实例；Resource 使用平台生成并持久保存的 UUID，与容器 ID、镜像和名称无派生关系。ApplicationResource 保存多对多关系，资源可独立存在；解除一个应用或删除应用只移除其引用。Deployment 保留历史目标及探针契约，新容器关联使用资源选择器。

## 界面流程

1. Docker / Compose 选择节点，在容器行点“登记为资源”。已有资源显示“管理资源”。
2. 填写资源名，确认节点，明确选择定位策略，预览匹配实例和重复资源。预览后修改输入需要重新预览，提交时再次验证已预览规则。
3. 应用中心“选择资源”关联已登记资源。资源详情可关联多个应用、解除单个引用、编辑名称、重新发现或重新指定实例及规则。
4. `/resources` 支持节点、类型、识别状态、运行状态和应用筛选；`/resources/:resourceId` 为长期详情入口。节点详情和应用、拓扑均链接此资源身份。
5. 资源详情选择当前实例后读取日志、启停、重启、删除实例或打开工作台；Compose 服务可进入现有配置编辑器。确认框列出受影响应用。删除实例后仍保留资源和应用关系。

## 定位契约

| 策略        | 精确匹配范围                                                         | 副本与重建约束                                 |
| ----------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| compose     | nodeId + `com.docker.compose.project` + `com.docker.compose.service` | 一个服务资源可有多个容器；操作必须选择具体实例 |
| label       | nodeId + `pipkerops.resource-id` 完整值                              | 单实例；重复标签产生冲突；部署配置须保存标签   |
| name        | nodeId + 完整容器名                                                  | 用户明确接受名称跟踪；重建须保持名称           |
| unconfirmed | 不匹配                                                               | 历史数据等待用户确认规则                       |

不按相似名称、镜像、端口或 IP 匹配，也不自动在策略之间切换。标签值是定位字段，与平台 resourceId 分开保存。标签策略只接受当前实例已实际携带标签且用户确认已写入部署配置的登记。界面生成可复制审查的配置片段；平台不修改实际配置或擅自重建现有业务容器。

```yaml
services:
  api:
    image: your-image:tag
    labels:
      pipkerops.resource-id: "固定部署标签值"
```

独立容器应把 `--label pipkerops.resource-id=固定部署标签值` 保存在实际 `docker run` 脚本里。仅在数据库保存 UUID 不会为容器添加标签。配置由操作者审查保存并在获准的部署中使用；既有无标签容器可明确使用固定名称策略。

## 发现与状态

发现复用 Docker HTTPS 查询，完整 `docker ps -a --no-trunc` 后逐个 inspect，权威标签、名称、运行状态及退出码均从 inspect 获取。任一实例查询失败视为不完整采集，保留旧实例及所有关联，显示 STALE。Agent inspect 输出仅新增 Config.Labels，不暴露环境变量。

资源列表每 15 秒查询；每节点最多每 60 秒触发一次完整发现，`lastAttemptedAt` 控制失败重试，`lastDiscoveredAt` 只记录完整成功采集，`lastSeenAt` 记录匹配到实例的时间。节点离线、连接错误或过期数据显示 STALE。操作执行前立即重新发现，不依赖列表缓存。

识别状态 LOCATED / MISSING（缺失、待确认）/ CONFLICT / STALE / UNCONFIRMED 与运行状态 RUNNING / STOPPED / FAILED / PARTIAL / UNKNOWN 分开。退出码非零、dead 或 restarting 为运行失败；业务健康仍依据应用探针。MISSING 保留规则和资源，允许用户重新指定；单实例多匹配禁止操作；Compose 多副本不算冲突。

## 操作、权限与迁移

`resources.*` 契约共用 Web/MCP。资源读取和编辑使用 `resources:read/write`，发现需要 `docker:read`，关联需要 `apps:write`，生命周期继续使用原 Docker 高危权限与确认。新 API Key 可选择资源 scope；旧 key 不自动扩权。删除应用校验所有资源所属节点权限。

资源操作提交 resourceId 与用户确认的 expectedContainerId。执行前解析固定规则，实例变化、过期或冲突均拒绝，要求刷新后重新确认。DockerOperation 保存 resourceId、实际 target 和 resolvedContainerIds，审计记录受影响资源及应用。Compose 操作针对整个项目，记录所有当前项目容器；操作入口的 resourceId 不改变项目整体更新语义。幂等重放首先查询原请求，保留旧摘要兼容和原实例，不重新解析为新容器。终端 ticket 和关闭审计保存 resourceId 与 containerId；已建立会话保持原目标。

迁移 `202611040001_stable_resources` 不修改业务容器。仅相同 node/type/target 的旧部署合并到同一新 UUID，保存 metadata.legacyTarget 并保持旧 Deployment、Probe 和历史操作。由于旧记录没有明确跟踪策略，统一标为待确认；用户从已有资源“重新指定”确认后保留原关联。历史精确目标会参与重复登记提示，避免另建资源丢失原引用。资源不会因发现缺失、解除关联或删除应用而删除。

## 验证入口

- `npm test`：精确规则、Compose 多副本、保守 SQL 迁移及现有回归。
- `node --import tsx --test tests/resources.integration.ts`：独立 PostgreSQL 与 HTTPS Agent 传输夹具，覆盖共享、丢失、冲突、不完整发现、重新指定及权限。
- `npm run test:docker`：独立 PostgreSQL、Redis、Docker-in-Docker 与真实 Agent。实际保存 Compose 标签配置，登记 A、关联两个应用、重建 B，检查身份与关联、旧请求重放以及新操作指向 B；仅清理测试创建的容器。
- `DOCKER_UI_TEST=true npm run test:docker`：上述测试后保留临时页面供浏览器验收；用生成的临时测试会话，不使用用户登录态；结束时向该测试进程发送 SIGINT 自动清理。

## 本次实际验证（2026-11-04）

`npm run lint`、`npm run check`、`npm run db:validate`、生产构建及 Agent 测试通过；`npm test` 82/82，资源 HTTPS/数据库服务集成 1/1，完整 Docker-in-Docker 集成 8/8。Docker 验收实际保存标签配置并重建，验证 containerId 改变、resourceId/双应用引用不变，后续操作指向新实例，旧操作重放保持原实例；也覆盖重建后的裸 Docker 操作资源归属和 Compose 项目实例审计。

隔离浏览器验证登记→预览→确认、资源/应用双向关联与解除、共享操作影响提示、拓扑 resourceId 跳转、亮色桌面、暗色窄屏和键盘焦点；窄屏表格内部滚动，页面无横向溢出。测试仅操作自建隔离资源，未执行现有环境迁移或重建业务容器。依赖现有运行环境的独立 `test:linux` 脚本已适配新关联接口，本次未单独执行；实际 Docker 行为由上述独立 DIND 回归验证。

部署时先执行仓库迁移流程，并配套更新 Agent 至 0.1.4（inspect 增加权威标签字段）。旧 Agent 缺少标签契约会保守显示采集过期，不能据此删除资源。
