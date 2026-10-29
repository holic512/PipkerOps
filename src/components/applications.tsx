/**
 * @file applications.tsx
 * @project PipkerOps
 * @module application-and-probe-ui
 * @description 应用独立建模、多实例关联和多源探针的创建、执行与历史查询。
 * @logic 表单调用统一业务API，部署关联节点，探针记录真实延迟与成功率；实例入口携带准确节点和目标进入共用运维页面。
 * @dependencies React, shared UI, RPC
 * @index_tags apps, deployments, probes, ui
 * @author holic512
 */
"use client";
import Link from "next/link";
import { useState } from "react";
import {
  Plus,
  RotateCw,
  Boxes,
  Server,
  Play,
  Trash2,
  Waypoints,
} from "lucide-react";
import {
  rpc,
  date,
  probeHealth,
  type AppData,
  type NodeData,
  type ProbeData,
} from "@/lib/client";
import {
  useQuery,
  useOperation,
  PageTitle,
  DataTable,
  Status,
  QueryState,
  ResourceForm,
  JsonView,
} from "./shared";
import { Button } from "./ui/button";
export function Applications() {
  const q = useQuery<AppData[]>("applications.list");
  const nodes = useQuery<NodeData[]>("nodes.list");
  const [show, setShow] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = q.data?.find((a) => a.id === selectedId);
  const [view, setView] = useState<"cards" | "table">("cards");
  const op = useOperation(() => {
    void q.mutate();
  });
  const [tab, setTab] = useState("instances");
  return (
    <>
      <PageTitle
        title="应用中心"
        description="以应用为中心，关联跨节点的容器、服务和部署实例。"
      >
        <Button variant="outline" asChild>
          <Link href="/topology">
            <Waypoints size={16} />
            查看拓扑
          </Link>
        </Button>
        <Button
          onClick={() => {
            setShow(!show);
            setSelectedId(null);
          }}
        >
          <Plus size={16} />
          创建应用
        </Button>
      </PageTitle>
      {op.ui}
      {show && (
        <section className="panel form-panel">
          <h2>创建应用</h2>
          <ResourceForm
            busy={op.busy}
            fields={[
              {
                name: "name",
                label: "应用名称",
                required: true,
                placeholder: "如：个人博客",
              },
              { name: "description", label: "应用描述", type: "textarea" },
              {
                name: "businessData",
                label: "自定义业务数据（JSON）",
                type: "json",
              },
            ]}
            onSubmit={async (d) => {
              const result = await op.run(() => rpc("applications.save", d));
              if (result) setShow(false);
            }}
          />
        </section>
      )}
      <div className="list-toolbar">
        <span className="muted">
          {q.data?.length ?? 0} 个应用 · 应用可独立于部署实例存在
        </span>
        <div className="inline-actions">
          <Button
            variant={view === "cards" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("cards")}
          >
            卡片
          </Button>
          <Button
            variant={view === "table" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("table")}
          >
            表格
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="刷新应用"
            onClick={() => void q.mutate()}
          >
            <RotateCw size={15} />
          </Button>
        </div>
      </div>
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => void q.mutate()}
        empty={!q.data?.length}
        emptyTitle="还没有应用"
        emptyText="创建一个应用，再关联节点上的容器、Compose 服务或 systemd 服务。"
      >
        {view === "cards" ? (
          <div className="app-grid">
            {q.data?.map((a) => (
              <button
                key={a.id}
                className={`app-card ${selected?.id === a.id ? "app-selected" : ""}`}
                onClick={() => setSelectedId(a.id)}
              >
                <div className="app-card-header">
                  <span className="app-symbol">
                    <Boxes size={23} />
                  </span>
                  <Status value={probeHealth(a.probes)} />
                </div>
                <h2>{a.name}</h2>
                <p>{a.description || "未填写描述"}</p>
                <div className="app-card-footer">
                  <span>
                    <Server size={14} />
                    {new Set(a.deployments.map((d) => d.nodeId)).size} 个节点
                  </span>
                  <span>{a.deployments.length} 个实例</span>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <DataTable headers={["应用", "描述", "部署实例", "探针", "操作"]}>
            {q.data?.map((a) => (
              <tr key={a.id}>
                <td className="entity-link">{a.name}</td>
                <td>{a.description ?? "—"}</td>
                <td>{a.deployments.length}</td>
                <td>{a.probes.length}</td>
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedId(a.id)}
                  >
                    管理实例
                  </Button>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </QueryState>
      {selected && (
        <section className="panel detail-panel">
          <div className="panel-header">
            <h2>{selected.name}</h2>
            <Button
              variant="destructive"
              size="sm"
              onClick={() =>
                op.ask(
                  "删除应用？",
                  "将删除应用关联、部署记录和依赖关系；不会停止节点上的运行实例。",
                  async () => {
                    const r = await rpc("applications.delete", {
                      id: selected.id,
                      confirmed: true,
                    });
                    setSelectedId(null);
                    return r;
                  },
                )
              }
            >
              <Trash2 size={14} />
              删除应用
            </Button>
          </div>
          <div className="inner-tabs">
            {[
              ["instances", "部署实例"],
              ["associate", "关联实例"],
              ["business", "业务数据"],
              ["edit", "编辑应用"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={tab === key ? "active" : ""}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "instances" ? (
            <QueryState
              loading={false}
              empty={
                !q.data?.find((a) => a.id === selected.id)?.deployments.length
              }
              retry={() => void q.mutate()}
              emptyTitle="还未关联部署实例"
              emptyText="点击“关联实例”，选择节点上的实际运行目标。"
            >
              <DataTable
                headers={["实例", "类型", "节点", "运行目标", "状态", "操作"]}
              >
                {q.data
                  ?.find((a) => a.id === selected.id)
                  ?.deployments.map((d) => (
                    <tr key={d.id}>
                      <td>{d.name}</td>
                      <td>{d.type}</td>
                      <td>
                        <Link href={`/nodes/${d.nodeId}`}>
                          {d.node?.name ?? d.nodeId}
                        </Link>
                      </td>
                      <td>
                        <code>{d.target}</code>
                      </td>
                      <td>
                        <Status value={d.status} />
                      </td>
                      <td>
                        <div className="inline-actions">
                          {(d.type === "docker"
                            ? [
                                ["容器详情", "/docker", "docker.inspect"],
                                ["日志", "/docker", "docker.logs"],
                                ["生命周期", "/docker", "docker.action"],
                                ["终端", "/terminal", ""],
                              ]
                            : d.type === "compose"
                              ? [
                                  ["项目状态", "/docker", "compose.status"],
                                  ["配置", "/docker", "compose.read"],
                                  ["部署更新", "/docker", "compose.deploy"],
                                ]
                              : d.type === "systemd"
                                ? [
                                    ["服务状态", "/system", "systemd.list"],
                                    ["管理服务", "/system", "systemd.action"],
                                  ]
                                : []
                          ).map(([label, path, action]) => (
                            <Button
                              key={label}
                              size="sm"
                              variant="outline"
                              asChild
                            >
                              <Link
                                href={`${path}?${new URLSearchParams({ node: d.nodeId, target: d.target, action })}`}
                              >
                                {label}
                              </Link>
                            </Button>
                          ))}
                          <Button size="sm" variant="outline" asChild>
                            <Link
                              href={`/actions?${new URLSearchParams({ node: d.nodeId, target: d.target, applicationId: selected.id, deploymentId: d.id })}`}
                            >
                              自定义动作
                            </Link>
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              op.ask(
                                "解除实例关联？",
                                `应用：${selected.name}；实例：${d.name}；节点：${d.node?.name ?? d.nodeId}；类型：${d.type}；运行目标：${d.target}。只删除平台关联记录，节点上的资源继续保留。`,
                                () =>
                                  rpc("deployments.delete", {
                                    id: d.id,
                                    confirmed: true,
                                  }),
                              )
                            }
                          >
                            解除关联
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
              </DataTable>
            </QueryState>
          ) : tab === "associate" ? (
            <div className="form-panel">
              <ResourceForm
                busy={op.busy}
                fields={[
                  { name: "name", label: "实例名称", required: true },
                  {
                    name: "nodeId",
                    label: "部署节点",
                    required: true,
                    type: "select",
                    options: nodes.data
                      ?.filter((n) => n.status === "APPROVED")
                      .map((n) => ({ value: n.id, label: n.name })),
                  },
                  {
                    name: "type",
                    label: "实例类型",
                    type: "select",
                    required: true,
                    options: [
                      "docker",
                      "compose",
                      "systemd",
                      "process",
                      "database",
                      "nginx",
                    ].map((v) => ({ value: v, label: v })),
                  },
                  {
                    name: "target",
                    label: "容器 ID / 服务名 / 运行目标",
                    required: true,
                  },
                  {
                    name: "healthUrl",
                    label: "健康 URL（可选，由该节点每60秒探测）",
                  },
                ]}
                onSubmit={(d) =>
                  op.run(() =>
                    rpc("deployments.save", {
                      ...d,
                      applicationId: selected.id,
                    }),
                  )
                }
              />
            </div>
          ) : tab === "edit" ? (
            <div className="form-panel">
              <ResourceForm
                key={selected.id}
                busy={op.busy}
                fields={[
                  {
                    name: "name",
                    label: "应用名称",
                    required: true,
                    defaultValue: selected.name,
                  },
                  {
                    name: "description",
                    label: "描述",
                    type: "textarea",
                    defaultValue: selected.description ?? "",
                  },
                  {
                    name: "businessData",
                    label: "业务数据",
                    type: "json",
                    defaultValue: JSON.stringify(
                      selected.businessData,
                      null,
                      2,
                    ),
                  },
                ]}
                onSubmit={(d) =>
                  op.run(() =>
                    rpc("applications.save", { ...d, id: selected.id }),
                  )
                }
              />
            </div>
          ) : (
            <div className="form-panel">
              <h2>自定义业务数据</h2>
              <JsonView
                data={
                  q.data?.find((a) => a.id === selected.id)?.businessData ?? {}
                }
              />
              <h2>探针业务字段</h2>
              {q.data
                ?.find((a) => a.id === selected.id)
                ?.probes.map((probe) => (
                  <section key={probe.id}>
                    <h3>
                      {probe.name} ·{" "}
                      <Status value={probe.enabled ? probe.status : "PAUSED"} />
                    </h3>
                    <small>
                      {date(probe.results?.[0]?.recordedAt)} ·{" "}
                      {probe.results?.[0]?.latencyMs.toFixed(1) ?? "—"} ms
                    </small>
                    <JsonView data={probe.results?.[0]?.data ?? {}} />
                  </section>
                ))}
            </div>
          )}
        </section>
      )}
    </>
  );
}
export function Probes() {
  const q = useQuery<ProbeData[]>("probes.list");
  const nodes = useQuery<NodeData[]>("nodes.list");
  const apps = useQuery<AppData[]>("applications.list");
  const [show, setShow] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const [editing, setEditing] = useState<ProbeData | null>(null);
  const history = useQuery<{
    results: Record<string, unknown>[];
    successRate: number | null;
    averageLatencyMs: number | null;
  }>(
    selected ? "probes.history" : null,
    { id: selected },
    selected ? 15000 : 0,
  );
  const op = useOperation(() => void q.mutate());
  return (
    <>
      <PageTitle
        title="多源探针"
        description="从主控或指定节点持续探测 HTTP / TCP，记录延迟、成功率与业务字段。"
      >
        <Button variant="outline" onClick={() => void q.mutate()}>
          <RotateCw size={15} />
          刷新
        </Button>
        <Button
          onClick={() => {
            setEditing(null);
            setShow(!show);
          }}
        >
          <Plus size={16} />
          创建探针
        </Button>
      </PageTitle>
      {op.ui}
      {show && (
        <section className="panel form-panel">
          <h2>{editing ? "编辑探针" : "创建探针"}</h2>
          <ResourceForm
            key={editing?.id ?? "new"}
            busy={op.busy}
            fields={[
              {
                name: "enabled",
                label: "启用探针",
                type: "checkbox",
                defaultValue: editing?.enabled ?? true,
              },
              {
                name: "name",
                label: "探针名称",
                required: true,
                defaultValue: editing?.name,
              },
              {
                name: "type",
                label: "类型",
                type: "select",
                required: true,
                defaultValue: editing?.type ?? "HTTP",
                options: [
                  { value: "HTTP", label: "HTTP" },
                  { value: "TCP", label: "TCP" },
                ],
              },
              {
                name: "target",
                label: "目标 URL 或 host:port",
                required: true,
                placeholder: "https://app.example.com/health",
                defaultValue: editing?.target,
              },
              {
                name: "sourceNodeId",
                label: "执行来源（留空为主控）",
                defaultValue: editing?.sourceNodeId ?? "",
                type: "select",
                options: nodes.data
                  ?.filter((n) => n.status === "APPROVED")
                  .map((n) => ({ value: n.id, label: n.name })),
              },
              {
                name: "applicationId",
                label: "关联应用（可选）",
                defaultValue: editing?.applicationId ?? "",
                type: "select",
                options: apps.data?.map((a) => ({
                  value: a.id,
                  label: a.name,
                })),
              },
              {
                name: "intervalSeconds",
                label: "轮询间隔（秒）",
                type: "number",
                defaultValue: editing?.intervalSeconds ?? 60,
                min: 10,
                max: 86400,
              },
              {
                name: "timeoutMs",
                label: "超时（毫秒）",
                type: "number",
                defaultValue: editing?.timeoutMs ?? 5000,
                min: 100,
                max: 30000,
              },
              {
                name: "failureThreshold",
                label: "连续失败阈值",
                type: "number",
                defaultValue: editing?.failureThreshold ?? 3,
                min: 1,
                max: 100,
              },
              {
                name: "config",
                label: "请求配置（method / headers / body / expectedStatus）",
                defaultValue: JSON.stringify(editing?.config ?? {}, null, 2),
                type: "json",
              },
              {
                name: "mapping",
                label: 'JSON 字段映射（如 {"version":"data.version"}）',
                defaultValue: JSON.stringify(editing?.mapping ?? {}, null, 2),
                type: "json",
              },
            ]}
            onSubmit={async (d) => {
              const save = async () => {
                const r = await rpc("probes.save", {
                  ...d,
                  id: editing?.id,
                  sourceNodeId: d.sourceNodeId ?? null,
                  applicationId: d.applicationId ?? null,
                  confirmed: true,
                });
                setShow(false);
                return r;
              };
              const config = d.config as Record<string, unknown>;
              if (
                d.type === "HTTP" &&
                !["GET", "HEAD", "OPTIONS"].includes(
                  String(config?.method ?? "GET"),
                )
              )
                op.ask(
                  "启用有副作用的 HTTP 探针？",
                  "此方法将按轮询周期执行，可能修改目标数据；每次执行最多一次尝试。",
                  save,
                );
              else await op.run(save);
            }}
          />
        </section>
      )}
      <QueryState
        error={q.error}
        loading={q.isLoading}
        empty={!q.data?.length}
        retry={() => void q.mutate()}
        emptyTitle="还没有探针"
        emptyText="创建 HTTP 或 TCP 探针，让平台从指定位置持续检查连通性。"
      >
        <DataTable
          headers={[
            "探针 / 目标",
            "来源",
            "状态",
            "延迟",
            "连续失败",
            "最近检查",
            "操作",
          ]}
        >
          {q.data?.map((p) => (
            <tr key={p.id}>
              <td>
                <button
                  className="text-button entity-link"
                  onClick={() => setSelected(p.id)}
                >
                  {p.name}
                </button>
                <small>
                  {p.type} · {p.target}
                </small>
              </td>
              <td>{p.sourceNode?.name ?? "主控"}</td>
              <td>
                <Status value={p.enabled ? p.status : "PAUSED"} />
              </td>
              <td>
                {p.results[0] ? `${p.results[0].latencyMs.toFixed(1)} ms` : "—"}
              </td>
              <td>
                {p.failureCount} / {p.failureThreshold}
              </td>
              <td>{date(p.lastCheckedAt)}</td>
              <td className="inline-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(p);
                    setShow(true);
                  }}
                >
                  编辑 / 启停
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={op.busy}
                  onClick={() =>
                    p.type === "HTTP" &&
                    !["GET", "HEAD", "OPTIONS"].includes(
                      String(p.config?.method ?? "GET"),
                    )
                      ? op.ask(
                          "执行有副作用的探针？",
                          "此HTTP方法可能修改目标数据。",
                          () =>
                            rpc("probes.run", { id: p.id, confirmed: true }),
                          "探测任务已加入队列",
                        )
                      : void op.run(
                          () => rpc("probes.run", { id: p.id }),
                          "探测任务已加入队列",
                        )
                  }
                >
                  <Play size={13} />
                  检测
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected(p.id)}
                >
                  历史
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`删除探针${p.name}`}
                  onClick={() =>
                    op.ask("删除探针？", "此探针配置和历史结果将被删除。", () =>
                      rpc("probes.delete", { id: p.id, confirmed: true }),
                    )
                  }
                >
                  <Trash2 size={14} />
                </Button>
              </td>
            </tr>
          ))}
        </DataTable>
      </QueryState>
      {selected && (
        <section className="panel detail-panel">
          <div className="panel-header">
            <h2>探测历史 · {q.data?.find((p) => p.id === selected)?.name}</h2>
            <div className="inline-actions">
              <span>
                成功率{" "}
                {history.data?.successRate != null
                  ? `${(history.data.successRate * 100).toFixed(1)}%`
                  : "—"}
              </span>
              <span>
                平均延迟 {history.data?.averageLatencyMs?.toFixed(1) ?? "—"} ms
              </span>
            </div>
          </div>
          <QueryState
            error={history.error}
            loading={history.isLoading}
            empty={!history.data?.results.length}
            retry={() => void history.mutate()}
            emptyTitle="暂无探测历史"
            emptyText="等待轮询或点击检测。"
          >
            <DataTable
              headers={["时间", "结果", "延迟", "响应码", "业务数据 / 错误"]}
            >
              {history.data?.results.map((r) => (
                <tr key={String(r.id)}>
                  <td>{date(String(r.recordedAt))}</td>
                  <td>
                    <Status value={r.success ? "HEALTHY" : "UNHEALTHY"} />
                  </td>
                  <td>{Number(r.latencyMs).toFixed(1)} ms</td>
                  <td>{String(r.statusCode ?? "—")}</td>
                  <td>{r.error ? String(r.error) : JSON.stringify(r.data)}</td>
                </tr>
              ))}
            </DataTable>
          </QueryState>
        </section>
      )}
    </>
  );
}
