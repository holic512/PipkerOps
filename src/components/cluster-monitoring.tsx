"use client";
import { clusterTarget } from "@/lib/cluster-monitoring";
import { useState } from "react";
import Link from "next/link";
import { DataTable, QueryState, useQuery } from "./shared";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Button } from "./ui/button";
import { date, percent } from "@/lib/client";
import type { MonitoringObservation } from "@/lib/monitoring-alerts";
type NodeHealth = {
  id: string;
  name: string;
  labels: string[];
  connected: boolean;
  lastSampleAt: string | null;
  longMissing: boolean;
  cpuPercent: number | null;
  memoryPercent: number | null;
  observations: Record<string, MonitoringObservation>;
  reasons: string[];
};
export function ClusterMonitoring() {
  const q = useQuery<NodeHealth[]>("nodes.monitoring");
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [sort, setSort] = useState("cpuPercent");
  const value = (r: NodeHealth, key: string) =>
    key === "cpuPercent" || key === "memoryPercent"
      ? r[key]
      : (r.observations[key]?.value ?? null);
  const visible = (q.data ?? [])
    .filter(
      (r) =>
        (!query ||
          [r.name, ...r.labels, ...r.reasons]
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase())) &&
        (filter === "all" ||
          (filter === "abnormal" && r.reasons.length > 0) ||
          (filter === "missing" && r.longMissing) ||
          (filter === "offline" && !r.connected)),
    )
    .sort((a, b) => {
      const x = value(a, sort),
        y = value(b, sort);
      return x === null ? (y === null ? 0 : 1) : y === null ? -1 : y - x;
    });
  return (
    <section className="panel" aria-label="集群异常与资源排行">
      <div className="panel-header">
        <h2>集群异常与资源排行</h2>
      </div>
      <div className="toolbar monitoring-filters">
        <label>
          搜索
          <Input
            aria-label="集群异常搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="节点、标签或异常"
          />
        </label>
        <label>
          状态
          <NativeSelect
            aria-label="集群异常状态"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">全部节点</option>
            <option value="abnormal">存在异常</option>
            <option value="missing">超过 5 分钟无采样 / 从未采样</option>
            <option value="offline">节点离线</option>
          </NativeSelect>
        </label>
        <label>
          资源排行
          <NativeSelect
            aria-label="集群资源排行"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            {[
              ["cpuPercent", "CPU"],
              ["memoryPercent", "内存"],
              ["diskPercent", "磁盘容量"],
              ["inodePercent", "inode"],
              ["serviceFailure", "失败服务数"],
              ["containerFailure", "异常容器数"],
            ].map(([k, label]) => (
              <option key={k} value={k}>
                {label} 降序
              </option>
            ))}
          </NativeSelect>
        </label>
        <span className="muted">
          {visible.length} / {q.data?.length ?? 0} 节点；缺采样不参与数值排行
        </span>
      </div>
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => void q.mutate()}
        empty={!visible.length}
        emptyTitle="没有匹配节点"
        emptyText="调整筛选或先接入节点。"
      >
        <DataTable
          label="集群监控排行"
          headers={[
            "节点",
            "CPU %",
            "内存 %",
            "磁盘最高 %",
            "inode 最高 %",
            "失败服务",
            "异常容器",
            "最近资源采样",
            "异常上下文",
            "定位",
          ]}
        >
          {visible.map((r) => (
            <tr key={r.id}>
              <th scope="row">{r.name}</th>
              <td>{percent(r.cpuPercent)}</td>
              <td>{percent(r.memoryPercent)}</td>
              {[
                "diskPercent",
                "inodePercent",
                "serviceFailure",
                "containerFailure",
              ].map((k) => (
                <td key={k} title={r.observations[k]?.context}>
                  {value(r, k) ?? "无法确认"}
                  {r.observations[k]?.complete === false && value(r, k) !== null
                    ? "（部分采集）"
                    : ""}
                </td>
              ))}
              <td>{date(r.lastSampleAt)}</td>
              <td className={r.reasons.length ? "error-text" : "muted"}>
                {r.reasons.join("；") || "未观察到异常"}
              </td>
              <td>
                <Button asChild variant="link">
                  <Link
                    href={`/nodes/${encodeURIComponent(r.id)}?monitor=${clusterTarget(r, sort)}&context=${encodeURIComponent(r.reasons.join("；").slice(0, 1000) || "资源排行")}`}
                  >
                    定位节点
                  </Link>
                </Button>
              </td>
            </tr>
          ))}
        </DataTable>
      </QueryState>
    </section>
  );
}
