import { CoreUsageChart, RankChart, StateDonut, TrendChart, type StateSlice, type TrendSeries } from "@/components/ui/chart";

/** Business callers supply measured values, units and explicit null gaps. */
export function MonitoringChartsExample({ trends, ranks, states, unit }: { trends: TrendSeries[]; ranks: { name: string; value: number }[]; states: StateSlice[]; unit: string }) {
  return <><TrendChart series={trends} unit={unit} label="资源趋势" /><RankChart data={ranks} unit="%" label="进程 CPU" /><StateDonut slices={states} label="已覆盖服务状态" /></>;
}

export function CoreUsageExample({ cores, stale }: { cores: { name: string; value: number | null }[]; stale: boolean }) {
  return <CoreUsageChart cores={cores} stale={stale} />;
}
