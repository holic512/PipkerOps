# 组件索引与开发约定

本文件是页面开发入口，须与组件源码一起阅读。颜色、密度、亮暗主题见 [DESIGN.md](../DESIGN.md)；审计依据见 [UI_AUDIT.md](UI_AUDIT.md)。组件源码本地维护，`components.json` 只是生成配置，不代表 registry 中的所有组件已安装；当前没有可追溯的 shadcn CLI 版本记录。禁止为更新样式批量运行 CLI 覆盖本地业务契约。

资源业务入口：`managed-resources.tsx` 的 `ManagedResources` 使用 `/resources` 和 `/resources/:resourceId`，组合公共表格、表单与业务弹窗，负责筛选、登记预览、共享关联及重新指定；容器登记从 `docker-manager.tsx` 进入。应用通过 `resources.associate/unlink` 选择稳定资源，禁止新增手填容器 ID 的应用关联。Docker 的 `OperationDialog` 供资源页复用，展示原操作固定的资源和实例 ID。定位及迁移约定见 [RESOURCES.md](RESOURCES.md)。

## 基础层完整清单

导入路径均为 `@/components/ui/<文件名>`。下列为实际导出能力，未列出的属性以源码类型为准。

| 文件 / 导出                                                                                  | 主要属性与契约                                                                                                                                                    | 使用场景 / 边界                                                                                                            |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `button` / `Button`                                                                          | 原生 button props、`variant=default/outline/ghost/destructive/link`、`size=default/sm/icon`、`asChild`；默认 `type=button`                                        | 普通操作、危险动作、图标、文字操作；表单提交明确 `type=submit`；导航用 asChild + Link，图标必须有 aria-label               |
| `table` / `DataTable`                                                                        | headers: ReactNode[]、children、label、className；shared 中保持同名兼容导出                                                                                       | 表格外壳、列标题和可聚焦的横向滚动区域，不内置排序/分页                                                                    |
| `input` / `Input`                                                                            | 原生 input props，包括 ref、type、name、value/defaultValue、onChange、required、min/max、accept                                                                   | 文本、密码、数字、email、文件、日期等浏览器输入；勾选用 Checkbox                                                           |
| `textarea` / `Textarea`                                                                      | 原生 textarea props，包括 rows、readOnly、value/defaultValue、ref                                                                                                 | 多行、JSON、YAML、文件文本；禁止另做有自己主题的文本框                                                                     |
| `native-select` / `NativeSelect`                                                             | 原生 select props + option/optgroup children；onChange(event)，支持空值、disabled、name、FormData                                                                 | 普通枚举、节点、主题、版本筛选。它不是 Radix Select，不使用 onValueChange；不承诺搜索/异步选项能力                         |
| `checkbox` / `Checkbox`                                                                      | 原生 input props，固定 type=checkbox；checked/defaultChecked、onChange、ref                                                                                       | 表单、标签筛选、批选。保持原生 onChange(event)、FormData 的 on 值及 ref.indeterminate，**不是** Radix onCheckedChange 契约 |
| `dialog` / `BusinessDialog`                                                                  | title、description、open=true、onClose、size=confirm/form/detail、operation、formId、submit、disabled、footer、readOnly                                           | 编辑、导入、详情；正文独立滚动；提交锁定退出；同框核对并保留输入；恢复触发点焦点。表单通过 formId 关联底部提交             |
| `dialog` / `ConfirmDialog`                                                                   | title、description、open、busy、error、onConfirm、onClose                                                                                                         | 独立危险动作确认；优先交给 useOperation.ask，不再次套一层弹窗                                                              |
| `dialog` / `DialogOperation`                                                                 | busy、feedback、confirmation、confirm、back                                                                                                                       | useOperation(..., true) 可直接作为 BusinessDialog.operation                                                                |
| `tabs` / `Tabs, TabsList, TabsTrigger, TabsContent`                                          | Radix 对应 props；value/onValueChange，Trigger/Content 的 value 必须配对                                                                                          | 复杂标签布局，Radix 提供方向键、Home/End、tablist/tab/tabpanel 关联                                                        |
| `tabs` / `ViewTabs`                                                                          | value、onValueChange、label、items: {value,label}[]、children                                                                                                     | 普通业务视图；仅当前内容挂载，切换时沿用现有条件渲染；多终端分屏/跨页保活另见 RemoteWorkspace                              |
| `popover` / `Popover, PopoverTrigger, PopoverContent`                                        | Radix Root/Trigger/Content props；Trigger asChild；Content 默认 align=start、sideOffset=5，自动 Portal                                                            | 含复选框/输入的筛选面板；自动 Escape、外部点击关闭、焦点恢复。必须提供可访问名称；不用于危险确认                           |
| `dropdown-menu` / `DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem` | Radix props；Root 默认 modal=false，行操作不隐藏整个工作区；Content 默认 align=end、sideOffset=5；Item 增加 destructive；动作使用 onSelect，支持 asChild/disabled | 操作菜单和链接菜单；统一键盘、焦点和关闭。含表单的筛选用 Popover，不能把菜单项当任意表单容器                               |

Input / Textarea / NativeSelect 是项目按 shadcn 本地源码方式维护的薄封装；Checkbox 为保留既有浏览器契约的本地控件。不要声称它们是某版 CLI 原样生成的产物。所有外观复用 tokens 与 globals.css，不额外维护 Tailwind 默认色板。

## 业务组合完整清单

`@/components/shared`：

| 导出                     | 属性 / 用法                                                                                                                                          | 能力边界                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PageTitle`              | title、children（右侧操作）                                                                                                                          | 标题与操作自动换行，统一页面间距                                                                                                                                           |
| `DataTable`              | headers: ReactNode[]、children、label（默认“数据表格”）、className（滚动容器）                                                                       | 自动可键盘聚焦的横向滚动区域、列标题 scope=col。children 写 tr/td；行标题用 th scope=row。复杂表头传 Checkbox 等节点；不内置排序、过滤、分页或虚拟列表                     |
| `ResourceForm` / `Field` | fields、onSubmit(data)、busy、disabled、submit、id、hideSubmit、children；Field 的 name/label/type/options/defaultValue/required/placeholder/min/max | 非受控简单字段；支持 text/number/textarea/select/json/checkbox/password/email；JSON 解析错误在表单内显示；空字符串字段不提交。复杂联动与文件上传用自定义 form 组合基础控件 |
| `QueryState`             | loading、error、empty、retry、children、emptyTitle/emptyText                                                                                         | 统一加载、错误、重试和空态；按数据含义填写空态文案                                                                                                                         |
| `Status`                 | value、label?（覆盖业务文字）                                                                                                                                                | 统一状态文字、颜色和圆点，未知值保留原文；不要逐页复制 status-* 徽标逻辑                                                                                                   |
| `Feedback`               | value: {message,error?}\|null、onClose                                                                                                               | 固定位置操作反馈，成功 role=status、失败 role=alert；useOperation 已包含它                                                                                                 |
| `JsonView`               | data                                                                                                                                                 | 只读格式化 JSON，与日志共用代码块主题                                                                                                                                      |
| `useQuery<T>`            | method\|null、params={}、refreshInterval=15000                                                                                                       | SWR + RPC；null 不请求，0 关闭轮询。加载、错误用 QueryState 呈现                                                                                                           |
| `useOperation`           | onSuccess?、inline=false；返回 run/ask/busy/feedback/confirmation/confirm/back/clear/ui                                                              | run 处理异步反馈；ask 等确认后执行；默认渲染独立确认框与反馈（插入 op.ui）。弹窗内用 inline=true 并传 operation，避免叠加确认框                                            |

其他可复用入口：

| 文件 / 导出                                                                         | 使用与范围                                                                                                                              |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@/components/theme-provider` / ThemeProvider、useTheme、ThemeSwitcher              | 根布局提供唯一主题上下文；useTheme 返回 preference、resolvedTheme、setPreference；普通组件通过 CSS Token 继承主题                       |
| `@/components/node-editor` / NodeLabels、FolderSelect、NodeEditor、NodeImportDialog | NodeLabels 展示标签；FolderSelect 使用 folders/value/onChange/label；节点编辑和导入由列表、详情复用，导入含文件读取、测试连接、凭证清理 |
| `@/components/nodes` / NodeCells、NodeIdentity                                      | 节点列表和树表格共用身份、指标、连接信息；不作为通用表格库                                                                              |
| `@/components/resource-history` / ResourceHistory                                   | 节点资源类别、时间范围、历史图与采样值对话框；图表坐标可以动态计算，色彩必须用 Token                                                    |
| `@/components/remote-workspace` / RemoteWorkspace                                   | visible 控制持久工作台展示；文件树与终端会话跨页保留，支持分屏。不能机械改成仅挂载当前面的 ViewTabs                                     |
| `@/components/remote-files` / RemoteFiles                                           | 专用目录树、文本读写、新建和删除，复用公共控件和弹窗；不是通用树组件                                                                    |
| `@/components/terminal-session` / TerminalSession                                   | xterm/WebSocket 生命周期与主题同步，作为终端专用集成保留                                                                                |

其余页面入口（applications、backups、console、docker-manager、node-manager、nodes、operations、topology、updates）负责业务数据和页面组合，不应被当作第二套基础控件目录。第三方 React Flow 与 xterm 分别用于图与终端，不能替代普通 UI 控件。

登录页由 `src/app/login/page.tsx` 在运行时读取 `REQUIRE_HTTPS`，仅将布尔值传给 `@/components/login` 的 `Login`；表单沿用 Input、Button、ThemeSwitcher。服务端配置和凭据不得导入客户端。关闭 HTTPS 要求时允许 HTTP 登录；开启时保留协议提示和禁用状态。

## 尚未安装的能力

- 抽屉、日历/日期范围、搜索式 Combobox、通用分页、复杂 Data Grid、Toast 队列、独立 Badge/Card/Label：当前无必须新增的调用场景，不能仅凭 shadcn registry 假定可导入。
- 标签展示已有 NodeLabels / Status；通知已有 Feedback；导航已有 Console 的 Link 与访问标签；表面已有 panel/surface。不要再封装名称不同但职责相同的组件。
- 出现日期需求时先判断 Input type=date/datetime-local 是否足够；确需日历/范围选择才基于 shadcn 路线补齐。分页先确认服务端契约、总数与页码，再组合 Button + nav 并提炼公共组件。抽屉先确认真实交互需求再基于 Radix，禁止手写 fixed 遮罩代替。

## 页面示例与选择流程

可编译示例在 [examples/resource-page.tsx](examples/resource-page.tsx)：接收外部业务数据与保存回调，展示标题、查询状态、表格、标签、表单弹窗、同框确认和保存反馈；不注册生产路由、不伪造业务 API。它同项目一起接受类型检查。

真实页面参考：

- 节点管理：`src/components/node-manager.tsx`，Input 搜索 → Popover 标签筛选 → DataTable 复选框表头 → NodeEditor。树拖拽与展开是带明确理由的业务按钮例外。
- 系统运维：`src/components/operations.tsx`，NativeSelect 节点 → ViewTabs 选择动作 → ResourceForm → 任务结果 BusinessDialog。字段选项、危险确认和 API 权限由业务逻辑决定。
- Docker：`src/components/docker-manager.tsx`，DataTable → Button variant=link 详情 → DropdownMenu 操作。菜单关闭后进入原有业务弹窗/确认流程。
- 节点导入与远程文件：`node-editor.tsx`、`remote-files.tsx`，自定义 form + Input/Textarea/NativeSelect/Checkbox。复杂表单不必强塞 Field 配置。

新增前执行 `rg '所需能力|组件名' src/components docs/UI_COMPONENTS.md`，打开源码和一处调用。能力足够则复用；可以组合则在页面组合；确有多个调用需要时扩展公共契约；只有明确缺口才新增 `ui` 基础控件或领域组件。不要新增只有一处使用、没有清晰职责的包装层。

## 审查和自动检查

1. 是否先检索现有能力，新增/扩展是否已更新索引、契约与示例？是否复制了原页面的基础交互或 CSS？
2. 语义 form/label/fieldset/tr/td 合法；普通基础控件必须走组件。`data-ui-native` 仅用于必要的原生业务按钮，理由需人工核实，不能用来跳过 Button 的正常能力。
3. 交互是否具备 label、焦点、禁用/忙碌、加载/空/错态？菜单是否用 onSelect，表单是否明确 submit，表格是否有业务 label？
4. 是否新增了业务色板、CSS-in-JS、硬编码颜色、第二 UI 框架或逐页主题状态？数据布局与第三方专用集成可保留。
5. 执行 `npm run lint`（四条本地 UI 规则）、`npm run check`、`npm test`；公共组件变动执行 `npm run build`，按范围检查亮/暗、窄屏和键盘。

本地规则在 `scripts/eslint-ui-rules.mjs`，通过 `eslint.config.mjs` 接入现有 CI；`tests/ui-rules.test.ts` 用违规样例和实际配置验证。主题测试继续检查 Token 完整性、对比度与颜色硬编码。AST 检查不能识别所有重复业务逻辑或所有 CSS 技巧，故保留人工组件选择审查与渲染验证；不设历史违规 baseline，也不允许对整个业务目录静默放行。

## 版本更新工作区

`@/components/updates` 的 Updates 组合 NativeSelect/Input、Status、DataTable 与 BusinessDialog，采用目标/目录/发布选择和版本核对侧栏。节点路径来自已登记数据，允许明确清空，不猜测安装路径；验证绑定组件、节点、目录，更换任一项即失效。目标版本由 updates.preview 读取正式清单，不能解析发布标题猜测；同版本阻止重复更新，降级在核对框明确标注。提交使用 useOperation 忙碌保护与稳定幂等键，核对框内反馈失败。

近期任务取 tasks.list 返回范围内的平台更新，展示最近5项；任务窗口轮询父/子执行记录，展示实际准备阶段、执行与版本确认及错误，UNKNOWN不标成完成。关闭不取消任务并恢复稳定触发点焦点，刷新页面后从近期任务重新查看。数据阶段与版本比较共用客户端安全的 update-status，颜色沿用Token，不画虚构下载百分比。

## 节点监控组合

采集质量 `CollectionQuality` 使用图标/类别/状态、成功时间与耗时、失败原因、处理建议的分层卡片；长错误仅在摘要限制两行，Button 进入采集详情查看完整原因。正常卡片不重复通用排障文案。`Status` 允许可选 `label` 覆盖业务文字，颜色仍由既有 `value` 状态语义决定，未传时保持原有文案。

`ui/chart` 的 `CoreUsageChart` 接收 `cores: {name, value: number|null}[]` 与 `stale`，以每核一行的分段条和精确百分比展示当前采样；小于一个分段的非零读数保留部分填充，缺失/过期不绘制有效占用。保持现有主题颜色，不引入参考图的终端配色。趋势线端点、条形末端、环图扇区及提示框统一适度圆角，趋势仍按真实采样线性连接并保留缺口。

对象历史升级（Ops 0.1.22 / Agent 0.1.7）：`ui/chart` 同时导出 `TrendChart`（series、unit、label）、`StateDonut`（slices、label）、`RankChart`（data、unit、label）。趋势保留 null 断点、单图单单位；排行数轴允许超过100%；状态环始终配文字图例。图形使用 Recharts 与主题 Token，交互入口使用 Button，趋势支持 Recharts 键盘访问。

`monitoring-dashboard` 的 MetricTrend、ProcessRanking、ObjectDistribution、CollectionQuality 组合资源历史和分类快照。`monitoring-workspace` 在七个标签外保存设备、表格筛选及对象选择；`object-history` 的 ObjectActions、ProcessWatches、ObjectHistory 提供准确实例关注、最多5对象比较、日期范围和观察事件分页。返回恢复触发按钮焦点及原筛选。CPU 核心热力图仅当前采样；系统信息继续用信息表。

`@/components/ui/chart` 新增 `ChartContainer` 与 `RingChart`，按 shadcn/ui 的本地源码组合方式接入 Recharts 3.10.1（专用图表库，不是新增 UI 框架）。ChartContainer 统一响应式容器；RingChart 接收 label、value、total=100、composition、muted、danger 与中心 children，使用 Recharts Pie/PieChart 绘制环，不在业务页复制 SVG。颜色来自 chart/border/danger Token，静态图形 inert，外层提供文字等价的可访问名称；查看历史仍由 Button 操作。无效/缺失值只画灰环，0 是有效观测，0/0 为无活动而非占用百分比，超过 100% 仅限制圆弧、保留真实文字。参考 [环图示例](examples/ring-metrics.tsx)。

实时概览 CPU/内存/Swap/容量使用占用环，负载使用归一化百分比；网络和 IO 使用收发/读写占比，中心保留实际速率和单位，不冒充带宽或磁盘性能利用率。`ring-chart.ts` 的计算/速率单位格式化有独立回归。

`@/components/node-monitoring` 导出 NodeMonitoring（nodeId、view）与 NumericHistory（nodeId），组合现有 DataTable、QueryState、NativeSelect 与 ResourceChart。业务视图为实时、设备、进程/连接、服务/容器、系统和诊断；只加载当前分类。`@/components/resource-history` 的 ResourceChart 现支持数值历史单位，不再只将非百分比都解释为 B/s。

`@/components/node-events` 的 useNodeEvents 在 Console 中只挂载一次，SSE 仅触发 SWR 定向刷新；隐藏页面关闭流，返回页面刷新。useQuery 显式关闭后台和离线轮询。监控布局在 globals.css 的 node-monitoring 集中维护，复用现有 Token。

节点明细行的身份由 `src/lib/monitoring-rows.ts` 生成：监听端口使用 PID、协议、地址、端口和可用的 fd 组合，不能只使用 PID；指标使用 metric/device，挂载使用 mountpoint。完全相同的重复观测保留并附重复序号，不静默删除。

NodeMonitoring 兼容旧 Agent 的已上报基础指标：实时数值由服务端转换为指标序列；网络和 IO 展示累计计数，速率仍通过资源历史查看；旧进程列表不标为 CPU 排行。旧采样缺失的明细提示升级 Agent 并提供版本更新入口，无采样不能误报为旧 Agent。禁止将累计计数标成瞬时吞吐或用零填充未采集指标。

NodeMonitoring 在各分类上方组合 DataTable 展示采集诊断：当前状态、采样时间、最近完整成功、耗时、错误和截断处理建议；“采集详情”汇总所有分类，JSON 仅为辅助。`src/lib/monitoring-availability.ts` 统一九种指标可用性及原因；无采样、过期、旧 Agent、缺基线、无设备世代身份必须区分，有效零值仍显示零。容器无健康检查或 Compose 归属显示不适用，inspect 失败单独显示原因。已有数值系列允许可选 status/reason，不改变单位、null 或历史聚合含义。

实时概览顶部按所选磁盘、网卡和 IO 设备展示七类资源摘要，明细与诊断位于下方。明细表组合 Input/NativeSelect/Checkbox 支持搜索、排序、设备及异常筛选；只针对已采集范围，不暗示完整进程清单或近期重启频率。`monitoring-explorer.ts` 维护筛选和准确设备历史目标。NodeMonitoring/NumericHistory 可接收受控 historySelection/selection 与更新回调；节点详情持有时间范围、指标及设备，兼容指标之间切换保留设备，跨类别清理无效设备。查看历史使用 Button，定位并聚焦页面下方历史区域；采样缺口和单位继续由现有 ResourceChart 处理。

`@/components/cluster-monitoring` 的 ClusterMonitoring 用于集群总览，读取 nodes.monitoring 的授权紧凑投影，组合 Input、NativeSelect、DataTable、QueryState 和链接 Button。支持节点/标签/异常搜索、状态筛选、资源降序排行；无法确认的指标保留空值。节点详情接受经过白名单校验的 monitor 查询参数及纯文本 context，展示来源上下文并打开对应分类。

监控状态追加约定：进程/网卡的 fieldErrors 用于显示实际字段失败原因；缺基线与其他对象失败隔离。实时概览按使用率 ≥85%、归一化负载 ≥100% 提示偏高。集群长期无采样按实时资源采样判断，CPU/内存排行进入实时概览；持久快照来源与是否过期分别展示，不将缓存回退本身当成指标过期。
