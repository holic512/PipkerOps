/**
 * @file topology-links.ts
 * @project PipkerOps
 * @module topology-resource-identity
 * @description 从准确容器身份和已配置端点生成拓扑关系。
 * @logic 仅同节点完整 ID、准确名称或 Compose 标签匹配；端点歧义保持未关联。
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
  const resources = data.nodes.flatMap((node) => {
    const containers = node.metrics[0]?.payload.containers;
    if (!Array.isArray(containers)) return [];
    return containers.flatMap((c) => {
      if (!c || typeof c.id !== "string" || typeof c.name !== "string")
        return [];
      const labels = String(c.composeProject ?? "").split(",");
      return [
        {
          id: `container:${node.id}:${c.id}`,
          nodeId: node.id,
          containerId: c.id,
          name: c.name.replace(/^\//, ""),
          project: labels
            .find((l) => l.startsWith("com.docker.compose.project="))
            ?.slice("com.docker.compose.project=".length),
          state: node.connected
            ? c.state === "running" &&
              !String(c.status ?? "").includes("(unhealthy)")
              ? "HEALTHY"
              : "UNHEALTHY"
            : "UNHEALTHY",
        },
      ];
    });
  });
  const deployments = data.applications.flatMap((a) => a.deployments);
  const deploymentLinks = deployments.flatMap((d) => {
    const matches = resources.filter(
      (r) =>
        r.nodeId === d.nodeId &&
        (d.type === "docker"
          ? r.containerId === d.target || r.name === d.target.replace(/^\//, "")
          : d.type === "compose" && r.project === d.target),
    );
    if (d.type === "docker" && matches.length !== 1) return [];
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
