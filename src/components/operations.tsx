/**
 * @file operations.tsx
 * @project PipkerOps
 * @module operations-ui
 * @description 任务、Docker、文件、系统、站点、自动化和PTY页面，操作统一进入任务队列。
 * @logic 任务按计划关联筛选并解释无日志状态；危险操作确认后执行；终端一次性票据连接且不重放输入，提交失败保留幂等键。
 * @dependencies React, shared UI, RPC, xterm
 * @index_tags operations, tasks, terminal, automation, ui
 * @author holic512
 */
"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Plus,
  RotateCw,
  Play,
  ChevronLeft,
  SquareTerminal,
  X,
  Columns2,
} from "lucide-react";
import { rpc, date, type NodeData, type TaskData } from "@/lib/client";
import {
  useQuery,
  useOperation,
  PageTitle,
  DataTable,
  Status,
  QueryState,
  ResourceForm,
  JsonView,
  type Field,
} from "./shared";
import { Button } from "./ui/button";
import { createTaskSubmission } from "@/lib/task-submission";
const taskLogMessages: Record<string, string> = {
  QUEUED: "任务已入队，等待派发…",
  DISPATCHED: "任务已派发，等待执行端开始执行…",
  RUNNING: "任务正在执行，等待执行端返回日志…",
  SUCCEEDED: "执行成功，未返回文本日志；如有结构化结果，请在下方查看。",
  FAILED: "执行失败，未返回文本日志；请查看错误信息。",
  CANCELLED: "任务已取消，未执行。",
  UNKNOWN: "执行结果未知，请先查看任务状态与对账结果，勿直接重试。",
};
export function Tasks() {
  const search = useSearchParams();
  const scheduleId = search.get("schedule") ?? "";
  const q = useQuery<TaskData[]>(
    "tasks.list",
    scheduleId ? { scheduleId } : {},
  );
  const [filter, setFilter] = useState("");
  const filtered = q.data?.filter((t) =>
    (t.type + " " + (t.node?.name ?? "")).includes(filter),
  );
  const op = useOperation(() => void q.mutate());
  return (
    <>
      <PageTitle
        title="执行任务"
        description="追踪每次操作的状态、输出和执行来源。结果不明的非幂等任务不会自动重试。"
      >
        <Button variant="outline" onClick={() => void q.mutate()}>
          <RotateCw size={15} />
          刷新
        </Button>
      </PageTitle>
      {scheduleId && (
        <p className="inline-feedback">
          当前仅显示此计划关联的任务。<Link href="/tasks">查看全部任务</Link>
        </p>
      )}
      {op.ui}
      <div className="list-toolbar">
        <input
          aria-label="搜索任务"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索任务类型或节点"
        />
        <span className="muted">最近 100 条</span>
      </div>
      <QueryState
        loading={q.isLoading}
        error={q.error}
        empty={!filtered?.length}
        retry={() => void q.mutate()}
        emptyTitle={
          filter
            ? "没有匹配的执行任务"
            : scheduleId
              ? "此计划暂无可访问的执行任务"
              : "还没有执行任务"
        }
        emptyText={
          filter
            ? "请调整任务类型或节点搜索条件。"
            : scheduleId
              ? "仅显示记录计划关联后的任务；旧历史可在全部任务中查看。"
              : "在节点、Docker 或系统运维页面发起操作后，任务会显示在这里。"
        }
      >
        <DataTable
          headers={["任务 / 编号", "节点", "状态", "来源", "创建时间", "操作"]}
        >
          {filtered?.map((t) => (
            <tr key={t.id}>
              <td>
                <Link className="entity-link" href={`/tasks/${t.id}`}>
                  {t.type}
                </Link>
                <small>{t.id}</small>
              </td>
              <td>{t.node?.name ?? "主控"}</td>
              <td>
                <Status value={t.status} />
              </td>
              <td>{t.source}</td>
              <td>{date(t.createdAt)}</td>
              <td className="inline-actions">
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/tasks/${t.id}`}>查看日志</Link>
                </Button>
                {t.status === "QUEUED" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      op.ask(
                        "取消排队任务？",
                        "已分发或正在执行的任务无法通过此操作取消。",
                        () =>
                          rpc("tasks.cancel", { id: t.id, confirmed: true }),
                      )
                    }
                  >
                    取消
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      </QueryState>
    </>
  );
}
export function TaskDetail({ id }: { id: string }) {
  const q = useQuery<TaskData>("tasks.get", { id }, 2000);
  const task = q.data;
  return (
    <>
      <Link className="back-link" href="/tasks">
        <ChevronLeft size={15} />
        执行任务
      </Link>
      <PageTitle title={task?.type ?? "任务详情"} description={id}>
        <Button variant="outline" onClick={() => void q.mutate()}>
          <RotateCw size={15} />
          刷新
        </Button>
      </PageTitle>
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => void q.mutate()}
      >
        {task && (
          <>
            <div className="node-summary">
              <Status value={task.status} />
              <span>来源 {task.source}</span>
              <span>创建 {date(task.createdAt)}</span>
              <span>开始 {date(task.startedAt)}</span>
              <span>完成 {date(task.finishedAt)}</span>
            </div>
            {task.error && (
              <div className="inline-error" role="alert">
                {task.error}
              </div>
            )}
            <section className="panel">
              <div className="panel-header">
                <h2>执行日志</h2>
                <span className="muted">
                  自动刷新 · {task.logs?.length ?? 0} 条
                </span>
              </div>
              <pre className="terminal-output">
                {task.logs?.length
                  ? task.logs.map((l) => `[${l.stream}] ${l.message}`).join("")
                  : task.output || taskLogMessages[task.status]}
              </pre>
            </section>
            {Object.keys(task.result ?? {}).length > 0 && (
              <section className="panel form-panel detail-panel">
                <h2>执行结果</h2>
                <JsonView data={task.result} />
              </section>
            )}
          </>
        )}
      </QueryState>
    </>
  );
}
const ops: Record<
  string,
  {
    title: string;
    description: string;
    actions: {
      type: string;
      label: string;
      dangerous: boolean;
      fields: Field[];
    }[];
  }
> = {
  docker: {
    title: "Docker / Compose",
    description: "发现和管理节点容器、读取日志、拉取镜像与部署 Compose。",
    actions: [
      { type: "docker.list", label: "发现容器", dangerous: false, fields: [] },
      {
        type: "docker.inspect",
        label: "容器详情",
        dangerous: false,
        fields: [{ name: "id", label: "容器名称或 ID", required: true }],
      },
      {
        type: "docker.stats",
        label: "容器监控",
        dangerous: false,
        fields: [{ name: "id", label: "容器名称或 ID（留空全部）" }],
      },
      {
        type: "compose.list",
        label: "Compose 项目",
        dangerous: false,
        fields: [],
      },
      {
        type: "compose.status",
        label: "Compose 状态",
        dangerous: false,
        fields: [{ name: "project", label: "项目名", required: true }],
      },
      {
        type: "compose.read",
        label: "读取 Compose",
        dangerous: false,
        fields: [{ name: "project", label: "受管项目名", required: true }],
      },
      {
        type: "docker.logs",
        label: "容器日志",
        dangerous: false,
        fields: [
          { name: "id", label: "容器名称或 ID", required: true },
          {
            name: "tail",
            label: "日志行数",
            type: "number",
            defaultValue: 200,
            min: 1,
            max: 2000,
          },
        ],
      },
      {
        type: "docker.action",
        label: "容器生命周期",
        dangerous: true,
        fields: [
          { name: "id", label: "容器名称或 ID", required: true },
          {
            name: "action",
            label: "操作",
            type: "select",
            required: true,
            options: ["start", "stop", "restart", "remove"].map((v) => ({
              value: v,
              label:
                {
                  start: "启动",
                  stop: "停止",
                  restart: "重启",
                  remove: "删除",
                }[v] ?? v,
            })),
          },
        ],
      },
      {
        type: "docker.pull",
        label: "拉取镜像",
        dangerous: false,
        fields: [
          {
            name: "image",
            label: "镜像名称与标签",
            required: true,
            placeholder: "nginx:stable",
          },
        ],
      },
      {
        type: "compose.deploy",
        label: "Compose 部署",
        dangerous: true,
        fields: [
          { name: "project", label: "项目名", required: true },
          {
            name: "yaml",
            label: "Compose YAML",
            type: "textarea",
            required: true,
            placeholder: "services:\n  web:\n    image: nginx:stable",
          },
        ],
      },
    ],
  },
  files: {
    title: "文件管理",
    description:
      "通过 Agent 浏览、读取和管理节点文件。写入和删除操作需要确认。",
    actions: [
      {
        type: "files.list",
        label: "浏览目录",
        dangerous: false,
        fields: [
          {
            name: "path",
            label: "绝对路径",
            required: true,
            defaultValue: "/var/log",
          },
        ],
      },
      {
        type: "files.read",
        label: "读取文件",
        dangerous: false,
        fields: [{ name: "path", label: "文件绝对路径", required: true }],
      },
      {
        type: "files.write",
        label: "写入文件",
        dangerous: true,
        fields: [
          { name: "path", label: "文件绝对路径", required: true },
          { name: "content", label: "文件内容", type: "textarea" },
        ],
      },
      {
        type: "files.mkdir",
        label: "创建目录",
        dangerous: true,
        fields: [{ name: "path", label: "目录绝对路径", required: true }],
      },
      {
        type: "files.remove",
        label: "删除文件",
        dangerous: true,
        fields: [{ name: "path", label: "文件绝对路径", required: true }],
      },
    ],
  },
  system: {
    title: "系统运维",
    description:
      "管理 systemd 服务、防火墙和常用软件，或执行有审计记录的脚本。",
    actions: [
      { type: "system.info", label: "系统信息", dangerous: false, fields: [] },
      {
        type: "systemd.list",
        label: "服务状态",
        dangerous: false,
        fields: [{ name: "name", label: "服务名（留空列出全部）" }],
      },
      {
        type: "systemd.action",
        label: "管理服务",
        dangerous: true,
        fields: [
          {
            name: "name",
            label: "服务名",
            required: true,
            placeholder: "nginx.service",
          },
          {
            name: "action",
            label: "操作",
            type: "select",
            required: true,
            options: [
              "start",
              "stop",
              "restart",
              "reload",
              "enable",
              "disable",
            ].map((v) => ({ value: v, label: v })),
          },
        ],
      },
      {
        type: "firewall.list",
        label: "防火墙规则",
        dangerous: false,
        fields: [],
      },
      {
        type: "firewall.rule",
        label: "修改规则",
        dangerous: true,
        fields: [
          {
            name: "action",
            label: "操作",
            type: "select",
            required: true,
            options: ["allow", "deny", "reject", "delete"].map((v) => ({
              value: v,
              label: v,
            })),
          },
          {
            name: "ruleAction",
            label: "删除时匹配的原规则动作",
            type: "select",
            defaultValue: "allow",
            options: ["allow", "deny", "reject"].map((value) => ({
              value,
              label: value,
            })),
          },
          {
            name: "port",
            label: "端口",
            type: "number",
            required: true,
            min: 1,
            max: 65535,
          },
          {
            name: "protocol",
            label: "协议",
            type: "select",
            required: true,
            defaultValue: "tcp",
            options: ["tcp", "udp"].map((v) => ({ value: v, label: v })),
          },
        ],
      },
      {
        type: "software.install",
        label: "安装软件",
        dangerous: true,
        fields: [
          {
            name: "name",
            label: "软件",
            type: "select",
            required: true,
            options: ["nginx", "docker", "git", "curl", "htop", "certbot"].map(
              (v) => ({
                value: v,
                label: v,
              }),
            ),
          },
        ],
      },
      {
        type: "agent.upgrade",
        label: "升级 Agent",
        dangerous: true,
        fields: [
          { name: "url", label: "受信 HTTPS 二进制下载地址", required: true },
          { name: "sha256", label: "SHA-256 摘要", required: true },
          {
            name: "restart",
            label: "结果确认后自动重启 systemd Agent（先排空其他任务）",
            type: "checkbox",
            defaultValue: false,
          },
        ],
      },
      {
        type: "shell.exec",
        label: "执行脚本",
        dangerous: true,
        fields: [
          {
            name: "script",
            label: "Shell 脚本",
            type: "textarea",
            required: true,
            placeholder: "输入要在节点执行的脚本",
          },
          {
            name: "timeoutSeconds",
            label: "超时（秒）",
            type: "number",
            defaultValue: 60,
            min: 1,
            max: 300,
          },
        ],
      },
    ],
  },
};
export function Operations({ mode }: { mode: string }) {
  const search = useSearchParams();
  return (
    <OperationsForm
      key={`${mode}:${search.toString()}`}
      mode={mode}
      requestedNode={search.get("node") ?? ""}
      requestedAction={search.get("action") ?? ""}
      target={search.get("target") ?? ""}
    />
  );
}
function OperationsForm({
  mode,
  requestedNode,
  requestedAction,
  target,
}: {
  mode: string;
  requestedNode: string;
  requestedAction: string;
  target: string;
}) {
  const config = ops[mode];
  const q = useQuery<NodeData[]>("nodes.list");
  const [node, setNode] = useState(requestedNode);
  const [action, setAction] = useState(
    config.actions.some((a) => a.type === requestedAction)
      ? requestedAction
      : config.actions[0].type,
  );
  const [task, setTask] = useState("");
  const [submitTask] = useState(() => createTaskSubmission());
  const taskQuery = useQuery<TaskData>(
    task ? "tasks.get" : null,
    { id: task },
    2000,
  );
  const op = useOperation();
  const current = config.actions.find((a) => a.type === action)!;
  const selectedNode = q.data?.find((n) => n.id === node);
  const launch = async (data: Record<string, unknown>) => {
    setTask("");
    const result = await submitTask<TaskData>("tasks.create", {
      type: action,
      nodeId: node,
      payload: data,
      confirmed: current.dangerous,
    });
    setTask(result.id);
    return result;
  };
  return (
    <>
      <PageTitle title={config.title} description={config.description} />
      {op.ui}
      <QueryState
        error={q.error}
        loading={q.isLoading}
        empty={!q.data?.some((n) => n.status === "APPROVED")}
        retry={() => void q.mutate()}
        emptyTitle="暂无可访问的已批准节点"
        emptyText="请检查节点审批状态与当前授权范围，再执行节点运维操作。"
      >
        <section className="panel">
          <div className="panel-header">
            <label className="node-selector">
              执行节点
              <select
                aria-label="执行节点"
                value={node}
                onChange={(e) => {
                  setNode(e.target.value);
                  setTask("");
                  op.clear();
                }}
              >
                <option value="">选择节点</option>
                {q.data
                  ?.filter((n) => n.status === "APPROVED")
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
              </select>
            </label>
            <Link href="/tasks">查看所有任务</Link>
          </div>
          <div className="inner-tabs">
            {config.actions.map((a) => (
              <button
                className={action === a.type ? "active" : ""}
                onClick={() => {
                  if (action === a.type) return;
                  setAction(a.type);
                  setTask("");
                  op.clear();
                }}
                key={a.type}
              >
                {a.label}
              </button>
            ))}
          </div>
          <div className="form-panel">
            <h2>{current.label}</h2>
            {node && !selectedNode?.connected && !q.isLoading && (
              <p role="alert" className="error-text">
                {selectedNode
                  ? "节点离线，请恢复连接后执行。"
                  : "节点不存在或无权访问，请重新选择节点。"}
              </p>
            )}
            {node ? (
              <ResourceForm
                key={`${action}:${node}`}
                busy={op.busy}
                disabled={!selectedNode?.connected}
                fields={current.fields.map((f) =>
                  ["id", "project", "name"].includes(f.name) &&
                  target &&
                  node === requestedNode &&
                  action.split(".")[0] === requestedAction.split(".")[0]
                    ? { ...f, defaultValue: target }
                    : f,
                )}
                submit={current.dangerous ? "确认并执行" : "执行"}
                onSubmit={async (data) => {
                  if (current.dangerous) {
                    op.ask(
                      `${current.label}？`,
                      `此操作将在 ${selectedNode?.name} 上执行，参数：${JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => ["id", "name", "project", "path", "action"].includes(key))))}。操作将被审计。`,
                      () => launch(data),
                      "任务已记录，请查看状态与结果",
                    );
                  } else
                    await op.run(
                      () => launch(data),
                      "任务已记录，请查看状态与结果",
                    );
                }}
              />
            ) : (
              <p className="panel-empty">请先选择执行节点。</p>
            )}
          </div>
        </section>
        {task && (
          <section className="panel detail-panel">
            <div className="panel-header">
              <h2>执行结果</h2>
              <Link href={`/tasks/${task}`}>任务详情</Link>
            </div>
            <QueryState
              loading={taskQuery.isLoading}
              error={taskQuery.error}
              retry={() => void taskQuery.mutate()}
            >
              <div className="form-panel">
                <Status value={taskQuery.data?.status ?? "QUEUED"} />
                {taskQuery.data?.error && (
                  <p className="error-text">{taskQuery.data.error}</p>
                )}
                <pre className="terminal-output">
                  {taskQuery.data?.output ||
                    taskQuery.data?.logs?.map((l) => l.message).join("") ||
                    taskLogMessages[taskQuery.data?.status ?? "QUEUED"]}
                </pre>
                {taskQuery.data?.result &&
                  Object.keys(taskQuery.data.result).length > 0 && (
                    <JsonView data={taskQuery.data.result} />
                  )}
              </div>
            </QueryState>
          </section>
        )}
      </QueryState>
    </>
  );
}
const titles: Record<string, [string, string]> = {
  sites: ["站点管理", "管理节点 Nginx 反向代理配置，应用前进行语法检查。"],
  actions: ["自定义操作", "将常用运维流程保存为带动态参数的快捷操作。"],
  schedules: ["定时调度", "使用 Cron 定期创建持久化任务，执行记录可追溯。"],
  alerts: ["告警与通知", "设置指标阈值，接收站内通知或 HTTPS Webhook。"],
  mcp: ["MCP 与密钥", "为 AI Agent 分配工具范围、节点权限与高危操作限制。"],
  audit: ["操作审计", "记录用户、API Key 和后台任务的关键操作。"],
};
type GenericRow = {
  id: string;
  name?: string;
  title?: string;
  body?: string;
  status?: string;
  type?: string;
  domain?: string;
  certificateExpiresAt?: string;
  httpsEnabled?: boolean;
  upstream?: string;
  nodeId?: string;
  node?: { name: string };
  cron?: string;
  timezone?: string;
  taskType?: string;
  payload?: Record<string, unknown>;
  description?: string;
  durationSeconds?: number;
  operator?: string;
  probeId?: string;
  webhookUrl?: string;
  nextRunAt?: string;
  enabled?: boolean;
  metric?: string;
  threshold?: number;
  keyPrefix?: string;
  scopes?: string[];
  nodeIds?: string[];
  allowDangerous?: boolean;
  revokedAt?: string;
  expiresAt?: string;
  createdAt?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  actor?: { displayName: string };
  parameters?: { name: string; label: string; required: boolean }[];
  config?: Record<string, unknown>;
  level?: string;
  readAt?: string;
};
export function Resources({ mode }: { mode: string }) {
  const context = useSearchParams();
  const method =
    ({ mcp: "keys.list", audit: "audit.list" } as Record<string, string>)[
      mode
    ] ?? `${mode}.list`;
  const q = useQuery<GenericRow[]>(method);
  const nodes = useQuery<NodeData[]>("nodes.list");
  const probes = useQuery<{ id: string; name: string }[]>(
    mode === "alerts" ? "probes.list" : null,
  );
  const notifications = useQuery<GenericRow[]>(
    mode === "alerts" ? "notifications.list" : null,
  );
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState<GenericRow | null>(null);
  const [secret, setSecret] = useState("");
  const [certificateSite, setCertificateSite] = useState<GenericRow | null>(
    null,
  );
  const [siteTask, setSiteTask] = useState("");
  const [actionTask, setActionTask] = useState("");
  const [submitAction] = useState(() => createTaskSubmission());
  const [actionUrl, setActionUrl] = useState("");
  const [runAction, setRunAction] = useState<GenericRow | null>(null);
  const op = useOperation(() => {
    void q.mutate();
    void notifications.mutate();
  });
  const [title, description] = titles[mode];
  const nodeOptions = nodes.data
    ?.filter((n) => n.status === "APPROVED")
    .map((n) => ({ value: n.id, label: n.name }));
  const fields: Record<string, Field[]> = {
    sites: [
      { name: "name", label: "站点名称", required: true },
      {
        name: "nodeId",
        label: "节点",
        type: "select",
        required: true,
        options: nodeOptions,
      },
      {
        name: "domain",
        label: "域名",
        required: true,
        placeholder: "app.example.com",
      },
      {
        name: "upstream",
        label: "上游地址",
        required: true,
        placeholder: "http://127.0.0.1:8080",
      },
      {
        name: "config",
        label: "Nginx 配置（留空自动生成反向代理）",
        type: "textarea",
      },
    ],
    actions: [
      { name: "name", label: "操作名称", required: true },
      {
        name: "type",
        label: "操作类型",
        type: "select",
        required: true,
        options: [
          { value: "shell.exec", label: "Shell 脚本" },
          { value: "docker.action", label: "Docker 操作" },
          { value: "URL", label: "HTTPS URL 跳转" },
          { value: "HTTP", label: "HTTPS 接口请求" },
        ],
      },
      { name: "description", label: "说明" },
      {
        name: "config",
        label: "操作参数（JSON，变量使用 {{参数名}}）",
        type: "json",
        defaultValue: '{"script":"echo {{message}}"}',
      },
      {
        name: "parameters",
        label: "动态表单参数定义（JSON数组）",
        type: "json",
        defaultValue: '[{"name":"message","label":"消息","required":true}]',
      },
      {
        name: "nodeIds",
        label: "允许节点 ID（JSON数组，空数组为跟随授权范围）",
        type: "json",
        defaultValue: "[]",
      },
    ],
    schedules: [
      {
        name: "enabled",
        label: "启用计划",
        type: "checkbox",
        defaultValue: true,
      },
      { name: "name", label: "计划名称", required: true },
      {
        name: "cron",
        label: "Cron 表达式",
        required: true,
        placeholder: "0 */6 * * *",
      },
      {
        name: "timezone",
        label: "时区",
        defaultValue: "Asia/Shanghai",
        required: true,
      },
      {
        name: "nodeId",
        label: "执行节点",
        type: "select",
        options: nodeOptions,
        required: true,
      },
      {
        name: "taskType",
        label: "任务类型",
        type: "select",
        required: true,
        options: [
          { value: "shell.exec", label: "执行脚本" },
          { value: "docker.action", label: "Docker 操作" },
          { value: "system.info", label: "采集系统信息" },
        ],
      },
      {
        name: "payload",
        label: "执行参数（JSON）",
        type: "json",
        defaultValue: '{"script":"date","timeoutSeconds":60}',
      },
    ],
    alerts: [
      {
        name: "enabled",
        label: "启用规则",
        type: "checkbox",
        defaultValue: true,
      },
      { name: "name", label: "规则名称", required: true },
      {
        name: "nodeId",
        label: "监控节点（与探针二选一）",
        type: "select",
        options: nodeOptions,
      },
      {
        name: "probeId",
        label: "监控探针（与节点二选一）",
        type: "select",
        options: probes.data?.map((p) => ({ value: p.id, label: p.name })),
      },
      {
        name: "metric",
        label: "监控指标",
        type: "select",
        required: true,
        options: [
          { value: "cpuPercent", label: "CPU使用率" },
          { value: "memoryPercent", label: "内存使用率" },
          { value: "offline", label: "节点离线（1为离线）" },
          { value: "probeFailure", label: "探针连续失败次数" },
        ],
      },
      {
        name: "operator",
        label: "比较",
        type: "select",
        defaultValue: "gt",
        options: [
          { value: "gt", label: "大于" },
          { value: "lt", label: "小于" },
        ],
      },
      {
        name: "threshold",
        label: "阈值",
        type: "number",
        defaultValue: 85,
        required: true,
      },
      {
        name: "durationSeconds",
        label: "持续时间（秒）",
        type: "number",
        defaultValue: 60,
        min: 0,
        max: 86400,
      },
      { name: "webhookUrl", label: "Webhook URL（HTTPS，可选）" },
    ],
    mcp: [
      { name: "name", label: "密钥名称", required: true },
      {
        name: "scopes",
        label: "工具权限（JSON数组）",
        type: "json",
        defaultValue: '["nodes:read","apps:read","probes:read","tasks:read"]',
      },
      {
        name: "nodeIds",
        label: '节点 ID 范围（空数组无节点权限；["*"] 为全部）',
        type: "json",
        defaultValue: "[]",
      },
      {
        name: "days",
        label: "有效天数",
        type: "number",
        defaultValue: 30,
        min: 1,
        max: 365,
      },
      {
        name: "allowDangerous",
        label: "允许高危操作（仍需操作确认）",
        type: "checkbox",
      },
    ],
  };
  const save = async (data: Record<string, unknown>) => {
    const result = await rpc<unknown>(
      mode === "mcp" ? "keys.create" : `${mode}.save`,
      { ...data, confirmed: true },
    );
    if (mode === "mcp") setSecret((result as { key: string }).key);
    setShow(false);
    setEditing(null);
    return result;
  };
  return (
    <>
      <PageTitle title={title} description={description}>
        <Button variant="outline" onClick={() => void q.mutate()}>
          <RotateCw size={15} />
          刷新
        </Button>
        {mode !== "audit" && (
          <Button
            onClick={() => {
              setEditing(null);
              setShow(!show);
            }}
          >
            <Plus size={16} />
            {mode === "mcp"
              ? "创建密钥"
              : mode === "sites"
                ? "创建站点"
                : mode === "alerts"
                  ? "创建规则"
                  : mode === "schedules"
                    ? "创建计划"
                    : "创建操作"}
          </Button>
        )}
      </PageTitle>
      {op.ui}
      {mode === "mcp" && (
        <section className="panel form-panel compact-panel">
          <h2>连接 AI Agent</h2>
          <p>
            MCP 端点为当前站点的 <code>/api/mcp</code>，使用独立 Bearer API
            Key。只有密钥明确授权的工具、节点和高危操作可以调用。
          </p>
          <pre className="code-block">{`{"mcpServers":{"pipkerops":{"url":"https://你的主控域名/api/mcp","headers":{"Authorization":"Bearer 你的API密钥"}}}}`}</pre>
        </section>
      )}
      {secret && (
        <section className="secret-result detail-panel">
          <h2>密钥只展示一次，请安全保存</h2>
          <pre>{secret}</pre>
          <Button variant="outline" size="sm" onClick={() => setSecret("")}>
            已保存，隐藏密钥
          </Button>
        </section>
      )}
      {show && (
        <section className="panel form-panel detail-panel">
          <h2>
            {title} · {editing ? "编辑" : "新建"}
          </h2>
          <ResourceForm
            key={editing?.id ?? "new"}
            fields={(fields[mode] ?? []).map((field) => {
              const value = editing?.[field.name as keyof GenericRow];
              return {
                ...field,
                ...(value !== undefined && value !== null
                  ? {
                      defaultValue:
                        field.type === "json"
                          ? JSON.stringify(value, null, 2)
                          : (value as string | number | boolean),
                    }
                  : {}),
              };
            })}
            busy={op.busy}
            onSubmit={async (d) => {
              if (["actions", "schedules", "mcp"].includes(mode))
                op.ask(
                  editing ? "确认保存修改？" : "确认创建？",
                  "请检查工具范围、执行目标和操作内容。该设置可能允许后台或 AI Agent 执行远程操作。",
                  () => save({ ...d, ...(editing ? { id: editing.id } : {}) }),
                );
              else
                await op.run(() =>
                  save({ ...d, ...(editing ? { id: editing.id } : {}) }),
                );
            }}
          />
        </section>
      )}
      <QueryState
        loading={q.isLoading}
        error={q.error}
        empty={!q.data?.length}
        retry={() => void q.mutate()}
        emptyTitle={mode === "audit" ? "暂无审计记录" : `还没有${title}`}
        emptyText={
          mode === "audit"
            ? "关键操作执行后会产生审计记录。"
            : "使用上方创建按钮开始配置。"
        }
      >
        <DataTable
          headers={
            mode === "audit"
              ? ["时间", "操作者", "操作", "资源"]
              : mode === "mcp"
                ? [
                    "名称 / 前缀",
                    "工具范围",
                    "节点范围",
                    "高危操作",
                    "状态",
                    "操作",
                  ]
                : mode === "sites"
                  ? ["站点 / 域名", "节点", "上游", "状态", "操作"]
                  : mode === "schedules"
                    ? ["计划", "Cron / 时区", "下次执行", "状态", "操作"]
                    : mode === "alerts"
                      ? ["规则", "指标 / 阈值", "节点", "状态"]
                      : ["操作", "类型", "说明", "执行"]
          }
        >
          {q.data?.map((r) => (
            <tr key={r.id}>
              {mode === "audit" ? (
                <>
                  <td>{date(r.createdAt)}</td>
                  <td>{r.actor?.displayName ?? "系统"}</td>
                  <td>
                    <code>{r.action}</code>
                  </td>
                  <td>
                    {r.resourceType}
                    <small>{r.resourceId ?? "—"}</small>
                  </td>
                </>
              ) : mode === "mcp" ? (
                <>
                  <td>
                    {r.name}
                    <small>{r.keyPrefix}…</small>
                  </td>
                  <td className="wrap-cell">{r.scopes?.join(", ")}</td>
                  <td>
                    {r.nodeIds?.length ? r.nodeIds.join(", ") : "无节点权限"}
                  </td>
                  <td>{r.allowDangerous ? "允许" : "禁止"}</td>
                  <td>
                    <Status
                      value={
                        r.revokedAt
                          ? "REVOKED"
                          : r.expiresAt && new Date(r.expiresAt) < new Date()
                            ? "REVOKED"
                            : "ACTIVE"
                      }
                    />
                  </td>
                  <td>
                    {!r.revokedAt && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          op.ask(
                            "吊销 API Key？",
                            "使用该密钥的 AI Agent 将立即失去访问权限。",
                            () =>
                              rpc("keys.revoke", { id: r.id, confirmed: true }),
                          )
                        }
                      >
                        吊销
                      </Button>
                    )}
                  </td>
                </>
              ) : mode === "sites" ? (
                <>
                  <td>
                    {r.name}
                    <small>{r.domain}</small>
                  </td>
                  <td>{r.node?.name ?? r.nodeId}</td>
                  <td>{r.upstream}</td>
                  <td>
                    <Status value={r.status ?? "DRAFT"} />
                    <small>
                      {r.httpsEnabled ? "HTTPS · " : ""}
                      {r.certificateExpiresAt
                        ? `证书到期 ${date(r.certificateExpiresAt)}`
                        : "尚未读取证书"}
                    </small>
                  </td>
                  <td>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(r);
                        setShow(true);
                      }}
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        op.ask(
                          "删除站点？",
                          `节点：${nodes.data?.find((n) => n.id === r.nodeId)?.name ?? r.nodeId}；域名：${r.domain}。将删除平台管理的 Nginx 配置，检查并重新加载成功后才删除平台记录与续期计划；证书文件保留。`,
                          async () => {
                            const t = await rpc<{ id: string }>(
                              "sites.delete",
                              { id: r.id, confirmed: true },
                            );
                            setSiteTask(t.id);
                            return t;
                          },
                          "站点删除任务已加入队列",
                        )
                      }
                    >
                      删除
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        op.ask(
                          "应用站点配置？",
                          `节点：${nodes.data?.find((n) => n.id === r.nodeId)?.name ?? r.nodeId}；域名：${r.domain}；上游：${r.upstream}。Agent 将写入配置、运行 nginx -t，通过后重新加载。`,
                          () =>
                            rpc<{ id: string }>("sites.apply", {
                              id: r.id,
                              confirmed: true,
                            }).then((task) => {
                              setSiteTask(task.id);
                              return task;
                            }),
                          "配置应用任务已加入队列",
                        )
                      }
                    >
                      检查并应用
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setCertificateSite(r)}
                    >
                      证书与 HTTPS
                    </Button>
                  </td>
                </>
              ) : mode === "schedules" ? (
                <>
                  <td>{r.name}</td>
                  <td>
                    <code>{r.cron}</code>
                    <small>{r.timezone}</small>
                  </td>
                  <td>{date(r.nextRunAt)}</td>
                  <td>
                    <Status value={r.enabled ? "ACTIVE" : "PAUSED"} />
                  </td>
                  <td>
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/tasks?schedule=${r.id}`}>执行记录</Link>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(r);
                        setShow(true);
                      }}
                    >
                      编辑 / 启停
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        op.ask(
                          "删除定时计划？",
                          "后续不再调度，已创建任务保留。",
                          () =>
                            rpc("schedules.delete", {
                              id: r.id,
                              confirmed: true,
                            }),
                        )
                      }
                    >
                      删除
                    </Button>
                  </td>
                </>
              ) : mode === "alerts" ? (
                <>
                  <td>{r.name}</td>
                  <td>
                    {r.metric} / {r.threshold}
                  </td>
                  <td>
                    {nodes.data?.find((n) => n.id === r.nodeId)?.name ??
                      r.nodeId ??
                      "探针"}
                  </td>
                  <td>
                    <Status value={r.enabled ? "ACTIVE" : "PAUSED"} />
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(r);
                        setShow(true);
                      }}
                    >
                      编辑 / 启停
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        op.ask(
                          "删除告警规则？",
                          "后续不再检测此规则，已有通知保留。",
                          () =>
                            rpc("alerts.delete", { id: r.id, confirmed: true }),
                        )
                      }
                    >
                      删除
                    </Button>
                  </td>
                </>
              ) : (
                <>
                  <td>{r.name}</td>
                  <td>{r.type}</td>
                  <td>{r.description || "自定义快捷操作"}</td>
                  <td>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(r);
                        setShow(true);
                      }}
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        op.ask(
                          "删除自定义操作？",
                          "已创建任务保留；后续无法再通过此动作执行。",
                          () =>
                            rpc("actions.delete", {
                              id: r.id,
                              confirmed: true,
                            }),
                        )
                      }
                    >
                      删除
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRunAction(r)}
                    >
                      <Play size={13} />
                      执行
                    </Button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </DataTable>
      </QueryState>
      {mode === "actions" && context.get("deploymentId") && (
        <p className="inline-feedback">
          应用实例目标：{context.get("target")} · 节点：
          {nodes.data?.find((n) => n.id === context.get("node"))?.name ??
            context.get("node")}
          。选择动作后检查执行节点和全部参数；仅同名
          target、applicationId、deploymentId 参数预填。
        </p>
      )}
      {runAction && (
        <section className="panel form-panel detail-panel">
          <h2>执行：{runAction.name}</h2>
          <ResourceForm
            key={`${runAction.id}:${context.toString()}`}
            busy={op.busy}
            fields={[
              ...(["URL", "HTTP"].includes(runAction.type ?? "")
                ? []
                : [
                    {
                      name: "nodeId",
                      label: "执行节点",
                      type: "select" as const,
                      required: true,
                      defaultValue: context.get("node") ?? "",
                      options: nodeOptions?.filter(
                        (n) =>
                          !runAction.nodeIds?.length ||
                          runAction.nodeIds.includes(n.value),
                      ),
                    },
                  ]),
              ...(runAction.parameters?.map((p) => ({
                name: p.name,
                label: p.label,
                required: p.required,
                defaultValue: [
                  "target",
                  "applicationId",
                  "deploymentId",
                ].includes(p.name)
                  ? (context.get(p.name) ?? "")
                  : "",
              })) ?? []),
            ]}
            submit="执行操作"
            onSubmit={async (d) => {
              const { nodeId, ...values } = d;
              op.ask(
                `执行 ${runAction.name}？`,
                `执行位置：${nodeId ? (nodes.data?.find((n) => n.id === nodeId)?.name ?? nodeId) : "主控"}；参数：${JSON.stringify(values)}。参数将发送到服务端校验，远程操作进入任务队列并记录审计。`,
                async () => {
                  const r = await submitAction<{ id?: string; url?: string }>(
                    "actions.run",
                    { id: runAction.id, nodeId, values, confirmed: true },
                  );
                  if (r.url)
                    window.open(r.url, "_blank", "noopener,noreferrer");
                  setActionTask(r.id ?? "");
                  setActionUrl(r.url ?? "");
                  return r;
                },
                runAction.type === "URL"
                  ? "链接已生成"
                  : "任务已记录，请查看状态与结果",
              );
            }}
          />
        </section>
      )}
      {mode === "sites" && siteTask && (
        <p className="inline-feedback">
          任务已加入队列：
          <Link href={`/tasks/${siteTask}`}>查看执行日志与结果</Link>
        </p>
      )}
      {mode === "actions" && actionTask && (
        <p className="inline-feedback">
          任务已记录：
          <Link href={`/tasks/${actionTask}`}>查看执行日志与结果</Link>
        </p>
      )}
      {mode === "actions" && actionUrl && (
        <p className="inline-feedback">
          操作链接：
          <a href={actionUrl} target="_blank" rel="noopener noreferrer">
            打开链接
          </a>
        </p>
      )}
      {certificateSite && (
        <section className="panel detail-panel">
          <div className="panel-header">
            <h2>{certificateSite.domain} · 证书</h2>
            <Button variant="ghost" onClick={() => setCertificateSite(null)}>
              关闭
            </Button>
          </div>
          <div className="form-panel">
            <p>
              签发前请将域名解析到此节点，开放 80/443，并先应用站点配置。Agent
              需安装 certbot；测试证书独立保存。启用 HTTPS 会添加每日续期计划。
            </p>
            <div className="inline-actions">
              <Button
                variant="outline"
                onClick={() =>
                  void op.run(async () => {
                    const t = await rpc<{ id: string }>("sites.certificate", {
                      id: certificateSite.id,
                    });
                    setSiteTask(t.id);
                    return t;
                  }, "证书检查已排队")
                }
              >
                读取生产证书
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  op.ask(
                    "启用 HTTPS？",
                    "将使用已检查的有效生产证书生成 443 配置，通过语法检查后重新加载，并添加每日续期计划。",
                    async () => {
                      const t = await rpc<{ id: string }>("sites.https", {
                        id: certificateSite.id,
                        confirmed: true,
                      });
                      setSiteTask(t.id);
                      return t;
                    },
                    "HTTPS 配置任务已加入队列",
                  )
                }
              >
                启用 HTTPS 与自动续期
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  op.ask(
                    "检查并续期？",
                    "将在此节点运行 Certbot 续期并检查、重新加载 Nginx。",
                    async () => {
                      const t = await rpc<{ id: string }>("sites.renew", {
                        id: certificateSite.id,
                        confirmed: true,
                      });
                      setSiteTask(t.id);
                      return t;
                    },
                    "续期任务已加入队列",
                  )
                }
              >
                立即检查续期
              </Button>
            </div>
            <ResourceForm
              busy={op.busy}
              fields={[
                {
                  name: "email",
                  label: "ACME 联系邮箱",
                  type: "email",
                  required: true,
                },
                {
                  name: "staging",
                  label: "证书环境",
                  type: "select",
                  options: [
                    { value: "false", label: "生产" },
                    { value: "true", label: "测试（不能用于启用生产 HTTPS）" },
                  ],
                  defaultValue: "true",
                },
              ]}
              submit="签发证书"
              onSubmit={async (d) => {
                op.ask(
                  "签发 ACME 证书？",
                  "将向 ACME 服务注册邮箱、验证域名并申请证书。",
                  async () => {
                    const t = await rpc<{ id: string }>("sites.acme", {
                      id: certificateSite.id,
                      email: d.email,
                      staging: d.staging === "true",
                      confirmed: true,
                    });
                    setSiteTask(t.id);
                    return t;
                  },
                  "签发任务已加入队列",
                );
              }}
            />
          </div>
        </section>
      )}
      {mode === "alerts" && (
        <section className="panel detail-panel">
          <div className="panel-header">
            <h2>站内通知</h2>
          </div>
          <QueryState
            loading={notifications.isLoading}
            error={notifications.error}
            empty={!notifications.data?.length}
            retry={() => void notifications.mutate()}
            emptyTitle="暂无通知"
            emptyText="指标满足告警条件后，会在这里显示通知。"
          >
            <div className="notification-list">
              {notifications.data?.map((n) => (
                <article key={n.id}>
                  <div>
                    <strong>{n.title}</strong>
                    <p>{n.body}</p>
                    <small>{date(n.createdAt)}</small>
                  </div>
                  {!n.readAt && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void op.run(() =>
                          rpc("notifications.read", { id: n.id }),
                        )
                      }
                    >
                      标为已读
                    </Button>
                  )}
                </article>
              ))}
            </div>
          </QueryState>
        </section>
      )}
    </>
  );
}
export function TerminalPage() {
  const q = useQuery<NodeData[]>("nodes.list");
  const search = useSearchParams();
  const requested = search.get("node") ?? "";
  const target = search.get("target") ?? "";
  const requestKey = `${requested}:${target}`;
  const [lastRequested, setLastRequested] = useState(requestKey);
  const [node, setNode] = useState(requested);
  const [containerId, setContainerId] = useState(target);
  if (requestKey !== lastRequested) {
    setLastRequested(requestKey);
    setNode(requested);
    setContainerId(target);
  }
  const [sessions, setSessions] = useState<
    { id: string; nodeId: string; name: string; url: string }[]
  >([]);
  const [split, setSplit] = useState(false);
  const [active, setActive] = useState("");
  const op = useOperation();
  const selectedNode = q.data?.find(
    (n) => n.id === node && n.status === "APPROVED",
  );
  const hasApprovedNodes = q.data?.some((n) => n.status === "APPROVED");
  return (
    <>
      <PageTitle
        title="远程终端"
        description="建立经审计的 Web PTY 会话，支持节点或容器、多标签与分屏。关闭终端标签或退出登录将结束会话。"
      >
        <Button variant="outline" onClick={() => setSplit(!split)}>
          <Columns2 size={15} />
          {split ? "取消分屏" : "分屏"}
        </Button>
      </PageTitle>
      {op.ui}
      <section className="panel terminal-workspace">
        <div className="panel-header">
          <div className="inline-actions">
            <select
              aria-label="终端节点"
              value={node}
              onChange={(e) => {
                setNode(e.target.value);
                setContainerId("");
              }}
            >
              <option value="">选择节点</option>
              {q.data
                ?.filter((n) => n.status === "APPROVED")
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
            </select>
            <input
              aria-label="容器名称或 ID（可选）"
              placeholder="容器名称或 ID（留空连接节点）"
              value={containerId}
              onChange={(e) => setContainerId(e.target.value)}
            />
            <Button
              disabled={
                !selectedNode?.connected || op.busy || sessions.length >= 6
              }
              onClick={() =>
                op.ask(
                  "打开远程终端？",
                  `节点：${selectedNode?.name}，目标：${containerId || "节点 Shell"}。将以 Agent 系统用户启动交互式 Shell，会话建立和结束将被审计。`,
                  async () => {
                    const ticket = await rpc<{ url: string }>(
                      "terminal.ticket",
                      {
                        nodeId: node,
                        containerId: containerId || undefined,
                        confirmed: true,
                      },
                    );
                    const id = crypto.randomUUID();
                    setSessions((s) => [
                      ...s,
                      {
                        id,
                        nodeId: node,
                        name:
                          (q.data?.find((n) => n.id === node)?.name ?? node) +
                          (containerId ? ` / ${containerId}` : ""),
                        url: ticket.url,
                      },
                    ]);
                    setActive(id);
                    return ticket;
                  },
                  "终端会话已创建，请查看连接状态",
                )
              }
            >
              <Plus size={14} />
              新建会话
            </Button>
          </div>
          <span className="muted">{sessions.length} / 6 个会话</span>
        </div>
        <div className="inner-tabs">
          {sessions.map((s) => (
            <div key={s.id} className="terminal-tab">
              <button
                className={active === s.id ? "active" : ""}
                onClick={() => setActive(s.id)}
              >
                {s.name}
              </button>
              <button
                aria-label={`关闭${s.name}会话`}
                onClick={() => {
                  setSessions((previous) =>
                    previous.filter((p) => p.id !== s.id),
                  );
                  if (active === s.id)
                    setActive(sessions.find((p) => p.id !== s.id)?.id ?? "");
                }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
        {node && !q.isLoading && !q.error && !selectedNode?.connected && (
          <p role="alert" className="error-text">
            {selectedNode
              ? "节点离线，恢复连接后可新建会话。"
              : "节点不存在或无权访问，请重新选择节点。"}
          </p>
        )}
        {sessions.length > 0 && q.error && (
          <QueryState
            error={q.error}
            loading={false}
            retry={() => void q.mutate()}
          >
            {null}
          </QueryState>
        )}
        <QueryState
          error={sessions.length ? undefined : q.error}
          loading={!sessions.length && q.isLoading}
          retry={() => void q.mutate()}
          empty={!sessions.length}
          emptyTitle={
            hasApprovedNodes ? "开始一个终端会话" : "暂无可访问的已批准节点"
          }
          emptyText={
            hasApprovedNodes
              ? "选择已批准且在线的 Linux 节点，确认后打开远程 Shell。"
              : "请检查节点审批状态与当前授权范围。"
          }
        >
          {" "}
          <div className={split ? "terminal-grid split" : "terminal-grid"}>
            {sessions.map((s) => (
              <div
                key={s.id}
                className="terminal-pane"
                style={{ display: split || active === s.id ? "block" : "none" }}
              >
                <div className="terminal-pane-title">
                  <SquareTerminal size={14} />
                  {s.name}
                </div>
                <TerminalSession url={s.url} />
              </div>
            ))}
          </div>
        </QueryState>
      </section>
    </>
  );
}
function TerminalSession({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [state, setState] = useState<"connecting" | "connected" | "closed">(
    "connecting",
  );
  useEffect(() => {
    let dispose: () => void = () => {};
    let cancelled = false;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled || !ref.current) return;
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        theme: { background: "#142033", foreground: "#e6edf5" },
        scrollback: 3000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      fit.fit();
      const ws = new WebSocket(url);
      ws.onopen = () => {
        setState("connected");
        term.focus();
        ws.send(
          JSON.stringify({
            type: "terminal.resize",
            cols: term.cols,
            rows: term.rows,
          }),
        );
      };
      ws.onmessage = (e) => {
        try {
          const p = JSON.parse(e.data);
          if (p.type === "terminal.output") term.write(p.data);
          if (p.type === "terminal.error") setError(p.error ?? "终端启动失败");
          if (p.type === "terminal.exit") {
            term.options.disableStdin = true;
            if (term.textarea) term.textarea.disabled = true;
            setState("closed");
            term.writeln(`\r\n[会话已退出：${p.exitCode ?? 0}]`);
          }
        } catch {
          setError("收到无效的终端数据");
        }
      };
      ws.onerror = () =>
        setError(
          "终端连接失败。请检查节点在线状态，以及浏览器是否信任 Gateway TLS 证书。",
        );
      ws.onclose = () => {
        term.options.disableStdin = true;
        if (term.textarea) term.textarea.disabled = true;
        setState("closed");
        term.writeln("\r\n[连接已关闭]");
      };
      const onData = term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "terminal.input", data }));
      });
      const observer = new ResizeObserver(() => {
        if (ref.current?.clientWidth) {
          fit.fit();
          if (ws.readyState === WebSocket.OPEN)
            ws.send(
              JSON.stringify({
                type: "terminal.resize",
                cols: term.cols,
                rows: term.rows,
              }),
            );
        }
      });
      observer.observe(ref.current);
      dispose = () => {
        observer.disconnect();
        onData.dispose();
        ws.close();
        term.dispose();
      };
    })();
    return () => {
      cancelled = true;
      dispose();
    };
  }, [url]);
  return (
    <>
      <p role="status" className="terminal-connection-state">
        {state === "connecting"
          ? "正在连接终端…"
          : state === "connected"
            ? "终端已连接"
            : "连接已关闭。如需继续，请关闭此标签并新建会话；旧输入不会自动重放。"}
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <div ref={ref} className="xterm-container" />
    </>
  );
}
