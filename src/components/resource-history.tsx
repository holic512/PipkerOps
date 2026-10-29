/**
 * @file resource-history.tsx
 * @project PipkerOps
 * @module node-resource-history-ui
 * @description 节点磁盘容量、网络和磁盘IO真实历史的设备选择与可读图表。
 * @logic 切换指标重选设备；查询状态显式展示；按真实时间作图，断点不连线。
 * @dependencies React, shared API query states, nodes.history
 * @index_tags nodes, metrics, history, ui
 * @author holic512
 */
"use client";
import { useState } from "react";
import { date } from "@/lib/client";
import { QueryState, useQuery } from "./shared";

type History = {
  unit: string;
  bucketSeconds: number;
  devices: string[];
  device: string | null;
  series: {
    name: string;
    points: { recordedAt: string; value: number | null }[];
  }[];
};
const colors = ["#1664df", "#0e8a70"];
const valueLabel = (n: number, unit: string) => {
  if (unit === "%") return `${n.toFixed(1)}%`;
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 ** 3).toFixed(1)} GiB/s`;
  if (n >= 1024 * 1024) return `${(n / 1024 ** 2).toFixed(1)} MiB/s`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB/s`;
  return `${n.toFixed(1)} B/s`;
};
export function ResourceHistory({ nodeId }: { nodeId: string }) {
  const [kind, setKind] = useState("disk");
  const [hours, setHours] = useState(1);
  const [device, setDevice] = useState<string>();
  const q = useQuery<History>(
    "nodes.history",
    { nodeId, kind, hours, device },
    30000,
  );
  const data = q.data;
  return (
    <section className="panel">
      <div className="panel-header resource-history-controls">
        <h2>资源历史</h2>
        <select
          aria-label="历史指标"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setDevice(undefined);
          }}
        >
          <option value="disk">磁盘使用率</option>
          <option value="network">网络流量</option>
          <option value="io">磁盘 IO</option>
        </select>
        <select
          aria-label="资源历史时间范围"
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
        >
          {[1, 6, 24, 48].map((h) => (
            <option key={h} value={h}>
              最近{h}小时
            </option>
          ))}
        </select>
        <select
          aria-label="历史指标设备"
          disabled={!data?.devices.length}
          value={data?.device ?? ""}
          onChange={(e) => setDevice(e.target.value)}
        >
          {!data?.device && (
            <option value="">
              {data?.devices.length ? "请选择设备" : "暂无设备"}
            </option>
          )}
          {data?.devices.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <QueryState
        error={q.error}
        loading={q.isLoading}
        retry={() => void q.mutate()}
        empty={
          !data?.series.some((s) => s.points.some((p) => p.value !== null))
        }
        emptyTitle="暂无可用资源历史"
        emptyText="选择其他设备或时间范围。网络和 IO 速率至少需要两次连续采样。"
      >
        {data && <ResourceChart data={data} />}
      </QueryState>
    </section>
  );
}
function ResourceChart({ data }: { data: History }) {
  const all = data.series.flatMap((s) => s.points);
  const times = all.map((p) => new Date(p.recordedAt).getTime());
  const start = Math.min(...times),
    end = Math.max(...times);
  const max =
    data.unit === "%"
      ? 100
      : Math.max(1, ...all.map((p) => p.value ?? 0)) * 1.1;
  const x = (time: string) =>
    90 +
    ((new Date(time).getTime() - start) / Math.max(end - start, 1000)) * 860;
  const y = (value: number) => 220 - (value / max) * 180;
  return (
    <div className="history-chart">
      <div className="chart-legend resource-history-legend">
        {data.series.map((s, i) => {
          const latest = s.points.at(-1);
          return (
            <span key={s.name}>
              <i style={{ background: colors[i % colors.length] }} />
              {s.name}{" "}
              {latest?.value == null
                ? "暂无速率"
                : valueLabel(latest.value, data.unit)}
            </span>
          );
        })}
        <span className="muted">
          {data.bucketSeconds}秒均值 · 缺口表示采样中断或计数重置
        </span>
      </div>
      <div
        className="resource-chart-scroll"
        role="region"
        aria-label="资源历史图表，可横向滚动"
        tabIndex={0}
      >
        <svg
          viewBox="0 0 1000 270"
          role="img"
          aria-label={`${data.device}资源历史折线图`}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <g key={ratio}>
              <line
                x1="90"
                x2="950"
                y1={y(max * ratio)}
                y2={y(max * ratio)}
                stroke="#e5eaf0"
              />
              <text
                x="80"
                y={y(max * ratio) + 4}
                textAnchor="end"
                fontSize="11"
                fill="#526173"
              >
                {valueLabel(max * ratio, data.unit)}
              </text>
            </g>
          ))}
          {data.series.map((s, i) => {
            let previous: number | undefined;
            const path = s.points
              .map((p) => {
                const time = new Date(p.recordedAt).getTime();
                if (p.value === null) {
                  previous = undefined;
                  return "";
                }
                const move =
                  previous === undefined ||
                  time - previous >
                    Math.max(120, data.bucketSeconds * 2) * 1000;
                previous = time;
                return `${move ? "M" : "L"}${x(p.recordedAt)},${y(p.value)}`;
              })
              .join(" ");
            return (
              <g key={s.name}>
                <path
                  d={path}
                  fill="none"
                  stroke={colors[i % colors.length]}
                  strokeWidth="2"
                />
                {s.points
                  .filter((p) => p.value !== null)
                  .map((p) => (
                    <circle
                      key={p.recordedAt}
                      cx={x(p.recordedAt)}
                      cy={y(p.value!)}
                      r="2"
                      fill={colors[i % colors.length]}
                    >
                      <title>
                        {date(p.recordedAt)} · {s.name}{" "}
                        {valueLabel(p.value!, data.unit)}
                      </title>
                    </circle>
                  ))}
              </g>
            );
          })}
          <text x="90" y="255" fontSize="12" fill="#526173">
            {date(new Date(start).toISOString())}
          </text>
          <text x="950" y="255" textAnchor="end" fontSize="12" fill="#526173">
            {date(new Date(end).toISOString())}
          </text>
        </svg>
      </div>
      <details className="resource-history-values">
        <summary>查看最近采样值</summary>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>指标</th>
                <th>均值</th>
              </tr>
            </thead>
            <tbody>
              {data.series.flatMap((s) =>
                s.points.slice(-10).map((p) => (
                  <tr key={`${s.name}-${p.recordedAt}`}>
                    <td>{date(p.recordedAt)}</td>
                    <td>{s.name}</td>
                    <td>
                      {p.value === null
                        ? "采样中断 / 计数重置"
                        : valueLabel(p.value, data.unit)}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
