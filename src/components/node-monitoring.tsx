"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery, QueryState, DataTable, JsonView } from "./shared";
import { Button } from "./ui/button";
import { NativeSelect } from "./ui/native-select";
import { ResourceChart, ResourceHistory } from "./resource-history";
import { date } from "@/lib/client";
import type { Snapshot } from "@/lib/telemetry";
import { monitoringRowKeys } from "@/lib/monitoring-rows";
type Row = Record<string, unknown>;
type SnapshotResult = {
  categories: (Snapshot & { stale: boolean })[];
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
}: {
  title: string;
  values: Row[];
  columns: [string, string][];
  legacy?: boolean;
}) {
  const keys = monitoringRowKeys(values);
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>{title}</h2>
      </div>
      <QueryState
        loading={false}
        empty={!values.length}
        emptyTitle={legacy ? "此采样未包含该项数据" : "暂无记录"}
        emptyText={
          legacy
            ? "旧版采样仅包含部分指标；升级 Agent 后可获取详细数据。"
            : "等待采样；检查上方采集状态，首次速率需要两个连续样本。"
        }
        retry={() => {}}
      >
        <DataTable label={title} headers={columns.map((c) => c[1])}>
          {values.map((row, index) => (
            <tr key={keys[index]}>
              {columns.map(([key]) => (
                <td key={key}>{text(row[key])}</td>
              ))}
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
export function NumericHistory({ nodeId }: { nodeId: string }) {
  const [metric, setMetric] = useState("cpu.total"),
    [hours, setHours] = useState(1),
    [device, setDevice] = useState<string>();
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
            setMetric(e.target.value);
            setDevice(undefined);
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
          onChange={(e) => setHours(Number(e.target.value))}
        >
          {[1, 6, 24, 48, 168, 720, 8760].map((h) => (
            <option key={h} value={h}>
              {h} 小时
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="详细历史设备"
          value={q.data?.device ?? ""}
          onChange={(e) => setDevice(e.target.value)}
          disabled={!q.data?.devices.length}
        >
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
export function NodeMonitoring({
  nodeId,
  view,
}: {
  nodeId: string;
  view: string;
}) {
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
        {q.data?.categories.map((s) => (
          <section className="surface" key={s.category}>
            <p>
              {
                {
                  fast: "实时指标",
                  disks: "文件系统",
                  details: "运行明细",
                  static: "系统信息",
                  legacy: "旧版采样",
                }[s.category]
              }{" "}
              · 采样 {date(s.sampledAt)} · 接收 {date(s.receivedAt)} · 耗时{" "}
              {s.durationMs.toFixed(1)} ms · {s.stale ? "数据过期" : "最近采样"}
              {s.truncated ? " · 已达采集数量上限" : ""}
            </p>
            {s.errors.length > 0 && (
              <p role="status" className="muted">
                部分指标不可用：{s.errors.join("；")}
              </p>
            )}
          </section>
        ))}
        {view === "live" && (
          <>
            <DetailTable
              legacy={q.data?.legacy}
              title="实时指标（单位见指标列）"
              values={
                q.data?.categories.flatMap((s) =>
                  s.series
                    .filter((v) => !v.device)
                    .map((v) => ({
                      ...v,
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
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
              title="CPU 各核"
              values={rows(p.cpuCores)}
              columns={[
                ["name", "核心"],
                ["percent", "使用率 %"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
              title="内存（字节）"
              values={pairs(p.memory)}
              columns={[
                ["name", "项目"],
                ["value", "值"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
              title="Swap（字节、百分比及累计换入换出）"
              values={pairs(p.swap)}
              columns={[
                ["name", "项目"],
                ["value", "值"],
              ]}
            />
            <NumericHistory nodeId={nodeId} />
          </>
        )}
        {view === "resources" && (
          <>
            <DetailTable
              legacy={q.data?.legacy}
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
            <NumericHistory nodeId={nodeId} />
          </>
        )}
        {view === "processes" && (
          <>
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
              title="进程状态分布（成功采样范围）"
              values={pairs(p.processStates)}
              columns={[
                ["name", "状态"],
                ["value", "数量"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
              title="连接状态（有界采样）"
              values={pairs(p.connections)}
              columns={[
                ["name", "状态"],
                ["value", "数量"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
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
            <DetailTable
              legacy={q.data?.legacy}
              title="服务状态统计（已加载服务）"
              values={pairs(p.serviceStates)}
              columns={[
                ["name", "状态"],
                ["value", "数量"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
              title="容器状态统计"
              values={pairs(p.containerStates)}
              columns={[
                ["name", "状态"],
                ["value", "数量"],
              ]}
            />
            <DetailTable
              legacy={q.data?.legacy}
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
                ["stats", "CPU / 内存 / 网络 / IO"],
              ]}
            />
          </>
        )}
        {view === "system" && (
          <>
            <DetailTable
              legacy={q.data?.legacy}
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
