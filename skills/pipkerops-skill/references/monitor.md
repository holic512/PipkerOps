
Use `nodes_list`, `applications_list`, `probes_list` and `topology` within the connected key's available scopes. Missing permission means the result is incomplete; an empty authorized list does not prove the entire cluster has no resources.

For a node, query `nodes_metrics` with `params:{nodeId,hours}`. Windows up to 48 hours use raw samples; longer windows use hourly aggregates. Check last-seen and recorded timestamps before interpreting values. Offline or missing data is unknown health, not zero utilization.

For service reachability, inspect `probes_history` with `params:{id}`. Compare source node, target, sample time, latency and failure threshold. The returned success rate describes the available recent result window, not an arbitrary uptime SLA. Compare multiple sources before attributing a failure to the application. JSON-mapped business values come from actual responses; absence must be reported.

Report observed facts, interval and affected resources. This skill grants read access only. Creating probes, changing alert rules, running a terminal or taking remediation actions requires a user instruction covering that change. For a request to monitor later, use an available scheduler with the user's requested cadence and notify only on meaningful changes; do not simulate a background monitor in a completed response.

Prefer `nodes_summary` for lightweight current utilization and `nodes_get` for one node. Use `nodes_snapshot` with `params:{nodeId,category}` for fast/disks/details/static telemetry; inspect each category's timestamps, stale flag, errors and truncation. Old Agents may only provide legacy snapshots. Never treat a connected node as proof that every collector is healthy.

Additional numeric history uses `nodes_history` with `params:{nodeId,kind:"metric",metric:"io.readIOPS",hours:24,device?}`. Other examples include cpu.iowait, load.1, swap.in, disk.inodePercent, network.recvPackets and io.readLatency. Preserve units and nulls. These graphs show sampled values; use the existing device counter history for weighted throughput, not a sum of instantaneous rate points. These tools remain read-only and do not authorize remediation.
