/** Missing values and idle ratios have no colored arc; gauges may exceed 100%. */
export function ringSegments(value: number | null | undefined, total = 100) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    !Number.isFinite(total) ||
    total < 0
  )
    return { fraction: null, state: "unknown" as const };
  if (total === 0)
    return {
      fraction: null,
      state: value === 0 ? ("idle" as const) : ("unknown" as const),
    };
  return { fraction: Math.min(value / total, 1), state: "available" as const };
}
export function ringValueLabel(value: number | null | undefined, unit = "") {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  let amount = value,
    displayUnit = unit;
  if (unit === "B/s") {
    const units = ["B/s", "KiB/s", "MiB/s", "GiB/s", "TiB/s"];
    let index = 0;
    while (Math.abs(amount) >= 1024 && index < units.length - 1) {
      amount /= 1024;
      index++;
    }
    displayUnit = units[index];
  }
  return {
    value: Number.isInteger(amount)
      ? amount.toLocaleString("zh-CN")
      : amount.toFixed(2),
    unit: displayUnit,
  };
}
