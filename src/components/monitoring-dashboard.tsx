"use client";
import { useState } from "react";
import { useQuery, QueryState, Status } from "./shared";
import {
  Activity,
  HardDrive,
  ListChecks,
  Server,
  CircleCheck,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  CoreUsageChart,
  RankChart,
  StateDonut,
  TrendChart,
  type TrendSeries,
} from "@/components/ui/chart";
import {
  monitoringRows,
  stateSlices,
  insertSamplingGaps,
  type MonitoringRow,
} from "@/lib/monitoring-visuals";
import { diagnosticAdvice } from "@/lib/monitoring-availability";
import { date } from "@/lib/client";
import type { Snapshot } from "@/lib/telemetry";
import type { HistorySelection } from "@/lib/monitoring-explorer";
import { useMonitoringWorkspace } from "./monitoring-workspace";

type Result = {
  categories: (Snapshot & { stale?: boolean })[];
  payload: MonitoringRow;
  legacy: boolean;
};
type History = { unit: string; bucketSeconds: number; series: TrendSeries[] };
export function MetricTrend({
  nodeId,
  metrics,
  device,
  hours,
  title,
  onHistory,
}: {
  nodeId: string;
  metrics: [string, string][];
  device?: string;
  hours: number;
  title: string;
  onHistory?: (v: Pick<HistorySelection, "metric" | "device">) => void;
}) {
  const a = useQuery<History>(
    "nodes.history",
    {
      nodeId,
      kind: "metric",
      metric: metrics[0][0],
      device: device || undefined,
      hours,
    },
    30000,
  );
  const b = useQuery<History>(
    metrics[1] ? "nodes.history" : null,
    {
      nodeId,
      kind: "metric",
      metric: metrics[1]?.[0],
      device: device || undefined,
      hours,
    },
    30000,
  );
  const series = [a.data, b.data].flatMap((r, i) =>
    r
      ? r.series.map((s) => ({
          name: metrics[i][1],
          points: insertSamplingGaps(s.points, r.bucketSeconds * 2000),
        }))
      : [],
  );
  return (
    <section className="panel monitoring-chart-panel">
      <div className="panel-header">
        <h2>
          {title}
          {device ? ` · ${device}` : ""}
        </h2>
        {onHistory && (
          <Button
            variant="link"
            onClick={() => onHistory({ metric: metrics[0][0], device })}
          >
            查看历史
          </Button>
        )}
      </div>
      <QueryState
        loading={a.isLoading || b.isLoading}
        error={a.error || b.error}
        retry={() => {
          void a.mutate();
          void b.mutate();
        }}
        empty={!series.some((s) => s.points.some((p) => p.value !== null))}
        emptyText="此对象或范围暂无有效采样；缺口不会补零。"
      >
        <TrendChart series={series} unit={a.data?.unit ?? ""} label={title} />
      </QueryState>
    </section>
  );
}

export function ProcessRanking({
  payload,
  onNavigate,
}: {
  payload: MonitoringRow;
  onNavigate?: () => void;
}) {
  const workspace = useMonitoringWorkspace();
  const [localMetric, setLocalMetric] = useState("cpuPercent");
  const metric = workspace?.state.rank ?? localMetric;
  const setMetric = (rank: string) => {
    setLocalMetric(rank);
    workspace?.setState((s) => ({ ...s, rank }));
  };
  const rows = monitoringRows(
    metric === "cpuPercent" ? payload.processes : payload.memoryTop,
  );
  const data = rows
    .filter((r) => typeof r[metric] === "number")
    .sort((a, b) => Number(b[metric]) - Number(a[metric]))
    .slice(0, 8)
    .map((r) => ({
      name: `${String(r.name).slice(0, 18)} · ${r.pid}`,
      value: Number(r[metric]),
    }));
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>进程 Top</h2>
        <NativeSelect
          aria-label="进程排行指标"
          value={metric}
          onChange={(e) => setMetric(e.target.value)}
        >
          <option value="cpuPercent">CPU</option>
          <option value="memoryPercent">内存</option>
        </NativeSelect>
        {onNavigate && (
          <Button variant="link" onClick={onNavigate}>
            定位进程
          </Button>
        )}
      </div>
      {data.length ? (
        <RankChart
          data={data}
          unit="%"
          label={metric === "cpuPercent" ? "进程 CPU（按单核）" : "进程内存"}
        />
      ) : (
        <p className="muted">等待有效采样；首次 CPU 采样需要基线。</p>
      )}
      <p className="muted monitoring-panel-note">
        CPU 按单核计算，可超过 100%。排行仅代表当前采样范围。
      </p>
    </section>
  );
}

export function ObjectDistribution({
  payload,
  kind,
  onNavigate,
}: {
  payload: MonitoringRow;
  kind: "service" | "container";
  onNavigate?: () => void;
}) {
  const title = kind === "service" ? "服务状态" : "容器状态";
  const slices = stateSlices(
    monitoringRows(payload[kind === "service" ? "services" : "containers"]),
    kind,
  );
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>{title}</h2>
        {onNavigate && (
          <Button variant="link" onClick={onNavigate}>
            异常明细
          </Button>
        )}
      </div>
      <StateDonut slices={slices} label={title} />
      <p className="muted monitoring-panel-note">
        有界快照中的状态分布；未覆盖对象不推断正常。
      </p>
    </section>
  );
}

export function CollectionQuality({
  result,
  onNavigate,
}: {
  result?: Result;
  onNavigate: () => void;
}) {
  const categories = [
    { category: "fast", label: "实时指标", Icon: Activity },
    { category: "disks", label: "文件系统", Icon: HardDrive },
    { category: "details", label: "运行明细", Icon: ListChecks },
    { category: "static", label: "系统信息", Icon: Server },
  ];
  const normal = categories.filter(({ category }) => {
    const s = result?.categories.find((s) => s.category === category);
    return s && !s.stale && !s.errors.length && !s.truncated;
  }).length;
  return (
    <section className="panel monitoring-quality" aria-label="采集质量">
      <div className="panel-header">
        <div className="monitoring-quality-title">
          <h2>采集质量</h2>
          <span className="muted">
            {result
              ? `${normal} 类正常 · ${categories.length - normal} 类需关注`
              : "等待分类采样"}
          </span>
        </div>
        <Button variant="link" onClick={onNavigate}>
          采集详情
        </Button>
      </div>
      <div className="monitoring-quality-grid">
        {categories.map(({ category, label, Icon }) => {
          const s = result?.categories.find((s) => s.category === category);
          const failed = !!s?.errors.length;
          const stateLabel = !s
            ? result?.legacy
              ? "需要升级"
              : "等待采样"
            : s.stale
              ? "采样过期"
              : failed
                ? "部分失败"
                : s.truncated
                  ? "已截断"
                  : "正常";
          const state = !s
            ? "UNKNOWN"
            : s.stale
              ? "STALE"
              : failed
                ? "FAILED"
                : s.truncated
                  ? "DEGRADED"
                  : "HEALTHY";
          const advice = !s
            ? "检查节点连接与 Agent 版本"
            : s.stale
              ? "检查 Agent 连接，等待新采样"
              : failed
                ? diagnosticAdvice(s.errors, false).split("；")[0]
                : s.truncated
                  ? "仅展示已采集范围，请核对完整清单"
                  : "";
          return (
            <section
              className="surface monitoring-quality-card"
              key={category}
              data-state={state}
              aria-label={`${label}：${stateLabel}`}
            >
              <div className="monitoring-quality-card-heading">
                <span className="monitoring-quality-icon">
                  <Icon size={16} aria-hidden="true" />
                </span>
                <h3>{label}</h3>
                <Status value={state} label={stateLabel} />
              </div>
              <dl className="monitoring-quality-metadata">
                <div>
                  <dt>最近成功</dt>
                  <dd>
                    {s?.lastSuccessAt ? (
                      <time dateTime={s.lastSuccessAt}>
                        {date(s.lastSuccessAt)}
                      </time>
                    ) : (
                      "尚无成功记录"
                    )}
                  </dd>
                </div>
                <div>
                  <dt>采集耗时</dt>
                  <dd className="monitoring-quality-duration">
                    {s ? (
                      <>
                        {s.durationMs.toFixed(1)}
                        <span>ms</span>
                      </>
                    ) : (
                      "—"
                    )}
                  </dd>
                </div>
              </dl>
              {failed && (
                <div className="monitoring-quality-issue">
                  <span>
                    <AlertCircle size={14} aria-hidden="true" />
                    失败原因
                    {s.errors.length > 1 ? ` · ${s.errors.length} 项` : ""}
                  </span>
                  <p>{s.errors[0]}</p>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={onNavigate}
                    aria-label={`查看${label}的全部采集问题`}
                  >
                    查看问题详情
                  </Button>
                </div>
              )}
              <div className="monitoring-quality-card-footer">
                {advice ? (
                  <p>{advice}</p>
                ) : (
                  <span className="monitoring-quality-ok">
                    <CircleCheck size={14} aria-hidden="true" />
                    未报告采集错误
                  </span>
                )}
                <span
                  className={
                    s?.truncated ? "monitoring-quality-truncated" : "muted"
                  }
                >
                  {!s
                    ? "尚无采样范围信息"
                    : s.truncated
                      ? "结果已截断"
                      : "未报告截断"}
                </span>
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

export function MonitoringDashboard({
  nodeId,
  fast,
  details,
  all,
  network,
  io,
  hours,
  onHistory,
  onNavigate,
  detailState,
}: {
  nodeId: string;
  fast?: Result;
  details?: Result;
  all?: Result;
  network?: string;
  io?: string;
  hours: number;
  onHistory: (v: Pick<HistorySelection, "metric" | "device">) => void;
  onNavigate: (tab: string, abnormal?: boolean) => void;
  detailState?: { loading: boolean; error?: Error; retry: () => void };
}) {
  const cores = monitoringRows(fast?.payload.cpuCores);
  const point = (metric: string) =>
    fast?.categories[0]?.series.find(
      (p) => p.metric === metric && p.device === io,
    );
  return (
    <>
      <div className="monitoring-dashboard-grid">
        <section className="panel">
          <div className="panel-header">
            <h2>CPU 各核 · 当前采样</h2>
            <Button
              variant="link"
              onClick={() =>
                onHistory({ metric: "cpu.total", device: undefined })
              }
            >
              总体历史
            </Button>
          </div>
          {cores.length ? (
            <CoreUsageChart
              cores={cores.map((core, i) => ({
                name: String(core.name ?? `CPU ${i}`),
                value: typeof core.percent === "number" ? core.percent : null,
              }))}
              stale={fast?.categories[0]?.stale}
            />
          ) : (
            <p className="muted monitoring-panel-note">
              {fast?.legacy ? "需要升级 Agent" : "等待各核采样"}
            </p>
          )}
          <p className="muted monitoring-panel-note">
            仅当前采样，不保存逐核长期历史。
          </p>
        </section>
        <MetricTrend
          nodeId={nodeId}
          metrics={[["cpu.total", "总体 CPU"]]}
          hours={hours}
          title="CPU 总体趋势 · %"
          onHistory={onHistory}
        />
        <MetricTrend
          nodeId={nodeId}
          metrics={[
            ["network.recv", "接收"],
            ["network.sent", "发送"],
          ]}
          device={network}
          hours={hours}
          title="网络趋势 · B/s"
          onHistory={onHistory}
        />
        <div className="monitoring-io-panel">
          <MetricTrend
            nodeId={nodeId}
            metrics={[
              ["io.readIOPS", "读取"],
              ["io.writeIOPS", "写入"],
            ]}
            device={io}
            hours={hours}
            title="磁盘 IOPS"
            onHistory={onHistory}
          />
          <p className="surface monitoring-io-summary">
            读取延迟{" "}
            {point("io.readLatency")?.value?.toFixed(2) ?? "暂无有效采样"} ms ·
            写入延迟{" "}
            {point("io.writeLatency")?.value?.toFixed(2) ?? "暂无有效采样"} ms ·
            队列 {point("io.queue")?.value?.toFixed(2) ?? "暂无有效采样"}
          </p>
        </div>
      </div>
      <QueryState
        loading={detailState?.loading ?? false}
        error={detailState?.error}
        retry={detailState?.retry ?? (() => {})}
      >
        <div className="monitoring-dashboard-objects">
          <ProcessRanking
            payload={details?.payload ?? {}}
            onNavigate={() => onNavigate("processes")}
          />
          <ObjectDistribution
            payload={details?.payload ?? {}}
            kind="service"
            onNavigate={() => onNavigate("services", true)}
          />
          <ObjectDistribution
            payload={details?.payload ?? {}}
            kind="container"
            onNavigate={() => onNavigate("services", true)}
          />
        </div>
      </QueryState>
      <CollectionQuality
        result={all}
        onNavigate={() => onNavigate("details")}
      />
    </>
  );
}
