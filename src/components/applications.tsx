/**
 * @file applications.tsx
 * @project PipkerOps
 * @module application-and-probe-ui
 * @description 应用独立建模、长期资源多应用共享及多源探针的创建与历史查询。
 * @logic 通过资源选择器建立稳定关联；历史部署保留并链接resourceId，业务健康依据探针。
 * @dependencies React, shared UI, RPC
 * @index_tags apps, deployments, probes, ui
 * @author holic512
 */
"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ResourceData } from "@/lib/resource-contracts";
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
import { ViewTabs } from "./ui/tabs";
import { BusinessDialog } from "./ui/dialog";
export function Applications() {
  const q = useQuery<AppData[]>("applications.list");
  const resources = useQuery<ResourceData[]>("resources.list");
  const search = useSearchParams();
  const [show, setShow] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(
    search.get("applicationId"),
  );
  const selected = q.data?.find((a) => a.id === selectedId);
  const [view, setView] = useState<"cards" | "table">("cards");
  const op = useOperation(() => {
    void q.mutate();
  }, show || !!selectedId);
  const [tab, setTab] = useState("instances");
  return (
    <>
      <PageTitle title="应用中心">
        <Button variant="outline" asChild>
          <Link href="/topology">
            <Waypoints size={16} />
            查看拓扑
          </Link>
        </Button>
        <Button
          onClick={() => {
            op.clear();
            setShow(true);
            setSelectedId(null);
          }}
        >
          <Plus size={16} />
          创建应用
        </Button>
      </PageTitle>
      {op.ui}
      {show && (
        <BusinessDialog
          title="创建应用"
          onClose={() => {
            setShow(false);
            op.clear();
          }}
          operation={op}
          formId="create-app"
        >
          <ResourceForm
            id="create-app"
            hideSubmit
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
        </BusinessDialog>
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
                data-ui-native="应用资源卡片使用块布局，保留整卡点击区域"
                key={a.id}
                className={`app-card ${selected?.id === a.id ? "app-selected" : ""}`}
                onClick={() => {
                  op.clear();
                  setTab("instances");
                  setSelectedId(a.id);
                }}
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
                    {
                      new Set([
                        ...(a.resources ?? []).map((l) => l.resource.nodeId),
                        ...a.deployments.map((d) => d.nodeId),
                      ]).size
                    }{" "}
                    个节点
                  </span>
                  <span>{a.resources?.length ?? 0} 个资源</span>
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
                <td>
                  {a.resources?.length ?? 0} 个资源 / {a.deployments.length}{" "}
                  条历史部署
                </td>
                <td>{a.probes.length}</td>
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      op.clear();
                      setTab("instances");
                      setSelectedId(a.id);
                    }}
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
        <BusinessDialog
          title={selected.name}
          size="detail"
          onClose={() => {
            setSelectedId(null);
            setTab("instances");
            op.clear();
          }}
          operation={op}
          formId={
            tab === "associate"
              ? "associate-instance"
              : tab === "edit"
                ? "edit-app"
                : undefined
          }
        >
          <div className="panel-header">
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
          <ViewTabs
            label="应用详情"
            value={tab}
            onValueChange={setTab}
            items={[
              { value: "instances", label: "已关联资源" },
              { value: "associate", label: "选择资源" },
              { value: "business", label: "业务数据" },
              { value: "edit", label: "编辑应用" },
            ]}
          >
            {tab === "instances" ? (
              <QueryState
                loading={false}
                empty={
                  !selected.deployments.length && !selected.resources?.length
                }
                retry={() => void q.mutate()}
                emptyTitle="还未关联资源"
                emptyText="点击“选择资源”，关联节点上已登记的长期资源。"
              >
                <>
                  <DataTable headers={["资源", "节点", "识别 / 运行", "操作"]}>
                    {selected.resources?.map((link) => (
                      <tr key={link.resourceId}>
                        <td>
                          <Button variant="link" asChild>
                            <Link href={`/resources/${link.resourceId}`}>
                              {link.resource.name}
                            </Link>
                          </Button>
                          <small>{link.resourceId}</small>
                        </td>
                        <td>
                          {link.resource.node?.name ?? link.resource.nodeId}
                        </td>
                        <td>
                          <Status value={link.resource.identification} />{" "}
                          <Status
                            value={
                              link.resource.runtimeState === "RUNNING"
                                ? "running"
                                : link.resource.runtimeState
                            }
                          />
                        </td>
                        <td>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              op.ask(
                                "解除资源关联？",
                                `应用：${selected.name}；资源：${link.resource.name}。仅解除此应用关联，资源及其他应用引用保留。`,
                                () =>
                                  rpc("resources.unlink", {
                                    resourceId: link.resourceId,
                                    applicationId: selected.id,
                                    confirmed: true,
                                  }),
                              )
                            }
                          >
                            解除关联
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                  <h2>历史部署记录</h2>
                  <DataTable
                    headers={[
                      "实例",
                      "类型",
                      "节点",
                      "历史运行目标",
                      "状态",
                      "操作",
                    ]}
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
                              {d.resourceId ? (
                                <Button variant="outline" size="sm" asChild>
                                  <Link href={`/resources/${d.resourceId}`}>
                                    核对并管理资源
                                  </Link>
                                </Button>
                              ) : (
                                <span className="muted">
                                  旧记录保留，请从资源页确认实例
                                </span>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  op.ask(
                                    "删除历史部署记录？",
                                    `应用：${selected.name}；实例：${d.name}；节点：${d.node?.name ?? d.nodeId}；类型：${d.type}；运行目标：${d.target}。只删除此旧部署记录，长期资源及其应用关联保留；解除资源关联请使用上方资源列表。`,
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
                </>
              </QueryState>
            ) : tab === "associate" ? (
              <div className="form-panel">
                <p>
                  选择长期资源，可与其他应用共享。新容器请先在 Docker 列表登记。
                </p>
                <Button variant="link" asChild>
                  <Link href="/resources">前往资源管理</Link>
                </Button>
                <QueryState
                  loading={resources.isLoading}
                  error={resources.error}
                  retry={() => void resources.mutate()}
                >
                  {null}
                </QueryState>
                <ResourceForm
                  id="associate-instance"
                  hideSubmit
                  busy={op.busy}
                  fields={[
                    {
                      name: "resourceId",
                      label: "选择已登记资源",
                      type: "select",
                      required: true,
                      options: resources.data
                        ?.filter(
                          (r) =>
                            !selected.resources?.some(
                              (l) => l.resourceId === r.id,
                            ),
                        )
                        .map((r) => ({
                          value: r.id,
                          label: `${r.name} · ${r.node.name} · ${r.identification}`,
                        })),
                    },
                  ]}
                  onSubmit={(d) =>
                    op.run(() =>
                      rpc("resources.associate", {
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
                  id="edit-app"
                  hideSubmit
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
                    q.data?.find((a) => a.id === selected.id)?.businessData ??
                    {}
                  }
                />
                <h2>探针业务字段</h2>
                {q.data
                  ?.find((a) => a.id === selected.id)
                  ?.probes.map((probe) => (
                    <section key={probe.id}>
                      <h3>
                        {probe.name} ·{" "}
                        <Status
                          value={probe.enabled ? probe.status : "PAUSED"}
                        />
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
          </ViewTabs>
        </BusinessDialog>
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
  const op = useOperation(() => void q.mutate(), show || !!selected);
  return (
    <>
      <PageTitle title="多源探针">
        <Button variant="outline" onClick={() => void q.mutate()}>
          <RotateCw size={15} />
          刷新
        </Button>
        <Button
          onClick={() => {
            setEditing(null);
            op.clear();
            setShow(true);
          }}
        >
          <Plus size={16} />
          创建探针
        </Button>
      </PageTitle>
      {op.ui}
      {show && (
        <BusinessDialog
          title={editing ? "编辑探针" : "创建探针"}
          onClose={() => {
            setShow(false);
            setEditing(null);
            op.clear();
          }}
          operation={op}
          formId="probe-form"
        >
          <ResourceForm
            id="probe-form"
            hideSubmit
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
        </BusinessDialog>
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
                <Button
                  variant="link"
                  className="entity-link"
                  onClick={() => {
                    op.clear();
                    setSelected(p.id);
                  }}
                >
                  {p.name}
                </Button>
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
                    op.clear();
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
                  onClick={() => {
                    op.clear();
                    setSelected(p.id);
                  }}
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
        <BusinessDialog
          title={`探测历史 · ${q.data?.find((p) => p.id === selected)?.name ?? ""}`}
          size="detail"
          readOnly
          onClose={() => {
            setSelected("");
            op.clear();
          }}
        >
          <div className="panel-header">
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
        </BusinessDialog>
      )}
    </>
  );
}
