"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { useQuery, QueryState, DataTable, JsonView } from "./shared";
import { Button } from "./ui/button";
import { ringValueLabel } from "@/lib/ring-chart";
import { RingChart } from "@/components/ui/chart";
import { Input } from "./ui/input";
import { Checkbox } from "./ui/checkbox";
import {
  exploreRows,
  resourceWarning,
  changeHistoryMetric,
  rowHistory,
  type InventoryKind,
  type HistorySelection,
} from "@/lib/monitoring-explorer";
import { NativeSelect } from "./ui/native-select";
import { ResourceChart, ResourceHistory } from "./resource-history";
import { date } from "@/lib/client";
import type { Snapshot } from "@/lib/telemetry";
import {
  availability,
  availabilityLabels,
  diagnosticAdvice,
  hostMetricRows,
} from "@/lib/monitoring-availability";
import { monitoringRowKeys } from "@/lib/monitoring-rows";
import {
  MonitoringDashboard,
  ObjectDistribution,
  ProcessRanking,
  MetricTrend,
} from "./monitoring-dashboard";
import { useMonitoringWorkspace } from "./monitoring-workspace";
import { ObjectActions, ObjectHistory, ProcessWatches } from "./object-history";
type Row = Record<string, unknown>;
type SnapshotResult = {
  categories: (Snapshot & { stale: boolean; cacheFallback?: boolean })[];
  payload: Row;
  legacy: boolean;
};
const object = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.map(object) : []);
function text(v: unknown): string {
  if (v === null || v === undefined) return "暂无数据";
  if (typeof v === "number")
    return Number.isInteger(v) ? v.toLocaleString("zh-CN") : v.toFixed(2);
  if (Array.isArray(v)) return v.map(text).join("、");
  if (typeof v === "object")
    return Object.entries(v)
      .map(([k, value]) => `${k}: ${text(value)}`)
      .join(" · ");
  return String(v);
}
function DetailTable({
  title,
  values,
  columns,
  legacy = false,
  snapshot,
  kind,
  onHistory,
}: {
  title: string;
  values: Row[];
  columns: [string, string][];
  legacy?: boolean;
  snapshot?: Snapshot & { stale?: boolean };
  kind?: InventoryKind;
  onHistory?: (target: Pick<HistorySelection, "metric" | "device">) => void;
}) {
  const workspace = useMonitoringWorkspace();
  const [local, setLocal] = useState({
    query: "",
    onlyAbnormal: false,
    sort: "",
    device: "",
  });
  const filter = workspace?.state.filters[title] ?? {
    ...local,
    onlyAbnormal: workspace?.state.abnormal ?? local.onlyAbnormal,
  };
  const { query, onlyAbnormal, sort, device } = filter;
  const updateFilter = (patch: Partial<typeof local>) => {
    setLocal({ ...filter, ...patch });
    workspace?.setState((s) => ({
      ...s,
      filters: { ...s.filters, [title]: { ...filter, ...patch } },
    }));
  };
  const setQuery = (query: string) => updateFilter({ query });
  const setOnlyAbnormal = (onlyAbnormal: boolean) =>
    updateFilter({ onlyAbnormal });
  const setSort = (sort: string) => updateFilter({ sort });
  const setDevice = (device: string) => updateFilter({ device });
  const visible = kind
    ? exploreRows(values, kind, query, onlyAbnormal, sort, device)
    : values;
  const keys = monitoringRowKeys(visible);
  const devices = [
    ...new Set(values.map((r) => String(r.mountpoint ?? r.name ?? r.device))),
  ];
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>{title}</h2>
      </div>
      {kind && (
        <div className="toolbar monitoring-filters">
          <label>
            搜索
            <Input
              aria-label={`${title}搜索`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="名称、PID、状态或归属"
            />
          </label>
          {["disk", "network", "io"].includes(kind) && (
            <label>
              设备
              <NativeSelect
                aria-label={`${title}设备`}
                value={device}
                onChange={(e) => setDevice(e.target.value)}
              >
                <option value="">全部设备</option>
                {devices.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </NativeSelect>
            </label>
          )}
          <label>
            排序
            <NativeSelect
              aria-label={`${title}排序`}
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="">采样顺序</option>
              {columns
                .filter(
                  ([key]) =>
                    !["stats", "io", "options", "inspectError"].includes(key),
                )
                .flatMap(([key, label]) => [
                  <option key={`${key}:desc`} value={`${key}:desc`}>
                    {label} 降序
                  </option>,
                  <option key={`${key}:asc`} value={`${key}:asc`}>
                    {label} 升序
                  </option>,
                ])}
            </NativeSelect>
          </label>
          {["process", "service", "container", "disk"].includes(kind) && (
            <label>
              <Checkbox
                checked={onlyAbnormal}
                onChange={(e) => setOnlyAbnormal(e.target.checked)}
              />
              {kind === "process"
                ? "仅 CPU/内存 ≥80%"
                : kind === "container"
                  ? "仅异常或累计重启 ≥3"
                  : "仅异常"}
            </label>
          )}
          <span className="muted">
            {visible.length} / {values.length} 项（已采集范围）
          </span>
        </div>
      )}
      <QueryState
        loading={false}
        empty={!visible.length}
        emptyTitle={
          values.length
            ? "没有匹配记录"
            : legacy
              ? "此采样未包含该项数据"
              : "暂无记录"
        }
        emptyText={
          values.length
            ? "调整搜索、设备或异常筛选后重试。"
            : legacy
              ? "旧版采样仅包含部分指标；升级 Agent 后可获取详细数据。"
              : !snapshot
                ? "等待采样：尚未收到此类别的数据。"
                : snapshot.stale
                  ? "采样已过期，请检查 Agent 连接。"
                  : snapshot.errors.length
                    ? `本次采集存在失败：${snapshot.errors.join("；")}。${diagnosticAdvice(snapshot.errors, snapshot.truncated)}`
                    : "本次采样未返回记录；列表可能为空，首次 CPU 和速率需要两个连续样本。"
        }
        retry={() => {}}
      >
        <DataTable
          label={title}
          headers={[
            ...columns.map((c) => c[1]),
            ...(onHistory ? ["历史"] : []),
            ...(["process", "container", "service"].includes(kind ?? "")
              ? ["实例历史与关注"]
              : []),
          ]}
        >
          {visible.map((row, index) => (
            <tr key={keys[index]}>
              {columns.map(([key]) => (
                <td key={key}>
                  {(() => {
                    if (key === "device" && row[key] === "") return "整机";
                    if (key === "unit" && row[key] === "") return "无量纲";
                    if (key === "inspectError")
                      return row[key] ? text(row[key]) : "无";
                    const state = availability({
                      value: row[key],
                      snapshot,
                      legacy,
                      row,
                      field: key,
                    });
                    return row[key] === null ||
                      row[key] === undefined ||
                      row[key] === "" ||
                      row[key] === "none" ? (
                      <span title={state.reason}>
                        {availabilityLabels[state.state]}
                        {key === "value" && row.availability
                          ? ""
                          : ` · ${state.reason}`}
                      </span>
                    ) : (
                      text(row[key])
                    );
                  })()}
                </td>
              ))}
              {onHistory && (
                <td>
                  {rowHistory(row, kind) && (
                    <Button
                      variant="link"
                      onClick={() => onHistory(rowHistory(row, kind)!)}
                    >
                      查看历史
                    </Button>
                  )}
                </td>
              )}
              {["process", "container", "service"].includes(kind ?? "") && (
                <td>
                  <ObjectActions
                    row={row}
                    kind={kind as "process" | "container" | "service"}
                    supported={snapshot?.data.historyVersion === 1}
                  />
                </td>
              )}
            </tr>
          ))}
        </DataTable>
      </QueryState>
    </section>
  );
}
const metricChoices = [
  ["cpu.idle", "CPU 空闲"],
  ["memory.free", "空闲内存"],
  ["swap.used", "已用 Swap"],
  ["disk.percent", "磁盘使用率"],
  ["disk.used", "磁盘已用空间"],
  ["disk.free", "磁盘可用空间"],
  ["network.recv", "网络接收吞吐"],
  ["network.sent", "网络发送吞吐"],
  ["io.read", "磁盘读取吞吐"],
  ["io.write", "磁盘写入吞吐"],
  ["cpu.total", "CPU 总使用率"],
  ["cpu.user", "CPU 用户态"],
  ["cpu.system", "CPU 内核态"],
  ["cpu.iowait", "CPU IO 等待"],
  ["cpu.steal", "CPU Steal"],
  ["load.1", "1 分钟负载"],
  ["load.5", "5 分钟负载"],
  ["load.15", "15 分钟负载"],
  ["load.normalized", "归一化负载"],
  ["memory.percent", "内存使用率"],
  ["memory.used", "已用内存"],
  ["memory.available", "可用内存"],
  ["memory.cached", "缓存"],
  ["memory.buffers", "缓冲"],
  ["swap.percent", "Swap 使用率"],
  ["swap.in", "Swap 换入"],
  ["swap.out", "Swap 换出"],
  ["disk.inodePercent", "inode 使用率"],
  ["network.recvPackets", "网络接收包速率"],
  ["network.sentPackets", "网络发送包速率"],
  ["network.recvErrors", "网络接收错误"],
  ["network.sentErrors", "网络发送错误"],
  ["network.recvDrops", "网络接收丢包"],
  ["network.sentDrops", "网络发送丢包"],
  ["io.readIOPS", "读取 IOPS"],
  ["io.writeIOPS", "写入 IOPS"],
  ["io.readLatency", "读取延迟"],
  ["io.writeLatency", "写入延迟"],
  ["io.util", "IO 忙碌率"],
  ["io.queue", "IO 平均队列深度"],
];
export function NumericHistory({
  nodeId,
  selection,
  onSelectionChange,
}: {
  nodeId: string;
  selection?: HistorySelection;
  onSelectionChange?: (value: HistorySelection) => void;
}) {
  const [local, setLocal] = useState<HistorySelection>({
    metric: "cpu.total",
    device: undefined,
    hours: 1,
  });
  const current = selection ?? local;
  const { metric, device, hours } = current;
  const update = (patch: Partial<HistorySelection>) => {
    const next = { ...current, ...patch };
    setLocal(next);
    onSelectionChange?.(next);
  };
  const q = useQuery<{
    unit: string;
    bucketSeconds: number;
    devices: string[];
    device: string | null;
    series: {
      name: string;
      points: { recordedAt: string; value: number | null }[];
    }[];
  }>("nodes.history", { nodeId, kind: "metric", metric, hours, device }, 30000);
  return (
    <section className="panel">
      <div className="panel-header resource-history-controls">
        <h2>详细指标历史</h2>
        <NativeSelect
          aria-label="详细历史指标"
          value={metric}
          onChange={(e) => {
            update(changeHistoryMetric(current, e.target.value));
          }}
        >
          {metricChoices.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="详细历史范围"
          value={hours}
          onChange={(e) => update({ hours: Number(e.target.value) })}
        >
          {[1, 6, 24, 48, 168, 720, 8760].map((h) => (
            <option key={h} value={h}>
              {h} 小时
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="详细历史设备"
          value={device ?? q.data?.device ?? ""}
          onChange={(e) => update({ device: e.target.value })}
          disabled={!q.data?.devices.length}
        >
          {device !== undefined && !q.data?.devices.includes(device) && (
            <option value={device}>{device || "整机"}（此范围无采样）</option>
          )}
          {q.data?.devices.map((d) => (
            <option key={d} value={d}>
              {d || "整机"}
            </option>
          ))}
        </NativeSelect>
      </div>
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => void q.mutate()}
        empty={
          !q.data?.series.some((s) => s.points.some((p) => p.value !== null))
        }
        emptyText="所选指标或时间范围暂无有效采样；部分详细指标需要新版 Agent，首次速率需两个连续样本。"
      >
        {q.data && <ResourceChart data={q.data} />}
      </QueryState>
    </section>
  );
}
function LiveSummary({
  fast,
  disks,
  onHistory,
}: {
  fast?: SnapshotResult;
  disks?: SnapshotResult;
  onHistory: (target: Pick<HistorySelection, "metric" | "device">) => void;
}) {
  const workspace = useMonitoringWorkspace();
  const [local, setLocal] = useState({ mount: "", network: "", io: "" });
  const { mount, network, io } = workspace?.state.devices ?? local;
  const update = (patch: Partial<typeof local>) => {
    setLocal((s) => ({ ...s, ...patch }));
    workspace?.setState((s) => ({ ...s, devices: { ...s.devices, ...patch } }));
  };
  const setMount = (mount: string) => update({ mount });
  const setNetwork = (network: string) => update({ network });
  const setIO = (io: string) => update({ io });
  const f = fast?.categories[0],
    d = disks?.categories[0];
  const mounts = rows(disks?.payload.disk).map((r) => String(r.mountpoint));
  const networkNames = [
    ...new Set(
      f?.series
        .filter((p) => p.metric.startsWith("network."))
        .map((p) => p.device) ?? [],
    ),
  ];
  const ioNames = [
    ...new Set(
      f?.series
        .filter((p) => p.metric.startsWith("io."))
        .map((p) => p.device) ?? [],
    ),
  ];
  const chosenMount = mount || (mounts.includes("/") ? "/" : (mounts[0] ?? ""));
  const chosenNetwork = network || networkNames[0] || "",
    chosenIO = io || ioNames[0] || "";
  const cards: [string, string, string, Snapshot | undefined, string?][] = [
    ["CPU", "cpu.total", "", f],
    ["1 分钟负载", "load.1", "", f],
    ["内存", "memory.percent", "", f],
    ["Swap", "swap.percent", "", f],
    ["磁盘容量", "disk.percent", chosenMount, d],
    ["网络接收", "network.recv", chosenNetwork, f, "network.sent"],
    ["IO 读取", "io.read", chosenIO, f, "io.write"],
  ];
  return (
    <section aria-label="主要资源状态" className="monitoring-overview">
      <div className="toolbar monitoring-filters">
        <label>
          磁盘
          <NativeSelect
            aria-label="概览磁盘"
            value={chosenMount}
            onChange={(e) => setMount(e.target.value)}
          >
            {[...new Set([chosenMount, ...mounts])].map((n) => (
              <option key={n} value={n}>
                {n || "等待设备采样"}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          网卡
          <NativeSelect
            aria-label="概览网卡"
            value={chosenNetwork}
            onChange={(e) => setNetwork(e.target.value)}
          >
            {[...new Set([chosenNetwork, ...networkNames])].map((n) => (
              <option key={n} value={n}>
                {n || "等待设备采样"}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label>
          IO 设备
          <NativeSelect
            aria-label="概览 IO 设备"
            value={chosenIO}
            onChange={(e) => setIO(e.target.value)}
          >
            {[...new Set([chosenIO, ...ioNames])].map((n) => (
              <option key={n} value={n}>
                {n || "等待设备采样"}
              </option>
            ))}
          </NativeSelect>
        </label>
      </div>
      <div className="monitoring-summary-grid">
        {cards.map(([label, metric, device, s, secondary]) => {
          const point = s?.series.find(
            (p) => p.metric === metric && p.device === device,
          );
          const state = availability({
            value: point?.value,
            snapshot: s,
            legacy: metric.startsWith("disk.") ? disks?.legacy : fast?.legacy,
            row: point ?? { metric },
          });
          const value = point?.value;
          const warning =
            state.state === "ok" ? resourceWarning(metric, value, s) : null;
          const high = !!warning;
          const unavailable = state.state !== "ok";
          const other = s?.series.find(
            (p) => p.metric === secondary && p.device === device,
          );
          const otherState = availability({
            value: other?.value,
            snapshot: s,
            legacy: fast?.legacy,
            row: other ?? { metric: secondary },
          });
          const normalized = s?.series.find(
            (p) => p.metric === "load.normalized",
          )?.value;
          const pairAvailable =
            typeof value === "number" &&
            typeof other?.value === "number" &&
            otherState.state === "ok";
          const ringValue =
            metric === "load.1"
              ? normalized
              : secondary
                ? pairAvailable
                  ? value
                  : null
                : value;
          const centerValue = ringValueLabel(value, point?.unit);
          const ringTotal =
            secondary && pairAvailable ? value + other!.value! : 100;
          const meaning =
            metric === "load.1"
              ? `归一化负载 ${normalized == null ? "等待采样" : `${text(normalized)}%`}`
              : secondary
                ? pairAvailable && ringTotal === 0
                  ? metric.startsWith("network")
                    ? "当前无收发流量"
                    : "当前无读写 IO"
                  : metric.startsWith("network")
                    ? "接收 / 发送占比"
                    : "读取 / 写入占比"
                : "占用 / 总量";
          return (
            <section className="surface monitoring-summary-card" key={metric}>
              <span>
                {label}
                {device ? ` · ${device}` : ""}
              </span>
              <div className="monitoring-summary-visual">
                <RingChart
                  label={`${label}${device ? ` · ${device}` : ""}：${typeof value === "number" ? `${text(value)} ${point?.unit ?? ""}` : availabilityLabels[state.state]}；${meaning}；${warning ?? availabilityLabels[state.state]}`}
                  value={ringValue}
                  total={ringTotal}
                  composition={!!secondary}
                  muted={unavailable}
                  danger={high}
                >
                  <strong className={high ? "error-text" : ""}>
                    {centerValue?.value ?? availabilityLabels[state.state]}
                  </strong>
                  {typeof value === "number" && (
                    <small>{centerValue?.unit || "负载"}</small>
                  )}
                </RingChart>
                <span className="monitoring-ring-caption muted">{meaning}</span>
              </div>
              <small
                className={
                  high ||
                  ["failed", "permission_denied", "stale"].includes(state.state)
                    ? "error-text"
                    : "muted"
                }
              >
                {warning ?? availabilityLabels[state.state]}
                {unavailable ? ` · ${state.reason}` : ""}
              </small>
              {metric === "load.1" && (
                <small className="muted">
                  5 / 15 分钟：
                  {text(
                    s?.series.find((p) => p.metric === "load.5")?.value,
                  )} /{" "}
                  {text(s?.series.find((p) => p.metric === "load.15")?.value)}
                </small>
              )}
              {secondary && (
                <small
                  className={
                    ["failed", "permission_denied", "stale"].includes(
                      otherState.state,
                    )
                      ? "error-text"
                      : "muted"
                  }
                >
                  {metric.startsWith("network") ? "发送" : "写入"}：
                  {other?.value == null
                    ? `${availabilityLabels[otherState.state]} · ${otherState.reason}`
                    : `${text(other.value)} ${other.unit}`}
                </small>
              )}
              <Button
                variant="link"
                onClick={() => onHistory({ metric, device })}
                aria-label={`${label}${device}查看历史`}
              >
                查看历史
              </Button>
            </section>
          );
        })}
      </div>
    </section>
  );
}

export function NodeMonitoring({
  nodeId,
  view,
  historySelection,
  onHistorySelectionChange,
}: {
  nodeId: string;
  view: string;
  historySelection?: HistorySelection;
  onHistorySelectionChange?: (value: HistorySelection) => void;
}) {
  const workspace = useMonitoringWorkspace();
  const [showRaw, setShowRaw] = useState(false);
  const [localHistory, setLocalHistory] = useState<HistorySelection>({
    metric: "cpu.total",
    device: undefined,
    hours: 1,
  });
  const selectedHistory = {
    ...(historySelection ?? localHistory),
    hours: workspace?.state.hours ?? (historySelection ?? localHistory).hours,
  };
  const historyRef = useRef<HTMLElement>(null);
  const changeHistory = (value: HistorySelection) => {
    setLocalHistory(value);
    workspace?.setState((s) => ({ ...s, hours: value.hours }));
    onHistorySelectionChange?.(value);
  };
  const openHistory = (target: Pick<HistorySelection, "metric" | "device">) => {
    changeHistory({ ...selectedHistory, ...target });
    const family = target.metric.split(".")[0];
    if (target.device && ["disk", "network", "io"].includes(family))
      workspace?.setState((s) => ({
        ...s,
        devices: {
          ...s.devices,
          [family === "disk" ? "mount" : family]: target.device!,
        },
      }));
    historyRef.current?.focus();
    historyRef.current?.scrollIntoView({ block: "start" });
  };
  const category =
    view === "system"
      ? "static"
      : view === "processes" || view === "services"
        ? "details"
        : view === "resources"
          ? "disks"
          : view === "details"
            ? undefined
            : "fast";
  const q = useQuery<SnapshotResult>("nodes.snapshot", { nodeId, category });
  const fast = useQuery<SnapshotResult>(
    view === "resources" ? "nodes.snapshot" : null,
    { nodeId, category: "fast" },
  );
  const diskSummary = useQuery<SnapshotResult>(
    view === "live" ? "nodes.snapshot" : null,
    { nodeId, category: "disks" },
  );
  const detailSummary = useQuery<SnapshotResult>(
    view === "live" ? "nodes.snapshot" : null,
    { nodeId, category: "details" },
  );
  const allSummary = useQuery<SnapshotResult>(
    view === "live" ? "nodes.snapshot" : null,
    { nodeId },
  );
  const p = q.data?.payload ?? {},
    f = fast.data?.payload ?? {};
  const names: Record<string, string> = {
    total: "总量 B",
    available: "可用 B",
    used: "已用 B",
    free: "空闲 B",
    usedPercent: "使用率 %",
    cached: "缓存 B",
    buffers: "缓冲 B",
    sin: "累计换入 B",
    sout: "累计换出 B",
    hostname: "主机名",
    os: "操作系统",
    arch: "架构",
    agentVersion: "Agent 版本",
    platform: "发行版",
    platformVersion: "发行版版本",
    platformFamily: "系统家族",
    kernelVersion: "内核版本",
    kernelArch: "内核架构",
    uptime: "采样时运行时长（秒）",
    bootTime: "启动时间（Unix秒）",
    procs: "进程数量",
    virtualizationSystem: "虚拟化系统",
    virtualizationRole: "虚拟化角色",
    hostId: "主机标识",
  };
  const pairs = (value: unknown) =>
    Object.entries(object(value)).map(([name, value]) => ({
      name: names[name] ?? name,
      value,
    }));
  return (
    <div className="node-monitoring">
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => void q.mutate()}
      >
        {q.data?.legacy && (
          <section className="surface" role="status">
            <p>
              当前为旧版 Agent 采样，仅展示已上报的数据。CPU
              各核、负载、Swap、实时吞吐和详细系统信息需要升级节点上的 Agent。
            </p>
            <Button asChild variant="link">
              <Link href="/updates">前往版本更新</Link>
            </Button>
          </section>
        )}
        {view === "live" && (
          <LiveSummary
            fast={q.data}
            disks={diskSummary.data}
            onHistory={openHistory}
          />
        )}
        {workspace?.state.returnTab === view && (
          <ObjectHistory nodeId={nodeId} />
        )}
        {view !== "live" && (
          <section className="panel" aria-label="采集诊断">
            <div className="panel-header">
              <h2>采集诊断</h2>
            </div>
            <DataTable
              label="分类采集诊断"
              headers={[
                "类别",
                "状态",
                "最近采样",
                "最近完整成功",
                "耗时",
                "失败原因",
                "截断与处理建议",
                "诊断历史",
              ]}
            >
              {(view === "details"
                ? ["fast", "disks", "details", "static"]
                : [category ?? "fast"]
              ).map((name) => {
                const s =
                  q.data?.categories.find((v) => v.category === name) ??
                  (q.data?.legacy ? q.data.categories[0] : undefined);
                const state = !s
                  ? "等待采样"
                  : s.stale
                    ? "过期"
                    : s.errors.length
                      ? "部分采集失败"
                      : "正常";
                return (
                  <tr key={name}>
                    <th scope="row">
                      {{
                        fast: "实时指标",
                        disks: "文件系统",
                        details: "运行明细",
                        static: "系统信息",
                      }[name] ?? name}
                    </th>
                    <td>
                      {state}
                      {s?.cacheFallback ? " · 持久快照" : ""}
                    </td>
                    <td>{s ? date(s.sampledAt) : "等待采样"}</td>
                    <td>
                      {s?.lastSuccessAt
                        ? date(s.lastSuccessAt)
                        : s && !s.errors.length
                          ? date(s.sampledAt)
                          : "尚无成功记录"}
                    </td>
                    <td>{s ? `${s.durationMs.toFixed(1)} ms` : "等待采样"}</td>
                    <td>
                      {s?.errors.join("；") || (s ? "无" : "尚未收到采样")}
                    </td>
                    <td>
                      {s
                        ? diagnosticAdvice(s.errors, s.truncated)
                        : "检查 Agent 是否在线及采集配置"}
                    </td>
                    <td>
                      <ObjectActions
                        row={{ name, category: name }}
                        kind="diagnostics"
                        supported={!!s}
                      />
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          </section>
        )}
        {view === "live" && (
          <>
            <MonitoringDashboard
              nodeId={nodeId}
              fast={q.data}
              details={detailSummary.data}
              detailState={{
                loading: detailSummary.isLoading,
                error: detailSummary.error,
                retry: () => void detailSummary.mutate(),
              }}
              all={allSummary.data}
              network={
                workspace?.state.devices.network ||
                q.data?.categories[0]?.series.find(
                  (p) => p.metric === "network.recv",
                )?.device
              }
              io={
                workspace?.state.devices.io ||
                q.data?.categories[0]?.series.find(
                  (p) => p.metric === "io.readIOPS",
                )?.device
              }
              hours={selectedHistory.hours}
              onHistory={openHistory}
              onNavigate={workspace?.navigate ?? (() => {})}
            />
            <Button
              variant="outline"
              aria-expanded={showRaw}
              aria-controls="current-resource-samples"
              onClick={() => setShowRaw((v) => !v)}
            >
              {showRaw ? "收起" : "展开"}当前完整资源采样
            </Button>
            {showRaw && (
              <section
                id="current-resource-samples"
                className="node-monitoring"
              >
                <DetailTable
                  legacy={q.data?.legacy}
                  snapshot={q.data?.categories[0]}
                  onHistory={openHistory}
                  title="实时指标（单位见指标列）"
                  values={
                    q.data?.categories.flatMap((s) =>
                      hostMetricRows(s).map((v) => ({
                        ...v,
                        availability: (() => {
                          const a = availability({
                            value: v.value,
                            snapshot: s,
                            legacy: q.data?.legacy,
                            row: v,
                          });
                          return `${availabilityLabels[a.state]} · ${a.reason}`;
                        })(),
                        metric:
                          metricChoices.find((c) => c[0] === v.metric)?.[1] ??
                          v.metric,
                      })),
                    ) ?? []
                  }
                  columns={[
                    ["metric", "指标"],
                    ["device", "设备"],
                    ["value", "数值"],
                    ["unit", "单位"],
                    ["availability", "可用性与原因"],
                  ]}
                />
                <DetailTable
                  legacy={q.data?.legacy}
                  snapshot={q.data?.categories[0]}
                  title="CPU 各核"
                  values={rows(p.cpuCores)}
                  columns={[
                    ["name", "核心"],
                    ["percent", "使用率 %"],
                  ]}
                />
                <DetailTable
                  legacy={q.data?.legacy}
                  snapshot={q.data?.categories[0]}
                  title="内存（字节）"
                  values={pairs(p.memory)}
                  columns={[
                    ["name", "项目"],
                    ["value", "值"],
                  ]}
                />
                <DetailTable
                  legacy={q.data?.legacy}
                  snapshot={q.data?.categories[0]}
                  title="Swap（字节、百分比及累计换入换出）"
                  values={pairs(p.swap)}
                  columns={[
                    ["name", "项目"],
                    ["value", "值"],
                  ]}
                />
              </section>
            )}
            <section ref={historyRef} tabIndex={-1} aria-label="所选对象历史">
              <NumericHistory
                nodeId={nodeId}
                selection={selectedHistory}
                onSelectionChange={changeHistory}
              />
            </section>
          </>
        )}
        {view === "resources" && (
          <>
            <div className="monitoring-dashboard-grid">
              <MetricTrend
                nodeId={nodeId}
                metrics={[
                  ["network.recv", "接收"],
                  ["network.sent", "发送"],
                ]}
                device={workspace?.state.devices.network || undefined}
                hours={selectedHistory.hours}
                title="网络吞吐 · B/s"
                onHistory={openHistory}
              />
              <MetricTrend
                nodeId={nodeId}
                metrics={[
                  ["io.readIOPS", "读取"],
                  ["io.writeIOPS", "写入"],
                ]}
                device={workspace?.state.devices.io || undefined}
                hours={selectedHistory.hours}
                title="磁盘 IOPS"
                onHistory={openHistory}
              />
              <MetricTrend
                nodeId={nodeId}
                metrics={[
                  ["io.readLatency", "读取延迟"],
                  ["io.writeLatency", "写入延迟"],
                ]}
                device={workspace?.state.devices.io || undefined}
                hours={selectedHistory.hours}
                title="IO 延迟 · ms"
                onHistory={openHistory}
              />
              <MetricTrend
                nodeId={nodeId}
                metrics={[["io.queue", "队列深度"]]}
                device={workspace?.state.devices.io || undefined}
                hours={selectedHistory.hours}
                title="IO 平均队列深度"
                onHistory={openHistory}
              />
            </div>
            <DetailTable
              legacy={q.data?.legacy}
              snapshot={q.data?.categories[0]}
              kind="disk"
              onHistory={openHistory}
              title="文件系统容量与 inode"
              values={rows(p.disk).map((row) =>
                q.data?.legacy && !Object.hasOwn(row, "available")
                  ? { ...row, available: row.free, free: undefined }
                  : row,
              )}
              columns={[
                ["device", "设备"],
                ["mountpoint", "挂载点"],
                ["fstype", "类型"],
                ["total", "总量 B"],
                ["used", "已用 B"],
                ...(!q.data?.legacy
                  ? [["free", "空闲 B"] as [string, string]]
                  : []),
                ["available", "可用 B"],
                ["usedPercent", "使用率 %"],
                ["inodesTotal", "inode 总量"],
                ["inodesFree", "inode 剩余"],
                ["inodesUsedPercent", "inode 使用率 %"],
                ["options", "挂载选项"],
              ]}
            />
            <QueryState
              loading={fast.isLoading}
              error={fast.error}
              retry={() => void fast.mutate()}
            >
              <DetailTable
                legacy={fast.data?.legacy}
                snapshot={fast.data?.categories[0]}
                kind="network"
                onHistory={openHistory}
                title={
                  fast.data?.legacy
                    ? "网卡累计流量（速率见资源历史）"
                    : "网卡吞吐"
                }
                values={rows(fast.data?.legacy ? f.network : f.networkRates)}
                columns={
                  fast.data?.legacy
                    ? [
                        ["name", "网卡"],
                        ["bytesRecv", "累计接收 B"],
                        ["bytesSent", "累计发送 B"],
                        ["packetsRecv", "累计接收包数"],
                        ["packetsSent", "累计发送包数"],
                        ["errin", "累计接收错误"],
                        ["errout", "累计发送错误"],
                        ["dropin", "累计接收丢包"],
                        ["dropout", "累计发送丢包"],
                      ]
                    : [
                        ["name", "网卡"],
                        ["recvPerSecond", "接收 B/s"],
                        ["sentPerSecond", "发送 B/s"],
                        ["errorsIn", "累计接收错误"],
                        ["errorsOut", "累计发送错误"],
                        ["dropsIn", "累计接收丢包"],
                        ["dropsOut", "累计发送丢包"],
                      ]
                }
              />
              <DetailTable
                legacy={fast.data?.legacy}
                snapshot={fast.data?.categories[0]}
                kind="io"
                onHistory={openHistory}
                title={
                  fast.data?.legacy
                    ? "磁盘 IO 累计计数（速率见资源历史）"
                    : "磁盘 IO（多队列设备忙碌率不代表性能饱和度）"
                }
                values={
                  fast.data?.legacy
                    ? Object.entries(object(f.io)).map(([name, value]) => ({
                        ...object(value),
                        name,
                      }))
                    : rows(f.ioRates)
                }
                columns={
                  fast.data?.legacy
                    ? [
                        ["name", "设备"],
                        ["readBytes", "累计读取 B"],
                        ["writeBytes", "累计写入 B"],
                        ["readCount", "累计读取次数"],
                        ["writeCount", "累计写入次数"],
                        ["readTime", "累计读取耗时 ms"],
                        ["writeTime", "累计写入耗时 ms"],
                      ]
                    : [
                        ["name", "设备"],
                        ["readPerSecond", "读取 B/s"],
                        ["writePerSecond", "写入 B/s"],
                        ["readIOPS", "读取 IOPS"],
                        ["writeIOPS", "写入 IOPS"],
                        ["readLatency", "读延迟 ms"],
                        ["writeLatency", "写延迟 ms"],
                        ["utilPercent", "忙碌率 %"],
                        ["queueDepth", "队列深度"],
                      ]
                }
              />
            </QueryState>
            <ResourceHistory nodeId={nodeId} />
            <section ref={historyRef} tabIndex={-1} aria-label="所选对象历史">
              <NumericHistory
                nodeId={nodeId}
                selection={selectedHistory}
                onSelectionChange={changeHistory}
              />
            </section>
          </>
        )}
        {view === "processes" && (
          <>
            <ProcessRanking payload={p} />
            <ProcessWatches nodeId={nodeId} />
            {q.data?.legacy ? (
              <p className="muted">
                旧版采样仅提供有数量限制的进程列表，未按 CPU 排行。总进程{" "}
                {text(p.processCount)}，返回 {rows(p.processes).length} 项。
              </p>
            ) : (
              <p className="muted">
                CPU 百分比按单核计，多核进程可超过
                100%；首次采样等待基线。总进程 {text(p.processCount)}，成功采样{" "}
                {text(p.processSampled)}
                ，每榜最多 {text(p.processLimit)} 项。
              </p>
            )}
            <DetailTable
              legacy={q.data?.legacy}
              snapshot={q.data?.categories[0]}
              kind="process"
              title={q.data?.legacy ? "进程列表（旧版采样）" : "进程 CPU Top"}
              values={rows(p.processes)}
              columns={
                q.data?.legacy
                  ? [
                      ["pid", "PID"],
                      ["name", "名称"],
                      ["memoryPercent", "内存 %"],
                    ]
                  : [
                      ["pid", "PID"],
                      ["name", "名称"],
                      ["user", "用户"],
                      ["cpuPercent", "CPU %"],
                      ["rss", "RSS B"],
                      ["vms", "VMS B"],
                      ["memoryPercent", "内存 %"],
                      ["threads", "线程"],
                      ["status", "状态"],
                      ["io", "累计 IO"],
                    ]
              }
            />
            <DetailTable
              legacy={q.data?.legacy}
              snapshot={q.data?.categories[0]}
              kind="process"
              title="进程内存 Top"
              values={rows(p.memoryTop)}
              columns={[
                ["pid", "PID"],
                ["name", "名称"],
                ["rss", "RSS B"],
                ["memoryPercent", "内存 %"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
              snapshot={q.data?.categories[0]}
              title="进程状态分布（成功采样范围）"
              values={pairs(p.processStates)}
              columns={[
                ["name", "状态"],
                ["value", "数量"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
              snapshot={q.data?.categories[0]}
              title="连接状态（有界采样）"
              values={pairs(p.connections)}
              columns={[
                ["name", "状态"],
                ["value", "数量"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
              snapshot={q.data?.categories[0]}
              title="监听端口"
              values={rows(p.ports)}
              columns={[
                ["address", "地址"],
                ["port", "端口"],
                ["pid", "PID"],
                ["status", "状态"],
              ]}
            />
          </>
        )}
        {view === "services" && (
          <>
            <div className="monitoring-dashboard-objects">
              <ObjectDistribution payload={p} kind="service" />
              <ObjectDistribution payload={p} kind="container" />
            </div>
            <DetailTable
              legacy={q.data?.legacy}
              snapshot={q.data?.categories[0]}
              title="服务状态统计（已加载服务）"
              values={pairs(p.serviceStates)}
              columns={[
                ["name", "状态"],
                ["value", "数量"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
              snapshot={q.data?.categories[0]}
              title="容器状态统计"
              values={pairs(p.containerStates)}
              columns={[
                ["name", "状态"],
                ["value", "数量"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
              snapshot={q.data?.categories[0]}
              kind="service"
              title="systemd 服务"
              values={rows(p.services)}
              columns={[
                ["name", "服务"],
                ["active", "状态"],
                ["sub", "子状态"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
              snapshot={q.data?.categories[0]}
              kind="container"
              title="容器（统计字段保留 Docker 实际单位）"
              values={rows(p.containers)}
              columns={[
                ["name", "名称"],
                ["id", "实例 ID"],
                ["image", "镜像"],
                ["state", "状态"],
                ["health", "健康"],
                ["restartCount", "重启次数"],
                [
                  "composeProject",
                  q.data?.legacy ? "容器标签" : "Compose 项目",
                ],
                ["composeService", "Compose 服务"],
                ["inspectError", "详情采集错误"],
                ["stats", "CPU / 内存 / 网络 / IO"],
              ]}
            />
          </>
        )}
        {view === "system" && (
          <>
            <DetailTable
              legacy={q.data?.legacy}
              snapshot={q.data?.categories[0]}
              title="主机与系统信息"
              values={[
                ...pairs(
                  q.data?.legacy
                    ? {
                        hostname: p.hostname,
                        os: p.os,
                        arch: p.arch,
                        agentVersion: p.agentVersion,
                      }
                    : p.system,
                ),
                ...(!q.data?.legacy
                  ? [
                      { name: "逻辑核数", value: p.logicalCores },
                      { name: "物理核数", value: p.physicalCores },
                    ]
                  : []),
              ]}
              columns={[
                ["name", "项目"],
                ["value", "值"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
              snapshot={q.data?.categories[0]}
              title="CPU 硬件"
              values={rows(p.cpuInfo)}
              columns={[
                ["modelName", "型号"],
                ["vendorId", "厂商"],
                ["cores", "核心"],
                ["mhz", "MHz"],
                ["cacheSize", "缓存 KiB"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
              snapshot={q.data?.categories[0]}
              title="网络接口"
              values={rows(p.interfaces)}
              columns={[
                ["name", "名称"],
                ["mtu", "MTU"],
                ["hardwareAddr", "MAC"],
                ["flags", "链路标志"],
                ["addrs", "地址"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
              snapshot={q.data?.categories[0]}
              title="链路状态与速率（不可获取时显示暂无数据）"
              values={rows(p.links)}
              columns={[
                ["name", "网卡"],
                ["state", "状态"],
                ["speedMbps", "链路速率 Mbps"],
              ]}
            />
          </>
        )}
        {view === "details" && <JsonView data={q.data} />}
      </QueryState>
    </div>
  );
}
