# 版本更新工作区优化验收

日期：2026-11-08。Ops 0.1.23→0.1.24；Agent、部署脚本及Skill无本轮变更。提交与部署状态以版本库及发布记录为准；本轮未触发真实升级。

## 展示与交互

- 左侧按组件/节点、目录验证、正式发布分区，右侧展示当前/目标版本、准确目录与准备条件，沿用本地组件和Token。桌面双栏，窄屏纵向排列，任务表自身滚动。
- 自动填入节点已登记路径，允许明确清空；不猜测 `/deploy` 后缀。目录验证绑定节点、组件、路径，切换任一项立即失效，服务端创建更新及执行前继续验证安装身份。
- 目标版本来自新只读updates.preview的正式发布清单；只有清单声明且Release实际存在的制品才标为匹配。同版本提示无需更新，未知版本不猜测，降级在核对框明确标注。
- 核对框内展示组件、节点、目录、版本及发布，显式确认才创建任务。提交锁、稳定幂等键和同目标进行中/UNKNOWN任务提示抑制重复操作。
- 近期更新来自授权tasks.list返回范围，展示最近5项，刷新后可重开任务。进度窗口读取父/子任务实际状态，展示准备、节点执行与版本确认，保留失败阶段及文本诊断。没有虚构下载百分比；节点执行成功但尚未确认新版本时不显示全部完成，无需执行与UNKNOWN独立显示。
- Worker将真实准备阶段及文本状态持久化。关闭进度窗口不取消任务，Escape及关闭恢复稳定按钮焦点。

## 本地回归

- lint、类型检查、生产构建通过。
- 15项已有下载/诊断/主题/公共组件测试通过；3项新增状态、版本比较与清单预览测试通过；1项原生隔离PostgreSQL回归通过，包含实际更新队列重新校验权限后持久化失败阶段，未创建节点执行任务。
- 隔离浏览器fixture走通：检查发布→选择节点与目标版本→目录验证→核对确认→创建模拟任务→读取下载阶段；重新查看失败任务可见具体超时原因及文本输出。
- 组件切为Ops后原验证失效；仅Agent目录验证Ops返回“指定目录未安装所选组件”，更新保持禁用。清空目录后值保持空，验证按钮禁用。
- 1440px亮色、暗色与390px窄屏检查完成；窄屏scrollWidth=380，视口390，无整页横向溢出。任务窗口Escape后焦点恢复“查看进度”。

本地截图使用测试数据，位于忽略目录，不随源码发布：[桌面](../.codex-tmp/updates-ready-light.png)、[进度窗口](../.codex-tmp/updates-progress-light.png)、[暗色窄屏](../.codex-tmp/updates-dark-mobile.png)。未触发真实发布制品下载、节点升级或服务重启，不替代真实部署验收。

复现：`npm run lint`、`npm run check`、`npx tsx --test tests/update-preview.test.ts tests/update-preparation.integration.ts`、`npx tsx --test tests/update-diagnostics.test.ts tests/release-download.test.ts tests/theme.test.ts tests/ui-components.test.ts`、`npm run build`。
