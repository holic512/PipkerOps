"use client";

import type { ComponentProps, ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import { ringSegments } from "@/lib/ring-chart";

/** Local shadcn-style composition using the installed Recharts library. */
export function ChartContainer({
  children,
  className,
  ...props
}: ComponentProps<"div"> & {
  children: ComponentProps<typeof ResponsiveContainer>["children"];
}) {
  return (
    <div
      data-slot="chart"
      className={cn("chart-container", className)}
      {...props}
    >
      <ResponsiveContainer
        width="100%"
        height="100%"
        minWidth={0}
        initialDimension={{ width: 144, height: 144 }}
      >
        {children}
      </ResponsiveContainer>
    </div>
  );
}

export type TrendSeries = {
  name: string;
  points: { recordedAt: string; value: number | null }[];
};

/** Compact per-core meters; partial segments retain small nonzero readings. */
export function CoreUsageChart({
  cores,
  stale = false,
}: {
  cores: { name: string; value: number | null }[];
  stale?: boolean;
}) {
  return (
    <div
      className="core-usage-chart"
      role="region"
      tabIndex={0}
      aria-label="CPU 各核当前使用率"
    >
      {cores.map((core) => {
        const value =
          typeof core.value === "number" &&
          Number.isFinite(core.value) &&
          core.value >= 0
            ? core.value
            : null;
        const usable = !stale && value !== null;
        const percent = usable ? Math.min(100, value) : 0;
        const label = stale
          ? "已过期"
          : value === null
            ? "等待基线"
            : `${value.toFixed(1)}%`;
        return (
          <div
            className="core-usage-row"
            key={core.name}
            data-level={
              !usable
                ? "unknown"
                : percent >= 85
                  ? "high"
                  : percent >= 50
                    ? "medium"
                    : "normal"
            }
          >
            <span className="core-usage-name">{core.name}</span>
            <div
              className="core-usage-track"
              role="img"
              aria-label={`${core.name}：${label}`}
            >
              {Array.from({ length: 40 }, (_, i) => (
                <span key={i} className="core-usage-segment" aria-hidden="true">
                  <span
                    style={{
                      width: `${Math.max(0, Math.min(1, percent / 2.5 - i)) * 100}%`,
                    }}
                  />
                </span>
              ))}
            </div>
            <strong className="core-usage-value">{label}</strong>
          </div>
        );
      })}
    </div>
  );
}

/** Each chart has one unit. Null samples deliberately break the path. */
export function TrendChart({
  series,
  unit,
  label,
}: {
  series: TrendSeries[];
  unit: string;
  label: string;
}) {
  const times = [
    ...new Set(series.flatMap((s) => s.points.map((p) => p.recordedAt))),
  ].sort();
  const indexes = series.map(
    (s) => new Map(s.points.map((p) => [p.recordedAt, p.value])),
  );
  const data = times.map((time) => ({
    time,
    ...Object.fromEntries(
      indexes.map((m, i) => [`v${i}`, m.get(time) ?? null]),
    ),
  }));
  return (
    <ChartContainer
      className="monitoring-trend"
      aria-label={`${label}，单位 ${unit}，空值保留缺口`}
    >
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis
          dataKey="time"
          tickFormatter={(v: string) =>
            new Date(v).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            })
          }
          minTickGap={36}
        />
        <YAxis
          width={58}
          tickFormatter={(v: number) => `${Number(v.toPrecision(3))}`}
        />
        <Tooltip
          contentStyle={{
            background: "var(--card)",
            borderColor: "var(--border)",
            color: "var(--foreground)",
            borderRadius: "var(--radius-md)",
          }}
          labelFormatter={(v) => new Date(String(v)).toLocaleString("zh-CN")}
          formatter={(v, name) => [`${v ?? "缺口"} ${unit}`, name]}
        />
        <Legend />
        {series.map((s, i) => (
          <Area
            key={s.name}
            dataKey={`v${i}`}
            name={s.name}
            type="linear"
            strokeLinecap="round"
            strokeLinejoin="round"
            stroke={`var(--chart-${(i % 2) + 1})`}
            fill={`var(--chart-${(i % 2) + 1})`}
            fillOpacity={0.1}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}

export type StateSlice = {
  name: string;
  value: number;
  tone: "normal" | "danger" | "warning" | "muted" | "unknown";
};
const stateFills = {
  normal: "var(--chart-1)",
  danger: "var(--danger-solid)",
  warning: "var(--warning)",
  muted: "var(--muted-foreground)",
  unknown: "var(--border)",
};
export function StateDonut({
  slices,
  label,
}: {
  slices: StateSlice[];
  label: string;
}) {
  const total = slices.reduce((n, s) => n + s.value, 0);
  const data = total
    ? slices.map((s) => ({ ...s, fill: stateFills[s.tone] }))
    : [{ name: "未覆盖", value: 1, fill: "var(--border)" }];
  return (
    <div className="monitoring-state-distribution">
      <div
        className="ring-chart"
        role="img"
        aria-label={`${label}：${slices.map((s) => `${s.name} ${s.value}`).join("，") || "暂无采样"}`}
      >
        <ChartContainer aria-hidden="true" inert>
          <PieChart accessibilityLayer={false}>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="72%"
              cornerRadius={6}
              outerRadius="94%"
              stroke="none"
              isAnimationActive={false}
            />
          </PieChart>
        </ChartContainer>
        <div className="ring-chart-center">
          <strong>{total}</strong>
          <small>已覆盖对象</small>
        </div>
      </div>
      <ul className="monitoring-state-legend">
        {slices.map((s) => (
          <li key={s.name} data-tone={s.tone}>
            <span>{s.name}</span>
            <strong>{s.value}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RankChart({
  data,
  unit,
  label,
}: {
  data: { name: string; value: number }[];
  unit: string;
  label: string;
}) {
  return (
    <ChartContainer
      className="monitoring-rank"
      aria-label={`${label}，单位 ${unit}，CPU 可超过100%`}
    >
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 24 }}>
        <XAxis type="number" domain={[0, "auto"]} unit={unit} />
        <YAxis
          type="category"
          dataKey="name"
          width={112}
          tick={{ fontSize: 11 }}
        />
        <Tooltip
          contentStyle={{
            background: "var(--card)",
            borderColor: "var(--border)",
            borderRadius: "var(--radius-md)",
          }}
          formatter={(v) => [`${v} ${unit}`, label]}
        />
        <Bar
          dataKey="value"
          name={label}
          fill="var(--chart-1)"
          radius={[0, 6, 6, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  );
}

export function RingChart({
  label,
  value,
  total = 100,
  composition = false,
  muted = false,
  danger = false,
  children,
}: {
  label: string;
  value: number | null | undefined;
  total?: number;
  composition?: boolean;
  muted?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  const ring = ringSegments(muted ? null : value, total);
  const fraction = ring.fraction;
  const data =
    fraction === null
      ? [{ value: 1, fill: "var(--border)" }]
      : [
          {
            value: fraction,
            fill: danger ? "var(--danger-solid)" : "var(--chart-1)",
          },
          {
            value: 1 - fraction,
            fill: composition ? "var(--chart-2)" : "var(--border)",
          },
        ];
  return (
    <div
      className="ring-chart"
      role="img"
      aria-label={label}
      data-state={ring.state}
    >
      <ChartContainer aria-hidden="true" inert>
        <PieChart accessibilityLayer={false}>
          <Pie
            data={data}
            dataKey="value"
            innerRadius="76%"
            cornerRadius={6}
            outerRadius="94%"
            startAngle={90}
            endAngle={-270}
            stroke="none"
            isAnimationActive={false}
          />
        </PieChart>
      </ChartContainer>
      <div className="ring-chart-center" aria-hidden="true">
        {children}
      </div>
    </div>
  );
}
