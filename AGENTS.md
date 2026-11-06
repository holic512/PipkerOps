<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## 前端组件：开发前必读

页面、表单或交互修改前依次阅读 [组件索引](docs/UI_COMPONENTS.md)、[界面规范](DESIGN.md)，查看索引中的真实业务示例和目标组件源码。`components.json` 指定 shadcn/ui 本地源码目录 `src/components/ui`，导入使用 `@/components/ui/<name>`；业务组合从 `@/components/shared` 或索引注明的业务文件导入。不要把配置中的 registry 组件名称当作已安装能力。

执行顺序：查现有组件及调用点 → 直接复用 → 组合 → 必要时扩展公共契约 → 最后才新增组件和业务实现。新增前用 `rg` 检索同类能力；新增/契约变更同步更新组件索引、必要示例及本文件相关约定。

- 按钮用 `Button`；链接操作用 `variant="link"`，跳转用 `asChild` 包裹 `Link`。输入、文件、数字用 `Input`，多行用 `Textarea`，普通选项用 `NativeSelect`，勾选用 `Checkbox`。保留原生 `onChange`、`FormData` 契约，不混用 Radix Select 的 `onValueChange`。
- 简单资源表单用 `ResourceForm`，联动、文件上传和编辑器用语义 `<form>` 组合公共控件。字段始终有 label，提交按钮明确 `type="submit"`；其余 `Button` 默认 `type="button"`。
- 表格用 `DataTable`（支持 ReactNode 表头）；`tr/td/th scope="row"` 作为语义内容可以保留。业务页不得复制 `table` 外壳、滚动容器和表头处理。
- 弹窗和确认用 `BusinessDialog` / `ConfirmDialog`；操作沿用 `useOperation`，保留忙碌保护、同框核对和焦点恢复。普通标签视图用 `ViewTabs`；筛选浮层用 `Popover`；动作菜单用 `DropdownMenu`。业务层不得直接导入 Radix 自建基础交互。
- 原生 HTML 用于 `main/section/form/label/fieldset` 等语义结构。禁止用原生交互控件或 `div role="button/dialog/menu"` 复制已有能力。确有业务布局需要的资源卡片、树拖拽/展开、终端多面板选择等原生按钮，须逐个填写 `data-ui-native="具体理由"`，审查时核对理由；不得为普通按钮申请例外，也不得用 ESLint disable 批量绕过约束。
- 颜色、字体、尺寸来自 `src/app/tokens.css`；公共组件外观在 `globals.css` 集中维护，Tailwind 仅使用语义颜色及既有布局。禁止业务色板、任意色值、逐页暗色覆盖；主题只用 `ThemeProvider/useTheme`。树缩进、图表坐标、指标宽度等数据布局可以动态计算。
- 不引入第二套 UI 框架或 CSS-in-JS 方案。不为了“组件齐全”预装日历、抽屉等；出现真实需求时先评估组合，再按现有 Radix/shadcn 路线补齐，并补文档与验证。

交付前执行 `npm run lint`、`npm run check`、相关测试；公共组件变化执行构建，并查看代表页面的亮/暗主题、窄屏与键盘交互。现有 CI 会执行 ESLint 组件规则及其回归测试；遇到违规应修复组件选择，不增加全局豁免。审查清单见组件索引末尾。

## 长期资源身份

`Resource.id` 为平台 UUID，应用通过 `ApplicationResource` 多对多引用。容器 ID 只表示实例；新增应用关联使用资源选择器。资源定位仅使用已确认的 Compose 项目/服务、`pipkerops.resource-id` 标签或固定完整名称；禁止失败后降级或猜测。资源写操作先重新发现并核对已确认实例，操作与终端会话保留执行时的实例身份。旧 Deployment 记录保留并经资源页确认规则。详见 `docs/RESOURCES.md`。

## 组件版本

每次提交前按实际影响维护独立版本：Ops 为 `package.json`（同时同步 `package-lock.json`），Agent 为 `agent/VERSION`，部署脚本为 `deploy/VERSION`，PipkerOpsSkill 为 `skills/VERSION`。受影响组件通常递增补丁号；大版本或次版本依用户要求调整。跨组件或共享接口修改时评估并递增所有受影响组件的版本，不修改无关组件版本。

## 会话与节点遥测

浏览器 Session 只通过 `src/lib/session-store.ts` 访问 Redis，禁止重新使用 Prisma Session 或数据库会话夹具。用户角色仍以数据库为准，Redis 故障不得放行。节点列表/选择器使用 nodes.summary，详情使用 nodes.get 和分类 nodes.snapshot；完整 nodes.list 仅保留兼容场景。实时缓存不能作为资源写操作或任务事实依据。指标接收队列仅允许合并遥测，禁止丢弃任务日志、结果与 ACK；新增指标同步维护单位、空值、设备身份及小时聚合契约。
