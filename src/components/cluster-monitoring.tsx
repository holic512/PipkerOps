/**
 * @file cluster-monitoring.tsx
 * @project PipkerOps
 * @module cluster-overview
 * @description 集群总览的节点异常、采样状态和资源排行。
 * @logic 按实际数值排序，缺采样置后；格式化展示值，异常明细按需展开。
 * @dependencies cluster monitoring projection, SWR, shared UI
 * @index_tags cluster, ranking, telemetry, ui
 * @author holic512
 */
"use client";
import {
  clusterTarget,
  type clusterProjection,
} from "@/lib/cluster-monitoring";
import { activeContainerMetric } from "@/lib/container-monitoring";
import { useState } from "react";
import type { SWRResponse } from "swr";
import Link from "next/link";
import { ArrowDown, ChevronDown } from "lucide-react";
import { DataTable, QueryState } from "./shared";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { date, percent } from "@/lib/client";

export type ClusterNodeHealth = ReturnType<typeof clusterProjection>;

const metrics = [
  { key: "cpuPercent", label: "CPU", percent: true },
  { key: "memoryPercent", label: "内存", percent: true },
  { key: "diskPercent", label: "磁盘最高", percent: true },
  { key: "inodePercent", label: "inode 最高", percent: true },
  { key: "serviceFailure", label: "失败服务", percent: false },
  { key: activeContainerMetric, label: "当前异常容器", percent: false },
] as const;

export function ClusterMonitoring({
  monitoring,
}: {
  monitoring: SWRResponse<ClusterNodeHealth[]>;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<string>("cpuPercent");
  const search = query.trim().toLowerCase();
  const rows = monitoring.data ?? [];
  const visible = rows
    .filter(
      (row) =>
        (!search ||
          [row.name, ...row.labels, ...row.reasons]
            .join(" ")
            .toLowerCase()
            .includes(search)) &&
        (filter === "all" ||
          (filter === "abnormal" && row.reasons.length > 0) ||
          (filter === "missing" && row.longMissing) ||
          (filter === "offline" && !row.connected)),
    )
    .sort((a, b) => {
      const x = metricValue(a, sort);
      const y = metricValue(b, sort);
      if (x === null) return y === null ? 0 : 1;
      return y === null ? -1 : y - x;
    });
  return (
    <section
      className="panel cluster-ranking"
      aria-labelledby="cluster-ranking-title"
    >
      <div className="panel-header">
        <h2 id="cluster-ranking-title">集群异常与资源排行</h2>
        {monitoring.data && (
          <span className="cluster-result-count muted" aria-live="polite">
            {visible.length === rows.length
              ? `${rows.length} 个节点`
              : `显示 ${visible.length} / ${rows.length} 个节点`}
          </span>
        )}
      </div>
      <div className="cluster-rank-filters">
        <label>
          搜索节点
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="名称、标签或异常"
          />
        </label>
        <label>
          状态
          <NativeSelect
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">全部节点</option>
            <option value="abnormal">存在异常</option>
            <option value="missing">超过 5 分钟或从未采样</option>
            <option value="offline">节点离线</option>
          </NativeSelect>
        </label>
        <label>
          排序
          <NativeSelect value={sort} onChange={(e) => setSort(e.target.value)}>
            {metrics.map(({ key, label }) => (
              <option key={key} value={key}>
                {label} 降序
              </option>
            ))}
          </NativeSelect>
        </label>
        <span className="muted">缺失值排在最后</span>
      </div>
      <QueryState
        loading={monitoring.isLoading}
        error={monitoring.error}
        retry={() => void monitoring.mutate()}
        empty={!visible.length}
        emptyTitle={rows.length ? "没有匹配节点" : "暂无节点"}
        emptyText={
          rows.length
            ? "试试其他关键词或状态。"
            : "接入节点后，这里会显示资源采样和异常。"
        }
      >
        <DataTable
          label="集群监控排行"
          className="cluster-rank-table"
          headers={[
            "节点",
            "异常提示",
            ...metrics.map(({ key, label }) => (
              <span
                className="cluster-rank-column"
                data-sorted={key === sort}
                key={key}
              >
                {label}
                {key === sort && (
                  <>
                    <ArrowDown size={12} aria-hidden="true" />
                    <span className="sr-only">降序</span>
                  </>
                )}
              </span>
            )),
            "最近资源采样",
          ]}
        >
          {visible.map((row) => (
            <ClusterRankRow key={row.id} row={row} sort={sort} />
          ))}
        </DataTable>
      </QueryState>
    </section>
  );
}

function ClusterRankRow({
  row,
  sort,
}: {
  row: ClusterNodeHealth;
  sort: string;
}) {
  const reasons = row.reasons.map(formatContext);
  const issueLabel = `${!row.connected ? "离线 · " : row.longMissing ? "缺采样 · " : ""}${reasons.length} 项提示`;
  const params = new URLSearchParams({
    monitor: clusterTarget(row, sort),
    context: reasons.join("；").slice(0, 1000) || "资源排行",
  });
  return (
    <tr>
      <th scope="row">
        <Button asChild variant="link">
          <Link href={`/nodes/${encodeURIComponent(row.id)}?${params}`}>
            {row.name}
          </Link>
        </Button>
      </th>
      <td>
        {reasons.length ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                aria-label={`${row.name}：${issueLabel}`}
              >
                {issueLabel} <ChevronDown size={13} />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="cluster-rank-notes"
              aria-label={`${row.name}的异常提示`}
            >
              <strong>{row.name}</strong>
              <ul>
                {reasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        ) : (
          <span className="muted">未观察到异常</span>
        )}
      </td>
      {metrics.map(({ key, percent: isPercent }) => {
        const observation = row.observations[key];
        const value = metricValue(row, key);
        const detail =
          observation &&
          [
            formatContext(observation.context),
            observation.observedAt !== undefined &&
              `采样于 ${date(new Date(observation.observedAt).toISOString())}`,
          ]
            .filter(Boolean)
            .join("\n");
        return (
          <td key={key} title={detail}>
            {value === null ? (
              <span className="muted">
                {key === "cpuPercent" || key === "memoryPercent"
                  ? "暂无采样"
                  : "待确认"}
              </span>
            ) : (
              <>
                {isPercent ? percent(value) : value}
                {observation?.complete === false && <small>覆盖不完整</small>}
              </>
            )}
          </td>
        );
      })}
      <td>
        {row.lastSampleAt ? (
          <>
            <time dateTime={row.lastSampleAt}>{date(row.lastSampleAt)}</time>
            {row.longMissing && <small>超过 5 分钟未更新</small>}
          </>
        ) : (
          <span className="muted">从未采样</span>
        )}
      </td>
    </tr>
  );
}

function metricValue(row: ClusterNodeHealth, key: string) {
  return key === "cpuPercent" || key === "memoryPercent"
    ? row[key]
    : (row.observations[key]?.value ?? null);
}

function formatContext(context: string) {
  // 磁盘采样诊断同时用于告警；总览仅格式化末尾的显示值，原始采样与上下文保持不变。
  return context.replace(
    /^(挂载点 .*：)(\d+(?:\.\d+)?(?:e-\d+)?)%$/i,
    (_, label: string, value: string) => `${label}${percent(Number(value))}`,
  );
}
