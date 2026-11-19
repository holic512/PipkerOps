/**
 * @file nodes.tsx
 * @project PipkerOps
 * @module node-monitoring-ui
 * @description 集群概览、节点信息与分类编辑、实际指标历史及共用节点表格单元。
 * @logic 总览同步刷新节点与排行；详情集中展示接入与系统信息；文件夹归属留在编辑弹窗，未采样显示空态。
 * @dependencies React, SWR, node services
 * @index_tags nodes, overview, metrics, ui
 * @author holic512
 */
"use client";
import { NativeSelect } from "@/components/ui/native-select";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ClusterMonitoring,
  type ClusterNodeHealth,
} from "./cluster-monitoring";
import { useState, type ReactNode } from "react";
import {
  Server,
  Activity,
  Clock,
  Plus,
  RotateCw,
  ArrowUpRight,
  ChevronLeft,
  ShieldCheck,
} from "lucide-react";
import {
  rpc,
  date,
  percent,
  type NodeData,
  type NodeFolderData,
} from "@/lib/client";
import {
  useQuery,
  useOperation,
  PageTitle,
  DataTable,
  Status,
  QueryState,
  JsonView,
} from "./shared";
import { Button } from "./ui/button";
import { ViewTabs } from "./ui/tabs";
import { NodeEditor, NodeLabels } from "./node-editor";
import { NodeMonitoring } from "./node-monitoring";
import { MonitoringWorkspace } from "./monitoring-workspace";
import type { HistorySelection } from "@/lib/monitoring-explorer";
const online = (node: NodeData) => node.connected;
export function Overview() {
  const q = useQuery<{
    total: number;
    online: number;
    pending: number;
    offline: number;
    nodes: NodeData[];
    tasks: { status: string; _count: number }[];
    generatedAt: string;
  }>("overview");
  const monitoring = useQuery<ClusterNodeHealth[]>("nodes.monitoring");
  const o = q.data;
  const [refreshing, setRefreshing] = useState(false);
  return (
    <div className="cluster-overview">
      <PageTitle title="集群总览">
        {o && (
          <time className="cluster-updated-at" dateTime={o.generatedAt}>
            总览更新于 {date(o.generatedAt)}
          </time>
        )}
        <Button
          variant="outline"
          aria-disabled={refreshing}
          aria-busy={refreshing}
          onClick={async () => {
            if (refreshing) return;
            setRefreshing(true);
            await Promise.allSettled([q.mutate(), monitoring.mutate()]);
            setRefreshing(false);
          }}
        >
          <RotateCw size={15} />
          {refreshing ? "刷新中…" : "刷新"}
        </Button>
        <Button asChild>
          <Link href="/nodes">
            <Plus size={16} />
            接入节点
          </Link>
        </Button>
      </PageTitle>
      <QueryState
        error={q.error}
        loading={q.isLoading}
        retry={() => void q.mutate()}
      >
        <div className="summary-row">
          {[
            {
              label: "节点总数",
              value: o?.total,
              icon: Server,
            },
            {
              label: "在线节点",
              value: o?.online,
              icon: Activity,
            },
            {
              label: "待接入",
              value: o?.pending,
              icon: ShieldCheck,
            },
            {
              label: "离线 / 吊销",
              value: o?.offline,
              icon: Clock,
            },
          ].map((s) => (
            <div className="summary-cell" key={s.label}>
              <div className="summary-label">
                <span>{s.label}</span>
                <s.icon size={19} />
              </div>
              <strong>{s.value ?? "—"}</strong>
            </div>
          ))}
        </div>
        {o?.total === 0 ? (
          <section className="panel" aria-labelledby="cluster-onboarding-title">
            <div className="panel-header">
              <h2 id="cluster-onboarding-title">接入首个节点</h2>
            </div>
            <ol className="steps">
              <li>安装并启动 Linux Agent，导出接入文件。</li>
              <li>在节点管理中导入接入文件，测试连接后确认添加。</li>
            </ol>
          </section>
        ) : (
          <>
            <ClusterMonitoring monitoring={monitoring} />
            <section
              className="panel cluster-overview-section"
              aria-labelledby="cluster-resources-title"
            >
              <div className="panel-header">
                <h2 id="cluster-resources-title">节点资源快照</h2>
                <Button variant="link" asChild>
                  <Link href="/nodes">
                    查看全部 <ArrowUpRight size={14} />
                  </Link>
                </Button>
              </div>
              <NodeTable nodes={o?.nodes ?? []} />
            </section>
          </>
        )}
        <section
          className="panel cluster-overview-section"
          aria-labelledby="cluster-tasks-title"
        >
          <div className="panel-header">
            <h2 id="cluster-tasks-title">执行任务</h2>
            <Button variant="link" asChild>
              <Link href="/tasks">
                任务中心 <ArrowUpRight size={14} />
              </Link>
            </Button>
          </div>
          {o?.tasks.length ? (
            <dl className="task-counts">
              {o.tasks.map((t) => (
                <div key={t.status}>
                  <dt>
                    <Status value={t.status} />
                  </dt>
                  <dd>{t._count}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="panel-empty">暂无可查看的任务记录。</p>
          )}
        </section>
      </QueryState>
    </div>
  );
}
function NodeTable({ nodes }: { nodes: NodeData[] }) {
  return (
    <QueryState
      loading={false}
      retry={() => {}}
      empty={!nodes.length}
      emptyTitle="集群还没有节点"
      emptyText="通过部署脚本安装并启动 Agent，然后导入接入文件。"
    >
      <DataTable
        label="节点资源快照"
        headers={[
          "节点 / 主机",
          "连接状态",
          "CPU",
          "内存",
          "系统",
          "最近心跳",
          "操作",
        ]}
      >
        {nodes.map((n) => (
          <tr key={n.id}>
            <td>
              <NodeIdentity node={n} />
            </td>
            <NodeCells node={n} />
          </tr>
        ))}
      </DataTable>
    </QueryState>
  );
}
export function NodeIdentity({ node }: { node: NodeData }) {
  return (
    <div className="node-identity">
      <Link className="entity-link" href={`/nodes/${node.id}`}>
        {node.name}
      </Link>
      <small>{node.hostname ?? node.id}</small>
      <NodeLabels labels={node.labels} />
    </div>
  );
}
export function NodeCells({
  node,
  children,
}: {
  node: NodeData;
  children?: ReactNode;
}) {
  return (
    <>
      <td>
        {!node.agentId ? (
          <span>待重新接入</span>
        ) : (
          <Status
            value={
              node.status === "APPROVED"
                ? online(node)
                  ? "online"
                  : "offline"
                : node.status
            }
          />
        )}
        {node.agentUrl && <small>HTTPS · 已校验证书</small>}
        {node.stale && node.metrics.length > 0 && (
          <small>指标已过期 / 回退历史</small>
        )}
        {node.connectionError && (
          <small className="error-text">{node.connectionError}</small>
        )}
      </td>
      <td>
        <MetricBar value={node.metrics[0]?.cpuPercent} />
      </td>
      <td>
        <MetricBar value={node.metrics[0]?.memoryPercent} />
      </td>
      <td>
        {node.os ?? "—"}
        <small>{node.arch ?? "待采集"}</small>
      </td>
      <td>{date(node.lastSeenAt)}</td>
      <td>
        {children}
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/nodes/${node.id}`}>
            查看详情
            <ArrowUpRight size={14} />
          </Link>
        </Button>
      </td>
    </>
  );
}
function MetricBar({ value }: { value?: number | null }) {
  return (
    <div className="metric-bar">
      <span>{percent(value)}</span>
      {value !== undefined && value !== null && (
        <div className="meter">
          <div
            style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
            className={value > 85 ? "meter-high" : ""}
          />
        </div>
      )}
    </div>
  );
}
export function NodeDetail({ id }: { id: string }) {
  const search = useSearchParams();
  const monitoringContext = search.get("context")?.slice(0, 1000);
  const q = useQuery<NodeData>("nodes.get", { nodeId: id });
  const user = useQuery<{ role: string }>("users.me", {}, 0);
  const canWrite = !!user.data && user.data.role !== "VIEWER";
  const folders = useQuery<NodeFolderData[]>(
    canWrite ? "nodeFolders.list" : null,
  );
  const node = q.data;
  const agentHost = node?.agentUrl ? new URL(node.agentUrl).hostname : null;
  const [hours, setHours] = useState(1);
  const [edit, setEdit] = useState(false);
  const [tab, setTab] = useState(
    ["live", "resources", "processes", "services", "details"].includes(
      search.get("monitor") ?? "",
    )
      ? search.get("monitor")!
      : "live",
  );
  const [monitoringHistory, setMonitoringHistory] = useState<HistorySelection>({
    metric: "cpu.total",
    device: undefined,
    hours: 1,
  });
  const h = useQuery<{
    resolution: string;
    samples: Record<string, unknown>[];
  }>(tab === "metrics" ? "nodes.metrics" : null, { nodeId: id, hours });
  const op = useOperation(() => void q.mutate());
  return (
    <>
      <Button variant="link" asChild>
        <Link href="/nodes" className="back-link">
          <ChevronLeft size={16} strokeWidth={1.5} aria-hidden="true" />
          节点管理
        </Link>
      </Button>
      <PageTitle title={node?.name ?? "节点详情"}>
        <Button variant="outline" asChild>
          <Link href={`/resources?node=${id}`}>节点资源</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href={`/terminal?node=${id}`}>打开工作台</Link>
        </Button>
        {canWrite && (
          <Button
            variant="outline"
            disabled={!folders.data || !!folders.error}
            onClick={() => setEdit(true)}
          >
            编辑节点
          </Button>
        )}
        {user.data?.role === "ADMIN" && node?.status === "APPROVED" && (
          <Button
            variant="destructive"
            onClick={() =>
              op.ask(
                "吊销节点接入？",
                "现有连接将断开，此节点将无法接收任务或上报指标。",
                () => rpc("nodes.revoke", { id, confirmed: true }),
              )
            }
          >
            吊销接入
          </Button>
        )}
      </PageTitle>
      {op.ui}
      {monitoringContext && (
        <p role="status" className="surface">
          来自集群总览：{monitoringContext}
        </p>
      )}
      {folders.error && (
        <p role="alert" className="error-text">
          分类加载失败：{folders.error.message}{" "}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void folders.mutate()}
          >
            重试
          </Button>
        </p>
      )}
      {edit && node && folders.data && (
        <NodeEditor
          node={node}
          nodes={node ? [node] : []}
          folders={folders.data}
          onClose={() => setEdit(false)}
          onSaved={() => {
            void q.mutate();
            setEdit(false);
          }}
        />
      )}
      <QueryState
        error={q.error}
        loading={q.isLoading}
        retry={() => void q.mutate()}
        empty={!node}
        emptyTitle="节点不存在或没有访问权限"
        emptyText="返回节点列表检查节点状态。"
      >
        {node && (
          <>
            <div className="surface node-detail-summary">
              <Status
                value={
                  node.status === "APPROVED"
                    ? online(node)
                      ? "online"
                      : "offline"
                    : node.status
                }
              />
              <dl className="node-detail-fields">
                <div>
                  <dt>接入主机</dt>
                  <dd>
                    {agentHost ? (
                      <code title={node.agentUrl ?? undefined}>
                        {agentHost}
                      </code>
                    ) : (
                      "未配置"
                    )}
                  </dd>
                </div>
                {node.hostname !== node.name && (
                  <div>
                    <dt>主机名</dt>
                    <dd>{node.hostname ?? "等待采集"}</dd>
                  </div>
                )}
                <div>
                  <dt>系统</dt>
                  <dd>
                    {node.os ?? "等待采集"}
                    {node.arch ? ` / ${node.arch}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>Agent</dt>
                  <dd>{node.agentVersion ?? "—"}</dd>
                </div>
                <div>
                  <dt>最近心跳</dt>
                  <dd>{date(node.lastSeenAt)}</dd>
                </div>
                <div>
                  <dt>节点 ID</dt>
                  <dd>
                    <code>{node.id}</code>
                  </dd>
                </div>
              </dl>
              <NodeLabels labels={node.labels} />
              {node.connectionError && (
                <p className="error-text">连接异常：{node.connectionError}</p>
              )}
            </div>
            <MonitoringWorkspace nodeId={id} onNavigate={setTab}>
              <ViewTabs
                label="节点监控"
                value={tab}
                onValueChange={setTab}
                items={[
                  { value: "live", label: "实时概览" },
                  { value: "metrics", label: "历史监控" },
                  { value: "resources", label: "磁盘 / 网络 / IO" },
                  { value: "processes", label: "进程 / 连接" },
                  { value: "services", label: "服务 / 容器" },
                  { value: "system", label: "系统信息" },
                  { value: "details", label: "采集详情" },
                ]}
              >
                {tab === "metrics" ? (
                  <section className="panel">
                    <div className="panel-header">
                      <h2>CPU 与内存</h2>
                      <NativeSelect
                        aria-label="监控时间范围"
                        value={hours}
                        onChange={(e) => setHours(Number(e.target.value))}
                      >
                        {[
                          [1, "最近1小时"],
                          [24, "最近24小时"],
                          [168, "最近7天（小时聚合）"],
                          [720, "最近30天（小时聚合）"],
                        ].map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    <QueryState
                      error={h.error}
                      loading={h.isLoading}
                      empty={!h.data?.samples.length}
                      retry={() => void h.mutate()}
                      emptyTitle="暂无历史采样"
                      emptyText="节点批准并连接后，Agent 会定期采集资源指标。"
                    >
                      <HistoryChart
                        samples={h.data?.samples ?? []}
                        hourly={h.data?.resolution === "hour"}
                      />
                    </QueryState>
                  </section>
                ) : [
                    "live",
                    "resources",
                    "processes",
                    "services",
                    "system",
                    "details",
                  ].includes(tab) ? (
                  <NodeMonitoring
                    nodeId={id}
                    view={tab}
                    historySelection={monitoringHistory}
                    onHistorySelectionChange={setMonitoringHistory}
                  />
                ) : (
                  <section className="panel form-panel">
                    <h2>最近一次完整采样</h2>
                    <p className="muted">
                      磁盘、网卡、IO、进程、端口及容器来自 Agent 真实采集。
                    </p>
                    {node.metrics[0] ? (
                      <JsonView data={node.metrics[0].payload} />
                    ) : (
                      <p className="panel-empty">尚未收到采样。</p>
                    )}
                  </section>
                )}
              </ViewTabs>
            </MonitoringWorkspace>
          </>
        )}
      </QueryState>
    </>
  );
}
function HistoryChart({
  samples,
  hourly,
}: {
  samples: Record<string, unknown>[];
  hourly: boolean;
}) {
  const data = [...samples].sort(
    (a, b) =>
      new Date(String(a.recordedAt ?? a.bucketAt)).getTime() -
      new Date(String(b.recordedAt ?? b.bucketAt)).getTime(),
  );
  const series = (key: string) => {
    let previous = false;
    return data
      .map((p, i) => {
        if (typeof p[key] !== "number") {
          previous = false;
          return "";
        }
        const command = previous ? "L" : "M";
        previous = true;
        return `${command}${40 + (i / Math.max(data.length - 1, 1)) * 910},${220 - Number(p[key]) * 1.8}`;
      })
      .join(" ");
  };
  return (
    <div className="history-chart">
      <div className="chart-legend">
        <span className="cpu-legend" />
        CPU <span className="memory-legend" />
        内存{" "}
        <span className="muted">
          {hourly ? "小时均值" : "采样聚合"} · {data.length} 个点
        </span>
      </div>
      <div
        className="resource-chart-scroll"
        role="region"
        aria-label="CPU和内存历史图表，可横向滚动"
        tabIndex={0}
      >
        <svg
          viewBox="0 0 1000 270"
          role="img"
          aria-label="CPU和内存使用率历史折线图"
        >
          {[0, 25, 50, 75, 100].map((n) => (
            <g key={n}>
              <line
                x1="40"
                x2="960"
                y1={220 - n * 1.8}
                y2={220 - n * 1.8}
                stroke="var(--chart-grid)"
              />
              <text
                x="3"
                y={224 - n * 1.8}
                fontSize="var(--font-size-sm)"
                fill="var(--muted-foreground)"
              >
                {n}%
              </text>
            </g>
          ))}
          <path
            d={series(hourly ? "cpuAvg" : "cpuPercent")}
            fill="none"
            stroke="var(--chart-1)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={series(hourly ? "memoryAvg" : "memoryPercent")}
            fill="none"
            stroke="var(--chart-2)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <text
            x="40"
            y="255"
            fontSize="var(--font-size-sm)"
            fill="var(--muted-foreground)"
          >
            {date(String(data[0]?.recordedAt ?? data[0]?.bucketAt))}
          </text>
          <text
            x="960"
            textAnchor="end"
            y="255"
            fontSize="var(--font-size-sm)"
            fill="var(--muted-foreground)"
          >
            {date(String(data.at(-1)?.recordedAt ?? data.at(-1)?.bucketAt))}
          </text>
        </svg>
      </div>
    </div>
  );
}
