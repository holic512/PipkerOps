/** Monitoring rows have domain identities: a PID alone cannot identify a socket. */
export function monitoringRowKeys(rows: readonly Record<string, unknown>[]) {
  const seen = new Map<string, number>();
  return rows.map((row, index) => {
    const identity =
      row.id != null
        ? ["id", row.id]
        : row.port != null
          ? [
              "socket",
              row.pid,
              row.type ?? row.status,
              row.address,
              row.port,
              row.fd,
            ]
          : row.pid != null
            ? ["process", row.pid]
            : row.metric != null
              ? ["metric", row.metric, row.device]
              : row.mountpoint != null
                ? ["filesystem", row.mountpoint]
                : row.name != null
                  ? ["name", row.name]
                  : row.cpu != null
                    ? ["cpu", row.cpu]
                    : ["row", index];
    const base = JSON.stringify(identity);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    // Identical source rows are retained; never silently drop observations.
    return `${base}:${occurrence}`;
  });
}
