"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Circle,
  Download,
  FolderCheck,
  RefreshCw,
  Server,
} from "lucide-react";
import packageInfo from "../../package.json";
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { BusinessDialog } from "@/components/ui/dialog";
import { rpc, date, type NodeData, type TaskData } from "@/lib/client";
import {
  updatePreparationStages,
  updateVersionRelation,
  updateTaskSteps,
} from "@/lib/update-status";
import {
  useOperation,
  useQuery,
  PageTitle,
  QueryState,
  Status,
  DataTable,
} from "./shared";

type Component = "agent" | "ops" | "scripts";
type Release = { tag: string; name: string };
type Preview = Release & {
  versions: Record<Component, string>;
  artifacts: string[];
};
type Installation = {
  root: string;
  components: string[];
  scriptsVersion: string;
};
const names = { agent: "Agent 程序", ops: "Ops 主控", scripts: "部署脚本" };
const pending = (status: string) =>
  ["QUEUED", "DISPATCHED", "RUNNING", "UNKNOWN"].includes(status);

function UpdateTask({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}) {
  const q = useQuery<TaskData>("tasks.get", { id: taskId }, 2000);
  const task = q.data;
  const childId =
    typeof task?.result.executionTaskId === "string"
      ? task.result.executionTaskId
      : "";
  const child = useQuery<TaskData>(
    childId ? "tasks.get" : null,
    { id: childId },
    2000,
  );
  const stage = String(task?.result.preparationStage ?? "");
  const label = Object.hasOwn(updatePreparationStages, stage)
    ? updatePreparationStages[stage as keyof typeof updatePreparationStages]
    : undefined;
  return (
    <BusinessDialog
      title="更新进度与结果"
      description="关闭窗口后任务继续执行，可从近期更新记录重新查看。"
      size="detail"
      readOnly
      onClose={onClose}
    >
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => void q.mutate()}
      >
        {task && (
          <div className="update-task-content">
            <div className="toolbar">
              <Status value={task.status} />
              <span>
                {names[task.payload.component as Component] ?? "平台更新"}
              </span>
              <span className="muted">创建于 {date(task.createdAt)}</span>
            </div>
            <ol className="update-steps" aria-label="更新阶段">
              {updateTaskSteps(task.status, !!childId, child.data?.status).map(
                (state, i) => (
                  <li key={i} data-state={state}>
                    {i + 1}.{" "}
                    {
                      [
                        "准备与校验",
                        task.status === "SUCCEEDED" && !childId
                          ? "无需节点执行"
                          : "节点执行",
                        "版本确认",
                      ][i]
                    }
                  </li>
                ),
              )}
            </ol>
            <p role="status">
              {task.status === "UNKNOWN"
                ? "执行状态待核对，请查看原任务，勿直接重复更新。"
                : task.status === "SUCCEEDED"
                  ? "更新已完成。"
                  : task.status === "FAILED"
                    ? "更新失败，请按下方错误信息处理。"
                    : task.status === "CANCELLED"
                      ? "更新任务已取消。"
                      : task.status === "QUEUED"
                        ? "任务已入队，等待 Worker 处理。"
                        : child.data?.status === "SUCCEEDED" &&
                            task.payload.component === "agent"
                          ? "节点执行完成，等待目标版本重新连接确认。"
                          : child.data?.status === "SUCCEEDED"
                            ? "节点执行完成，等待主控对账确认。"
                            : childId
                              ? "节点执行任务已创建，等待执行结果。"
                              : (label ?? "等待任务阶段信息。")}
            </p>
            {(task.error || child.data?.error) && (
              <p className="inline-error" role="alert">
                {task.error || child.data?.error}
              </p>
            )}
            {stage === "artifact" && pending(task.status) && (
              <p className="muted">
                正在下载并校验发布制品，下载预算最多5分钟，耗时取决于主控网络。
              </p>
            )}
            {child.error && (
              <p className="inline-error">
                节点执行结果读取失败：{child.error.message}
                <Button variant="link" onClick={() => void child.mutate()}>
                  重试读取
                </Button>
              </p>
            )}
            <pre className="terminal-output">
              {[
                task.output,
                child.data?.output,
                child.data?.logs
                  ?.map((l) => `[${l.stream}] ${l.message}`)
                  .join(""),
              ]
                .filter(Boolean)
                .join("\n\n") ||
                "尚未返回文本日志，请结合当前状态和错误信息查看。"}
            </pre>
            <div className="inline-actions">
              <Button asChild variant="link">
                <Link href={`/tasks/${task.id}`}>打开完整任务</Link>
              </Button>
              {childId && (
                <Button asChild variant="link">
                  <Link href={`/tasks/${childId}`}>打开节点执行任务</Link>
                </Button>
              )}
            </div>
          </div>
        )}
      </QueryState>
    </BusinessDialog>
  );
}

export function Updates() {
  const user = useQuery<{ role: string }>("users.me");
  const admin = user.data?.role === "ADMIN";
  const nodes = useQuery<NodeData[]>(admin ? "nodes.summary" : null);
  const history = useQuery<TaskData[]>(admin ? "tasks.list" : null, {}, 5000);
  const op = useOperation();
  const submit = useOperation(() => void history.mutate(), true);
  const [releases, setReleases] = useState<Release[]>([]);
  const [checked, setChecked] = useState(false);
  const [tag, setTag] = useState("");
  const [component, setComponent] = useState<Component>("agent");
  const [nodeId, setNodeId] = useState("");
  const [root, setRoot] = useState<string | null>(null);
  const [validation, setValidation] = useState<{
    key: string;
    installation: Installation;
  }>();
  const [review, setReview] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [resultOpen, setResultOpen] = useState(false);
  const [submitted, setSubmitted] = useState<{ id: string; binding: string }>();
  const tracked = useQuery<TaskData>(
    submitted ? "tasks.get" : null,
    { id: submitted?.id },
    2000,
  );
  const key = useRef("");
  const submitting = useRef(false);
  const resultButton = useRef<HTMLButtonElement>(null);
  const resultTrigger = useRef<HTMLElement | null>(null);
  const closeResult = () => {
    setResultOpen(false);
    requestAnimationFrame(() =>
      (resultTrigger.current?.isConnected
        ? resultTrigger.current
        : resultButton.current
      )?.focus(),
    );
  };
  const intent = useRef("");
  const node = nodes.data?.find((n) => n.id === nodeId);
  const targetRoot = root ?? node?.deployRoot ?? "";
  const binding = JSON.stringify([nodeId, component, targetRoot]);
  const registered = validation?.key === binding;
  const preview = useQuery<Preview>(
    admin && tag ? "updates.preview" : null,
    { releaseTag: tag },
    0,
  );
  const current =
    component === "agent"
      ? node?.agentVersion
      : component === "ops"
        ? packageInfo.version
        : registered
          ? validation.installation.scriptsVersion
          : undefined;
  const target = preview.data?.versions[component];
  const relation = updateVersionRelation(current, target);
  const recent =
    history.data?.filter((t) => t.type === "platform.update") ?? [];
  const active = recent.find(
    (t) =>
      pending(t.status) &&
      t.payload.nodeId === nodeId &&
      t.payload.component === component,
  );
  const hasArtifact =
    !!preview.data &&
    (component === "agent"
      ? !!node?.arch && preview.data.artifacts.includes(`agent-${node.arch}`)
      : preview.data.artifacts.includes("scripts"));
  const reasons = [
    !node ? "请选择执行节点" : !node.connected ? "节点离线，等待恢复连接" : "",
    !registered ? "请验证当前组件的部署目录" : "",
    !tag
      ? "请检查更新并选择正式发布"
      : preview.isLoading
        ? "正在读取版本清单"
        : preview.error
          ? "版本清单读取失败"
          : !hasArtifact
            ? "未确认匹配当前目标的发布制品"
            : "",
    relation === "same" ? "当前已是目标版本" : "",
    active ||
    (submitted?.binding === binding &&
      (!tracked.data || pending(tracked.data.status)))
      ? "此目标已有进行中或待核对的更新任务"
      : "",
  ].filter(Boolean);
  const blocked = op.busy || submit.busy || !!reasons.length;
  const openReview = () => {
    const nextIntent = JSON.stringify([binding, tag]);
    if (intent.current !== nextIntent || !key.current)
      key.current = crypto.randomUUID();
    intent.current = nextIntent;
    submit.clear();
    setReview(true);
  };
  return (
    <>
      <PageTitle title="版本更新">
        {taskId && (
          <Button
            ref={resultButton}
            variant="outline"
            onClick={(e) => {
              resultTrigger.current = e.currentTarget;
              setResultOpen(true);
            }}
          >
            查看最近结果
          </Button>
        )}
        <Button
          variant="outline"
          disabled={!admin || op.busy}
          onClick={async () => {
            const data = await op.run(
              () => rpc<Release[]>("updates.releases"),
              "正式发布列表已刷新",
            );
            if (data) {
              setReleases(data);
              setChecked(true);
              setTag("");
            }
          }}
        >
          <RefreshCw size={14} />
          {op.busy ? "正在处理…" : "检查更新"}
        </Button>
      </PageTitle>
      {op.ui}
      <QueryState
        loading={user.isLoading}
        error={user.error}
        retry={() => void user.mutate()}
      >
        {!admin ? (
          <p className="surface">版本更新需要管理员权限。</p>
        ) : (
          <div className="updates-workspace">
            <QueryState
              loading={nodes.isLoading}
              error={nodes.error}
              retry={() => void nodes.mutate()}
            >
              <div className="updates-layout">
                <section className="panel updates-form-panel">
                  <div className="panel-header">
                    <h2>选择更新目标</h2>
                    <span className="muted">
                      选择目标 → 核对版本 → 执行更新
                    </span>
                  </div>
                  <fieldset
                    className="updates-fields"
                    disabled={op.busy || submit.busy || review}
                  >
                    <div className="updates-section-title">
                      <span>1</span>
                      <h3>组件与执行节点</h3>
                    </div>
                    <div className="updates-field-grid">
                      <label>
                        更新组件
                        <NativeSelect
                          value={component}
                          onChange={(e) => {
                            setComponent(e.target.value as Component);
                            setValidation(undefined);
                          }}
                        >
                          <option value="agent">Agent 程序</option>
                          <option value="ops">Ops 主控</option>
                          <option value="scripts">部署脚本</option>
                        </NativeSelect>
                      </label>
                      <label>
                        执行节点
                        <NativeSelect
                          value={nodeId}
                          onChange={(e) => {
                            setNodeId(e.target.value);
                            setRoot(null);
                            setValidation(undefined);
                          }}
                        >
                          <option value="">请选择已接入的节点</option>
                          {nodes.data
                            ?.filter(
                              (n) => n.agentId && n.status === "APPROVED",
                            )
                            .map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.name}
                                {!n.connected ? " · 离线" : ""}
                              </option>
                            ))}
                        </NativeSelect>
                      </label>
                    </div>
                    {node && (
                      <div className="updates-node-info">
                        <Server size={16} aria-hidden="true" />
                        <strong>{node.name}</strong>
                        <Status value={node.connected ? "online" : "offline"} />
                        <span>{node.arch ?? "架构待确认"}</span>
                        <span>Agent {node.agentVersion ?? "版本待上报"}</span>
                      </div>
                    )}
                    <p className="muted">
                      {component === "ops"
                        ? "请选择安装在当前 Ops 主控宿主机上的 Agent；目录验证通过后才可更新主控。"
                        : component === "agent"
                          ? "更新节点上的 Agent 程序，配置、访问凭证与节点身份保留。"
                          : "只更新发布清单管理的部署程序文件，保留实际配置与数据。"}
                    </p>
                    <div className="updates-section-title">
                      <span>2</span>
                      <h3>部署目录</h3>
                      <Status
                        value={registered ? "HEALTHY" : "UNKNOWN"}
                        label={registered ? "已验证" : "待验证"}
                      />
                    </div>
                    <div className="updates-directory">
                      <label htmlFor="updates-root">
                        目标主机上的已安装目录
                      </label>
                      <div className="updates-path-row">
                        <Input
                          value={targetRoot}
                          id="updates-root"
                          placeholder="选择节点后自动填入已登记路径"
                          onChange={(e) => {
                            setRoot(e.target.value);
                            setValidation(undefined);
                          }}
                        />
                        <Button
                          variant="outline"
                          disabled={
                            !node?.connected ||
                            !targetRoot.startsWith("/") ||
                            op.busy
                          }
                          onClick={async () => {
                            setValidation(undefined);
                            const data = await op.run(
                              () =>
                                rpc<Installation>("nodes.deployment", {
                                  nodeId,
                                  deployRoot: targetRoot,
                                  component,
                                  confirmed: true,
                                }),
                              "目录与组件已验证",
                            );
                            if (data) {
                              setValidation({
                                key: binding,
                                installation: data,
                              });
                              void nodes.mutate();
                            }
                          }}
                        >
                          <FolderCheck size={14} />
                          验证目录
                        </Button>
                      </div>
                    </div>
                    <p className="muted">
                      {registered
                        ? `目录已确认安装：${validation.installation.components.map((c) => names[c as Component] ?? c).join("、")}。`
                        : "沿用节点上报或已登记的准确路径；组件、节点或路径变化后需重新验证。首次安装使用本地部署脚本。"}
                    </p>
                    <div className="updates-section-title">
                      <span>3</span>
                      <h3>正式发布版本</h3>
                    </div>
                    <label>
                      目标发布
                      <NativeSelect
                        value={tag}
                        disabled={!releases.length}
                        onChange={(e) => setTag(e.target.value)}
                      >
                        <option value="">
                          {!checked
                            ? "点击右上角“检查更新”获取正式发布"
                            : !releases.length
                              ? "暂无可用的正式发布"
                              : "请选择正式发布"}
                        </option>
                        {releases.map((r) => (
                          <option key={r.tag} value={r.tag}>
                            {r.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </label>
                  </fieldset>
                  {tag && (
                    <div className="updates-preview">
                      <QueryState
                        loading={preview.isLoading}
                        error={preview.error}
                        retry={() => void preview.mutate()}
                      >
                        {preview.data && (
                          <>
                            <span className="muted">来自正式发布清单</span>
                            <strong>{preview.data.name}</strong>
                            <code>{preview.data.tag}</code>
                          </>
                        )}
                      </QueryState>
                    </div>
                  )}
                </section>
                <aside className="panel updates-summary" aria-label="更新核对">
                  <div className="panel-header">
                    <h2>更新核对</h2>
                    <Download size={16} aria-hidden="true" />
                  </div>
                  <div className="updates-summary-body">
                    <span className="muted">{names[component]}</span>
                    <div className="updates-version-compare">
                      <div>
                        <small>
                          {component === "ops"
                            ? "当前主控界面"
                            : component === "agent"
                              ? "最近上报版本"
                              : "已验证脚本版本"}
                        </small>
                        <strong>{current ?? "待确认"}</strong>
                      </div>
                      <ArrowRight size={18} aria-hidden="true" />
                      <div>
                        <small>目标版本</small>
                        <strong>{target ?? "待选择"}</strong>
                      </div>
                    </div>
                    {target && (
                      <Status
                        value={
                          relation === "same"
                            ? "HEALTHY"
                            : relation === "downgrade"
                              ? "DEGRADED"
                              : relation === "upgrade"
                                ? "DISPATCHED"
                                : "UNKNOWN"
                        }
                        label={
                          relation === "same"
                            ? "已是目标版本"
                            : relation === "downgrade"
                              ? "目标低于当前版本"
                              : relation === "upgrade"
                                ? "有新版本"
                                : "当前版本待确认"
                        }
                      />
                    )}
                    <dl className="updates-summary-meta">
                      <div>
                        <dt>执行节点</dt>
                        <dd>{node?.name ?? "尚未选择"}</dd>
                      </div>
                      <div>
                        <dt>部署目录</dt>
                        <dd>{targetRoot || "尚未登记"}</dd>
                      </div>
                      <div>
                        <dt>目录状态</dt>
                        <dd>{registered ? "已验证当前组件" : "等待验证"}</dd>
                      </div>
                    </dl>
                    <ul className="updates-readiness" aria-label="更新准备检查">
                      {[
                        [
                          !!node?.connected,
                          node?.connected ? "节点在线" : "等待节点连接",
                        ],
                        [
                          registered,
                          registered ? "目录与组件已验证" : "目录与组件待验证",
                        ],
                        [!!target && hasArtifact, "发布清单与架构已匹配"],
                      ].map(([ok, label]) => (
                        <li key={String(label)} data-ready={!!ok}>
                          {ok ? (
                            <Check size={14} aria-hidden="true" />
                          ) : (
                            <Circle size={14} aria-hidden="true" />
                          )}
                          {label}
                        </li>
                      ))}
                    </ul>
                    <Button disabled={blocked || review} onClick={openReview}>
                      {relation === "downgrade" ? "核对降级" : "核对并更新"}
                    </Button>
                    <p className="muted" role="status">
                      {reasons[0] ??
                        "已具备更新条件，下一步核对后创建后台任务。"}
                    </p>
                  </div>
                </aside>
              </div>
            </QueryState>
            <section className="panel">
              <div className="panel-header">
                <h2>近期更新任务</h2>
                <Button variant="link" onClick={() => void history.mutate()}>
                  刷新记录
                </Button>
              </div>
              <QueryState
                loading={history.isLoading}
                error={history.error}
                retry={() => void history.mutate()}
                empty={!recent.length}
                emptyText="暂无近期平台更新任务；创建更新后可在这里持续查看结果。"
              >
                <DataTable
                  label="近期平台更新任务"
                  headers={[
                    "组件 / 节点",
                    "目标发布",
                    "状态",
                    "创建时间",
                    "操作",
                  ]}
                >
                  {recent.slice(0, 5).map((t) => (
                    <tr key={t.id}>
                      <td>
                        {names[t.payload.component as Component] ?? "平台更新"}
                        <small>
                          {nodes.data?.find((n) => n.id === t.payload.nodeId)
                            ?.name ?? String(t.payload.nodeId ?? "主控")}
                        </small>
                      </td>
                      <td>{String(t.payload.releaseTag ?? "—")}</td>
                      <td>
                        <Status value={t.status} />
                      </td>
                      <td>{date(t.createdAt)}</td>
                      <td>
                        <Button
                          variant="link"
                          onClick={(e) => {
                            resultTrigger.current = e.currentTarget;
                            setTaskId(t.id);
                            setResultOpen(true);
                          }}
                        >
                          查看进度
                        </Button>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              </QueryState>
            </section>
          </div>
        )}
      </QueryState>
      {review && (
        <BusinessDialog
          title={relation === "downgrade" ? "核对降级目标" : "核对更新目标"}
          description="确认后创建后台任务。程序可能短暂断线，配置与访问凭证保留。"
          operation={submit}
          formId="update-confirm-form"
          submit={relation === "downgrade" ? "确认降级" : "确认更新"}
          disabled={blocked}
          onClose={() => {
            if (!submit.busy) {
              setReview(false);
              submit.clear();
            }
          }}
        >
          <form
            id="update-confirm-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (submitting.current || blocked) return;
              submitting.current = true;
              try {
                const task = await submit.run(
                  () =>
                    rpc<{ id: string }>("updates.create", {
                      nodeId,
                      component,
                      releaseTag: tag,
                      deployRoot: targetRoot,
                      confirmed: true,
                      idempotencyKey: key.current,
                    }),
                  "更新任务已创建",
                );
                if (task) {
                  setTaskId(task.id);
                  setSubmitted({ id: task.id, binding });
                  key.current = "";
                  setReview(false);
                  setResultOpen(true);
                  void history.mutate();
                }
              } finally {
                submitting.current = false;
              }
            }}
          >
            <dl className="updates-summary-meta">
              <div>
                <dt>更新组件</dt>
                <dd>{names[component]}</dd>
              </div>
              <div>
                <dt>执行节点</dt>
                <dd>{node?.name}</dd>
              </div>
              <div>
                <dt>部署目录</dt>
                <dd>{targetRoot}</dd>
              </div>
              <div>
                <dt>版本变化</dt>
                <dd>
                  {current ?? "未知"} → {target}
                </dd>
              </div>
              <div>
                <dt>正式发布</dt>
                <dd>{tag}</dd>
              </div>
            </dl>
            {relation === "downgrade" && (
              <p className="inline-error">
                目标版本低于当前版本，请确认这是所需的降级操作。
              </p>
            )}
          </form>
        </BusinessDialog>
      )}
      {taskId && resultOpen && (
        <UpdateTask taskId={taskId} onClose={closeResult} />
      )}
    </>
  );
}
