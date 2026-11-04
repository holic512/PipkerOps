# shadcn 组件体系审计与改造记录

审计日期：2026-11-04。范围：管理端 `src/app`、`src/components`、全局主题、构建配置、Agent 入口与现有 CI；不改 Go Agent、部署、运维 RPC 和业务权限契约。审计开始时工作树无修改。基线证据路径及行号指改造前版本；当前使用契约以 [UI_COMPONENTS.md](UI_COMPONENTS.md) 和实际源码为准。

## 结论

项目已经复用多种公共业务组件，但基础 UI 层只有 Button 与业务 Dialog 两个文件。问题主要是能力缺口、文档允许旁路和缺少组件约束，并非整个项目拒用 shadcn，也未发现第二 UI 框架或业务色板失控。单纯要求“使用 shadcn”不能解决组件不存在、契约受限和规则相互矛盾的问题。

当前业务所需的输入、简单表单、表格、标签切换、筛选浮层、操作菜单、弹窗与反馈已形成统一路径。复杂表格排序/分页、搜索选择器、抽屉与日历没有现成完整实现，新增业务时仍需按需扩展；不能声称组件库覆盖所有未来需求。

## 配置与安装核验

| 项目            | 实际证据 / 判断                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| shadcn 配置     | `components.json`：new-york、rsc=true、tsx=true、slate、cssVariables=true、lucide，ui=`@/components/ui`，utils=`@/lib/utils`                                             |
| 安装方式 / 版本 | 本地源码 + Radix 原语；package/lock 未记录 shadcn CLI 依赖或生成版本，无证据认定由哪个 CLI 版本生成。shadcn 组件不能用一个运行库版本号代表；以本地源码与锁定原语版本核验 |
| 改造前基础层    | `ui/button.tsx` 使用 CVA + Radix Slot；`ui/dialog.tsx` 是含业务核对流程的 Radix 封装，非完整 registry 组件集合                                                           |
| React / Next    | React 19.3.1、Next 16.4.3；已阅读安装包中的 use-client 与 CSS 指南，保留 App Router、客户端边界和根布局全局 CSS 入口                                                     |
| 样式工具        | Tailwind 4.3.3、@tailwindcss/postcss 4.3.3，PostCSS 配置正确；Tailwind 配置项为空与现有 CSS-first `@theme inline` 相符，不能当作漏配                                     |
| 合并 / 变体     | class-variance-authority 0.7.1、clsx 2.1.1、tailwind-merge 3.7.0；`cn` 已统一合并，无必要增加样式依赖                                                                    |
| 主题            | `tokens.css` 同时定义亮/暗颜色与尺寸，`@theme inline` 映射语义颜色；dark 变体跟随根 data-theme；ThemeProvider / lib/theme 管理系统偏好和持久选择                         |
| 原语版本        | 改造前 dialog 1.3.1、slot 1.5.0；本次增加 tabs 1.2.1、popover 1.3.1、dropdown-menu 2.2.1，package-lock 精确锁定                                                          |
| 导入 / 目录     | tsconfig 的 `@/* -> src/*` 与 components.json 一致；目录容易定位，但缺少实际组件能力索引与 Agent 入口链接                                                                |
| 检查入口        | 改造前 eslint.config.mjs 只有 Next/TS 默认规则；CI checks 已跑 check/lint/test，因此直接接入现有检查，无额外维护扫描器或新的 CI 平台                                     |

## 基线能力与使用问题

统计口径：使用 TypeScript JSX AST 检查 app/components 的 23 个 TSX 文件，数字为源码调用点，不是运行时渲染控件数；含公共组件内部实现。

| 调用                                           |          基线数量 |
| ---------------------------------------------- | ----------------: |
| Button / BusinessDialog / ConfirmDialog        |      126 / 21 / 1 |
| DataTable / ResourceForm / Status / QueryState | 16 / 11 / 23 / 33 |
| 原生 button / input / select / textarea        |  22 / 19 / 14 / 4 |
| 原生 table / details                           |             4 / 2 |

完整组件导出、属性与适用边界已列入组件索引，以下记录审计时的缺口：

| 场景               | 原能力 / 源码证据                                                                                                          | 问题与处理                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 按钮               | button.tsx：四种 variant、三种 size、asChild                                                                               | 缺文字操作变体；applications:665 的 text-button 与 docker-manager:351/556 的 docker-resource-link 重复。增加 link 变体并删除两套旧类；关闭提示等普通按钮迁移 Button                      |
| 输入 / 选择 / 勾选 | shared.tsx:330–353 的 ResourceForm 自身渲染原生控件；login/page:75/86、theme-provider:74、updates:69/83/103/136 延续该方式 | 缺可导入的基础契约；补 Input、Textarea、NativeSelect、Checkbox，并迁移所有现有基础输入调用。保留浏览器事件、FormData、文件与批选契约                                                     |
| 表单               | ResourceForm 支持简单 Field 配置和同框确认                                                                                 | 非受控 defaultValue，不能覆盖文件、标签、联动与远程文件编辑；保留合理自定义 form，统一内部基础控件，不引入不必要的表单框架                                                               |
| 表格               | shared.tsx:136 的 headers:string[]                                                                                         | 无法放批选 Checkbox；node-manager:497、topology:561 手写复杂表头有实际理由。改为 ReactNode[]，DataTable 下沉 ui/table，shared 保持兼容导出，四处表格都经公共入口；表体语义 tr/td/th 保留 |
| 简单重复表格       | resource-history:255 的三列表格                                                                                            | 已有 DataTable 足够，直接迁移                                                                                                                                                            |
| 弹窗 / 确认        | BusinessDialog / ConfirmDialog + useOperation                                                                              | 已有正文滚动、焦点恢复、忙碌锁定和同框核对，无需替换。保留 21 处业务弹窗流程                                                                                                             |
| 抽屉               | 未安装、无业务调用                                                                                                         | 记录按需补齐，不新增第二弹层方案                                                                                                                                                         |
| 下拉动作 / 筛选    | docker-manager:428 details 内联动作区；node-manager:354 details 自绘标签浮层                                               | 各有用途，不能仅凭标签判错；本次统一为 Radix DropdownMenu / Popover，提供菜单键盘操作和浮层关闭/焦点行为                                                                                 |
| 日期 / 分页        | 无实际调用、无统一完整组件                                                                                                 | 不盲目添加；明确按真实数据契约补齐的流程                                                                                                                                                 |
| 导航 / 标签        | Console Link 导航、持久访问标签；四处业务 inner-tabs+button                                                                | 业务视图缺 tablist/tab/tabpanel 与方向键能力，改成 ViewTabs；终端分屏与跨页保活继续按 group 多面板行为维护                                                                               |
| 状态 / 标签 / 提示 | Status、NodeLabels、Feedback、QueryState                                                                                   | 已有统一文字、色彩与反馈，没有必要再加重复 Badge/Toast 系统                                                                                                                              |
| 颜色 / 布局        | tokens.css、globals.css、tests/theme.test.ts                                                                               | 未发现业务 TSX 硬编码颜色或第二套色板；保留树缩进、图表坐标、指标宽度等必要动态布局。将输入外观从页面范围的原生选择器收敛到公共 form-control 类                                          |

## Agent 绕过组件的可证实原因

以下是从仓库可观察到的开发路径分析，不代表能反推出每次历史生成的内部原因。

1. **组件能力**：只有两个基础 UI 文件，页面无法导入不存在的 Input/Select/Table 原语；ResourceForm 不支持复杂联动，DataTable 字符串表头阻止直接组合复选框。缺少 link 变体也导致文字按钮重复。
2. **项目结构**：共享 hooks、表单、表格、状态都藏在 `shared.tsx`，仅查看 ui 目录会低估已有能力；未提供按业务场景映射的索引。导入 alias 本身没有冲突，问题不在路径解析。
3. **Agent 指令**：原根 AGENTS.md 只有 Next 提醒和组件版本；未链接 DESIGN.md、能力索引或真实范例，没有“复用→组合→扩展”的执行顺序。PRODUCT.md 说采用 shadcn，但那不是可执行的组件选择规范。
4. **文档冲突**：原 DESIGN.md:32 允许页面内原生表单统一样式，:33 允许手写 table 添加类；:53 泛泛要求共用控件。这给模仿既有页面的 Agent 两种合法路径。现已删除旁路描述并与根指令对齐。
5. **约束不足**：原 ESLint 仅 Next/TS 规则；主题测试能阻止色值硬编码，却不能阻止原生按钮、重复表格、业务层直接使用 Radix。CI 即使通过也没有校验组件选择。现已复用既有 CI 的 lint/test 入口，而非依赖 Agent 自觉。

## 落地范围与约束

- 菜单到业务弹窗的键盘路径已实际复现焦点丢失；公共弹窗现记录菜单的持久触发按钮，避免关闭时聚焦已卸载菜单项。行操作菜单默认非模态，避免隐藏整个工作区的主地标。
- 新增 8 个基础文件（Input、Textarea、NativeSelect、Checkbox、DataTable、Tabs、Popover、DropdownMenu），扩展 Button；全部沿用已有 Token、密度和主题。
- 迁移基础控件、四处原生表格、四处普通业务标签页、标签筛选和 Docker 动作菜单；删除已无调用的文字按钮与原生浮层 CSS。
- 保留业务查询、权限、RPC、危险确认、文件/终端行为。应用资源卡片、原生拖拽、树展开、终端多面板选择等必要特殊按钮逐个说明理由，不给业务目录放行。
- 新增根 Agent 规范、组件索引、可编译参考页面、开发文档入口；新增组件与契约变更需维护索引和示例。
- 只递增受影响 Ops 版本 0.1.12 → 0.1.13，同步 lock；不更改 Agent、部署与 Skill 版本。

## 自动约束的范围

`eslint.config.mjs` 对 src/app、src/components、docs/examples 的 TSX 接入本地插件：

| 规则                    | 拦截内容                                                             | 允许边界                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| ui/no-native-controls   | 原生基础控件、details/summary，以及 div/span role=button/dialog/menu | UI 基础目录可以实现原语；语义 form/label/fieldset/tr/td 可正常使用；只有必要原生 button 可通过具体 data-ui-native 理由声明 |
| ui/no-direct-primitives | 业务直接导入/转导出/动态导入/require Radix                           | UI 层集中封装，业务使用本地契约                                                                                            |
| ui/no-secondary-library | 常见第二 UI 框架及 styled-components/@emotion                        | xterm、React Flow、Lucide 等已有专用依赖不误报                                                                             |
| ui/no-raw-colors        | className 字面量、模板、cn/clsx 中的 Tailwind 原生色板和直接色值     | 语义 Token、布局、尺寸和 var(--token) 允许；主题测试继续验证 CSS/TSX 颜色及对比度                                          |

没有对历史问题做 baseline 放行。规则测试使用真实 ESLint 配置验证违规样例失败，并验证基础 UI 的实现权限。自动检查仍无法判断例外理由是否真实、完全动态类名最终值、组件间是否重复业务职责，必须保留组件选择审查；不能宣称 Agent 今后绝不会违规。

## 验证记录

- `npm run check`、`npm run lint` 通过；规则对 src/app、src/components、docs/examples 生效，零全库违规。
- `npm test`：78/78 通过，包含新增的 5 项规则测试及 4 项真实组件 SSR 契约测试；规则包含真实 ESLint 配置的正反例，非只测试字符串扫描器。
- `npm run build`：Prisma 生成、Next 16.4.3 Turbopack 生产构建及 standalone runtime 打包通过。沙箱拒绝本机端口会导致构建或 HTTP 测试 EPERM；相同命令在获准的本机权限下完成，未降低检查要求。
- 复核业务 JSX 后，原生 input/select/textarea/table/details 调用为 0；剩余 9 个原生 button 均为有具体理由的卡片、遮罩、树与终端控件。原生基础实现集中在 ui 层。
- 代表性业务页：节点管理的 Input → Popover → Checkbox → DataTable → NodeEditor；系统运维的 NativeSelect → ViewTabs → ResourceForm；Docker 的 Button link → DropdownMenu → BusinessDialog。实际页面均从统一入口组合，参考示例也接受类型检查及 UI lint。
- agent-browser 独立会话配合仅监听 127.0.0.1 的临时只读夹具；节点管理 1440×1000 亮色、390×844 暗色截图均已查看，无页面横向溢出，窄屏表格独立滚动；运维及 Docker 暗色桌面截图已查看。
- 已操作验证标签筛选勾选、Escape 关闭和焦点恢复；运维方向键切换标签、只有一个可见面板；节点编辑请求被夹具拒绝时输入保留，Escape 关闭回到编辑按钮；Docker 菜单禁用项、键盘打开详情以及关闭回到同一行“更多操作”。不声称测试了后端保存、部署或真实 Agent。
- axe：节点亮色桌面、暗色手机、运维桌面均 0 violations / 0 incomplete；节点编辑弹窗 0 violations / 1 incomplete（Radix 焦点守卫及隐藏背景需人工确认）。Docker 非模态菜单仍有 1 项 region 最佳实践提示（Portal 浮层位于主地标外）与 1 项待人工确认；没有据此宣称菜单 axe 全通过。已检查实际打开、关闭和焦点恢复；这不等于全站 WCAG 认证。
- Impeccable 源码检测返回空结果；`git diff --check` 通过。依赖安装报告 18 项 moderate 审计告警，尚未归因，未在 UI 任务中执行破坏性 audit fix 或无关升级。

剩余边界：Docker 菜单 Portal 的地标提示留待专门的可访问性评估；抽屉、日历、搜索式选择器、服务端分页等仍需真实需求驱动补齐；动态类名、例外真实性与重复业务封装仍需人工审查。浏览器夹具不执行业务写入，不作为真实后端功能验收。
