/**
 * @file topology-links.ts
 * @project PipkerOps
 * @module topology-resource-identity
 * @description 从准确容器身份和已配置端点生成拓扑关系。
 * @logic 仅同节点完整 ID、准确名称、服务单元名或 Compose 标签匹配；端点歧义保持未关联。
 * @dependencies URL
 * @index_tags topology, identity, resources
 * @author holic512
 */
type Input = {
  nodes: {
    id: string;
    connected: boolean;
    metrics: { payload: Record<string, unknown> }[];
  }[];
  applications: {
    id: string;
    deployments: { id: string; nodeId: string; type: string; target: string }[];
  }[];
  probes: {
    applicationId: string | null;
    sourceNodeId: string | null;
    target: string;
    type: string;
    enabled: boolean;
  }[];
  sites: { id: string; nodeId: string; upstream: string }[];
};
export function topologyLinks(data: Input) {
  const resources: {
    id: string;
    nodeId: string;
    kind: "docker" | "systemd";
    target: string;
    name: string;
    project?: string;
    state: string;
  }[] = [];
  for (const node of data.nodes) {
    const payload = node.metrics[0]?.payload;
    const containers = payload?.containers;
    if (Array.isArray(containers))
      for (const c of containers) {
        if (!c || typeof c.id !== "string" || typeof c.name !== "string")
          continue;
        const labels = String(c.composeProject ?? "").split(",");
        resources.push({
          id: `container:${node.id}:${c.id}`,
          nodeId: node.id,
          kind: "docker",
          target: c.id,
          name: c.name.replace(/^\//, ""),
          project: labels
            .find((l) => l.startsWith("com.docker.compose.project="))
            ?.slice("com.docker.compose.project=".length),
          state:
            node.connected &&
            c.state === "running" &&
            !String(c.status ?? "").includes("(unhealthy)")
              ? "HEALTHY"
              : "UNHEALTHY",
        });
      }
    const services = payload?.services;
    if (Array.isArray(services))
      for (const service of services) {
        if (!service || typeof service.name !== "string") continue;
        resources.push({
          id: `service:${node.id}:${service.name}`,
          nodeId: node.id,
          kind: "systemd",
          target: service.name,
          name: service.name,
          state:
            !node.connected || ["inactive", "failed"].includes(service.active)
              ? "UNHEALTHY"
              : service.active === "active"
                ? "HEALTHY"
                : "UNKNOWN",
        });
      }
  }
  const deployments = data.applications.flatMap((a) => a.deployments);
  const deploymentLinks = deployments.flatMap((d) => {
    const matches = resources.filter(
      (r) =>
        r.nodeId === d.nodeId &&
        (d.type === "docker"
          ? r.kind === "docker" &&
            (r.target === d.target || r.name === d.target.replace(/^\//, ""))
          : d.type === "systemd"
            ? r.kind === "systemd" && r.target === d.target
            : d.type === "compose" &&
              r.kind === "docker" &&
              r.project === d.target),
    );
    if (["docker", "systemd"].includes(d.type) && matches.length !== 1)
      return [];
    return matches.map((r) => ({
      deploymentId: d.id,
      resourceId: r.id,
      state: r.state,
    }));
  });
  const siteLinks = data.sites.flatMap((site) => {
    const upstream = endpoint(site.upstream);
    if (!upstream) return [];
    const apps = new Set(
      data.probes
        .filter(
          (p) =>
            p.enabled &&
            p.type === "HTTP" &&
            p.applicationId &&
            endpoint(p.target) === upstream &&
            p.sourceNodeId === site.nodeId,
        )
        .map((p) => p.applicationId!),
    );
    return apps.size === 1
      ? [{ siteId: site.id, applicationId: [...apps][0] }]
      : [];
  });
  return { resources, deploymentLinks, siteLinks };
}
function endpoint(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}
