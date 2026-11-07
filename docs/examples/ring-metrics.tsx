import { RingChart } from "@/components/ui/chart";

/** Receives measured values; null never becomes a measured zero. */
export function RingMetricExample({
  cpuPercent,
  recv,
  sent,
}: {
  cpuPercent: number | null;
  recv: number | null;
  sent: number | null;
}) {
  return (
    <>
      <RingChart label={`CPU：${cpuPercent ?? "等待采样"}`} value={cpuPercent}>
        <strong>{cpuPercent ?? "等待采样"}</strong>
        <small>%</small>
      </RingChart>
      <RingChart
        label={`网络接收 ${recv ?? "未知"} B/s，发送 ${sent ?? "未知"} B/s；接收/发送占比`}
        value={recv !== null && sent !== null ? recv : null}
        total={(recv ?? 0) + (sent ?? 0)}
        composition
      >
        <strong>{recv ?? "等待采样"}</strong>
        <small>B/s</small>
      </RingChart>
    </>
  );
}
