/**
 * @file nodes.tsx
 * @project PipkerOps
 * @module node-monitoring-ui
 * @description 集群概览、注册审批与节点实际指标历史。
 * @logic 统一查询真实 API，未采样显示空态，审批/吊销需确认。
 * @dependencies React, SWR, node services
 * @index_tags nodes, overview, metrics, ui
 * @author holic512
 */
"use client";
import Link from "next/link";
import { useState } from "react";
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
import { rpc, date, percent, type NodeData } from "@/lib/client";
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
  const o = q.data;
  return (
    <>
      <PageTitle
        title="集群总览"
        description="了解节点状态，及时发现需要处理的问题。"
      >
        <Button variant="outline" onClick={() => void q.mutate()}>
          <RotateCw size={15} />
          刷新
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
              detail: "已登记的集群节点",
            },
            {
              label: "在线节点",
              value: o?.online,
              icon: Activity,
              detail: "最近 60 秒收到心跳",
            },
            {
              label: "待审批",
              value: o?.pending,
              icon: ShieldCheck,
              detail: "等待管理员审核接入",
            },
            {
              label: "离线 / 吊销",
              value: o?.offline,
              icon: Clock,
              detail: "检查节点与网络状态",
            },
          ].map((s) => (
            <section className="summary-cell" key={s.label}>
              <div className="summary-label">
                <span>{s.label}</span>
                <s.icon size={19} />
              </div>
              <strong>{s.value ?? "—"}</strong>
              <small>{s.detail}</small>
            </section>
          ))}
        </div>
        <div className="section-heading">
          <h2>节点资源</h2>
          <Link href="/nodes">
            查看全部
            <ArrowUpRight size={14} />
          </Link>
        </div>
        <NodeTable nodes={o?.nodes ?? []} />
        <div className="overview-bottom">
          <section className="panel">
            <div className="panel-header">
              <h2>执行任务</h2>
              <Link href="/tasks">任务中心</Link>
            </div>
            {o?.tasks.length ? (
              <div className="task-counts">
                {o.tasks.map((t) => (
                  <div key={t.status}>
                    <Status value={t.status} />
                    <strong>{t._count}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p className="panel-empty">
                尚未执行任务。从节点详情发起第一次操作。
              </p>
            )}
          </section>
          <section className="panel">
            <div className="panel-header">
              <h2>接入流程</h2>
              <Link href="/nodes">节点管理</Link>
            </div>
            <ol className="steps">
              <li>生成一次性注册令牌，安装 Linux Agent</li>
              <li>审核节点身份，签发 mTLS 客户端证书</li>
              <li>接收真实采样，统一管理应用和运维任务</li>
            </ol>
          </section>
        </div>
        <p className="data-stamp">数据更新于 {date(o?.generatedAt)}</p>
      </QueryState>
    </>
  );
}
function NodeTable({ nodes }: { nodes: NodeData[] }) {
  return (
    <QueryState
      loading={false}
      retry={() => {}}
      empty={!nodes.length}
      emptyTitle="集群还没有节点"
      emptyText="在节点管理中生成注册令牌，将第一台 Linux 节点加入集群。"
    >
      <DataTable
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
              <Link className="entity-link" href={`/nodes/${n.id}`}>
                {n.name}
              </Link>
              <small>{n.hostname ?? n.id}</small>
            </td>
            <td>
              <Status
                value={
                  n.status === "APPROVED"
                    ? online(n)
                      ? "online"
                      : "offline"
                    : n.status
                }
              />
            </td>
            <td>
              <MetricBar value={n.metrics[0]?.cpuPercent} />
            </td>
            <td>
              <MetricBar value={n.metrics[0]?.memoryPercent} />
            </td>
            <td>
              {n.os ?? "—"}
              <small>{n.arch ?? "待采集"}</small>
            </td>
            <td>{date(n.lastSeenAt)}</td>
            <td>
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/nodes/${n.id}`}>
                  查看详情
                  <ArrowUpRight size={14} />
                </Link>
              </Button>
            </td>
          </tr>
        ))}
      </DataTable>
    </QueryState>
  );
}
function MetricBar({ value }: { value?: number }) {
  return (
    <div className="metric-bar">
      <span>{percent(value)}</span>
      {value !== undefined && (
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
export function Nodes() {
  const q = useQuery<NodeData[]>("nodes.list");
  const op = useOperation(() => void q.mutate());
  const [show, setShow] = useState(false);
  const [token, setToken] = useState<{
    token: string;
    expiresAt: string;
    enrollUrl: string;
    gateway: string;
  } | null>(null);
  const [filter, setFilter] = useState("");
  return (
    <>
      <PageTitle
        title="节点管理"
        description="审批节点接入，查看集群连接与资源状态。"
      >
        <Button variant="outline" onClick={() => void q.mutate()}>
          <RotateCw size={15} />
          刷新
        </Button>
        <Button onClick={() => setShow(!show)}>
          <Plus size={16} />
          注册节点
        </Button>
      </PageTitle>
      {op.ui}
      {show && (
        <section className="panel form-panel">
          <h2>生成注册令牌</h2>
          <p className="muted">
            令牌只展示一次。将 CA 公钥证书安全复制到节点后运行
            Agent，随后在这里审批。
          </p>
          <ResourceForm
            fields={[
              {
                name: "name",
                label: "令牌用途",
                required: true,
                placeholder: "如：新接入的生产节点",
              },
              {
                name: "maxUses",
                label: "最大使用次数",
                type: "number",
                defaultValue: 1,
                min: 1,
                max: 50,
              },
              {
                name: "hours",
                label: "有效小时数",
                type: "number",
                defaultValue: 24,
                min: 1,
                max: 168,
              },
            ]}
            busy={op.busy}
            submit="生成令牌"
            onSubmit={async (data) => {
              const result = await op.run(
                () => rpc<typeof token>("nodes.token", data),
                "注册令牌已生成，请安全保存",
              );
              if (result) setToken(result);
            }}
          />
          {token && (
            <div className="secret-result">
              <strong>令牌仅展示一次</strong>
              <pre>{token.token}</pre>
              <p>有效期至 {date(token.expiresAt)}</p>
              <code>
                pipker-agent --enroll-url {token.enrollUrl} --gateway{" "}
                {token.gateway} --ca /etc/pipkerops/ca.crt --token-file
                /etc/pipkerops/enrollment-token
              </code>
              <p className="muted">
                把令牌写入权限为 0600 的 enrollment-token 文件。CA 公钥来自主控
                PKI 目录；不要复制 CA 私钥。
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setToken(null);
                  setShow(false);
                }}
              >
                已保存，隐藏令牌
              </Button>
            </div>
          )}
        </section>
      )}
      <div className="list-toolbar">
        <input
          aria-label="搜索节点"
          placeholder="搜索节点名称或主机名"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="muted">{q.data?.length ?? 0} 个节点</span>
      </div>
      <QueryState
        error={q.error}
        loading={q.isLoading}
        retry={() => void q.mutate()}
      >
        <NodeTable
          nodes={
            q.data?.filter((n) =>
              (n.name + " " + n.hostname)
                .toLowerCase()
                .includes(filter.toLowerCase()),
            ) ?? []
          }
        />
      </QueryState>
      <div className="section-heading">
        <h2>接入审批</h2>
      </div>
      <section className="panel">
        <QueryState
          loading={q.isLoading}
          retry={() => void q.mutate()}
          empty={!q.data?.some((n) => n.status === "PENDING")}
          emptyTitle="没有待审批节点"
          emptyText="Agent 提交注册请求后，会显示在这里。"
        >
          <DataTable headers={["节点", "主机 / 平台", "申请时间", "操作"]}>
            {q.data
              ?.filter((n) => n.status === "PENDING")
              .map((n) => (
                <tr key={n.id}>
                  <td>{n.name}</td>
                  <td>
                    {n.hostname}
                    <small>
                      {n.os} / {n.arch}
                    </small>
                  </td>
                  <td>{date(n.createdAt)}</td>
                  <td className="inline-actions">
                    <Button
                      size="sm"
                      onClick={() =>
                        op.ask(
                          `批准 ${n.name}？`,
                          "批准后签发客户端证书，允许此节点提交采样和执行任务。请核对节点身份。",
                          () =>
                            rpc("nodes.approve", { id: n.id, confirmed: true }),
                        )
                      }
                    >
                      批准接入
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        op.ask(
                          `拒绝 ${n.name}？`,
                          "此节点将无法取得客户端证书。",
                          () =>
                            rpc("nodes.reject", { id: n.id, confirmed: true }),
                        )
                      }
                    >
                      拒绝
                    </Button>
                  </td>
                </tr>
              ))}
          </DataTable>
        </QueryState>
      </section>
    </>
  );
}
export function NodeDetail({ id }: { id: string }) {
  const q = useQuery<NodeData[]>("nodes.list");
  const node = q.data?.find((n) => n.id === id);
  const [hours, setHours] = useState(1);
  const [edit, setEdit] = useState(false);
  const h = useQuery<{
    resolution: string;
    samples: Record<string, unknown>[];
  }>("nodes.metrics", { nodeId: id, hours });
  const op = useOperation(() => void q.mutate());
  const [tab, setTab] = useState("metrics");
  return (
    <>
      <Link href="/nodes" className="back-link">
        <ChevronLeft size={15} />
        节点管理
      </Link>
      <PageTitle
        title={node?.name ?? "节点详情"}
        description={`${node?.hostname ?? id} · ${node?.os ?? "等待采集"} / ${node?.arch ?? "—"}`}
      >
        <Button variant="outline" asChild>
          <Link href={`/terminal?node=${id}`}>打开终端</Link>
        </Button>
        <Button variant="outline" onClick={() => setEdit(!edit)}>
          编辑名称与标签
        </Button>
        {node?.status === "APPROVED" && (
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
      {edit && node && (
        <section className="panel form-panel">
          <h2>节点信息</h2>
          <ResourceForm
            key={node.id}
            busy={op.busy}
            fields={[
              {
                name: "name",
                label: "节点名称",
                required: true,
                defaultValue: node.name,
              },
              {
                name: "labels",
                label: "标签（JSON 数组）",
                type: "json",
                defaultValue: JSON.stringify(node.labels),
              },
            ]}
            onSubmit={async (data) => {
              const result = await op.run(() =>
                rpc("nodes.update", { ...data, id }),
              );
              if (result) setEdit(false);
            }}
          />
        </section>
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
            <div className="node-summary">
              <Status
                value={
                  node.status === "APPROVED"
                    ? online(node)
                      ? "online"
                      : "offline"
                    : node.status
                }
              />
              <span>Agent {node.agentVersion ?? "—"}</span>
              <span>最近心跳 {date(node.lastSeenAt)}</span>
              <span>
                节点 ID <code>{node.id}</code>
              </span>
            </div>
            <div className="inner-tabs">
              {[
                ["metrics", "历史监控"],
                ["details", "采集详情"],
              ].map(([key, name]) => (
                <button
                  key={key}
                  className={tab === key ? "active" : ""}
                  onClick={() => setTab(key)}
                >
                  {name}
                </button>
              ))}
            </div>
            {tab === "metrics" ? (
              <section className="panel">
                <div className="panel-header">
                  <h2>CPU 与内存</h2>
                  <select
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
                  </select>
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
  const series = (key: string) =>
    data
      .map(
        (p, i) =>
          `${40 + (i / Math.max(data.length - 1, 1)) * 910},${220 - Number(p[key] ?? 0) * 1.8}`,
      )
      .join(" ");
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
              stroke="#e5eaf0"
            />
            <text x="3" y={224 - n * 1.8} fontSize="12" fill="#526173">
              {n}%
            </text>
          </g>
        ))}
        <polyline
          points={series(hourly ? "cpuAvg" : "cpuPercent")}
          fill="none"
          stroke="#1664df"
          strokeWidth="2"
        />
        <polyline
          points={series(hourly ? "memoryAvg" : "memoryPercent")}
          fill="none"
          stroke="#0e8a70"
          strokeWidth="2"
        />
        <text x="40" y="255" fontSize="12" fill="#526173">
          {date(String(data[0]?.recordedAt ?? data[0]?.bucketAt))}
        </text>
        <text x="960" textAnchor="end" y="255" fontSize="12" fill="#526173">
          {date(String(data.at(-1)?.recordedAt ?? data.at(-1)?.bucketAt))}
        </text>
      </svg>
    </div>
  );
}
