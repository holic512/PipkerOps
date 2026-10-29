import { test } from "node:test";
import assert from "node:assert/strict";
import { topologyLinks } from "../src/lib/topology-links";

test("拓扑只按同节点准确容器身份和Compose标签关联，刷新移除旧关系", () => {
  const data = {
    nodes: ["a", "b"].map((id) => ({
      id,
      connected: true,
      metrics: [
        {
          payload: {
            containers: [
              {
                id: id.repeat(64),
                name: "web",
                state: "running",
                composeProject: "com.docker.compose.project=stack,other=x",
              },
            ],
          },
        },
      ],
    })),
    applications: [
      {
        id: "app",
        deployments: [
          { id: "d", nodeId: "a", type: "docker", target: "web" },
          { id: "prefix", nodeId: "b", type: "docker", target: "bbbb" },
          { id: "compose", nodeId: "a", type: "compose", target: "stack" },
        ],
      },
    ],
    probes: [],
    sites: [],
  };
  assert.deepEqual(
    topologyLinks(data).deploymentLinks.map((l) => l.deploymentId),
    ["d", "compose"],
  );
  data.nodes[0].connected = false;
  assert.equal(topologyLinks(data).deploymentLinks[0].state, "UNHEALTHY");
  data.nodes[0].connected = true;
  assert.equal(topologyLinks(data).deploymentLinks[0].state, "HEALTHY");
  data.nodes[0].metrics[0].payload.containers[0].name = "renamed";
  assert.equal(topologyLinks(data).resources[0].name, "renamed");
  assert.equal(
    topologyLinks(data).deploymentLinks.some((l) => l.deploymentId === "d"),
    false,
  );
  data.nodes[0].metrics[0].payload.containers = [];
  assert.equal(topologyLinks(data).deploymentLinks.length, 0);
});

test("上游配置端点唯一且探针来源与代理节点一致才关联，不按名称猜测", () => {
  const data = {
    nodes: [],
    applications: [],
    probes: [
      {
        applicationId: "app",
        sourceNodeId: "a",
        type: "HTTP",
        enabled: true,
        target: "http://127.0.0.1:8080/health",
      },
    ],
    sites: [{ id: "site", nodeId: "a", upstream: "http://127.0.0.1:8080" }],
  };
  assert.equal(topologyLinks(data).siteLinks[0].applicationId, "app");
  data.sites[0].nodeId = "b";
  assert.deepEqual(topologyLinks(data).siteLinks, []);
  data.sites[0].nodeId = "a";
  data.probes.push({ ...data.probes[0], applicationId: "other" });
  assert.deepEqual(topologyLinks(data).siteLinks, []);
  data.probes[1].enabled = false;
  assert.equal(topologyLinks(data).siteLinks.length, 1);
});

test("systemd只按同节点准确单元名合并，状态随采样和连接刷新", () => {
  const data = {
    nodes: [
      {
        id: "a",
        connected: true,
        metrics: [
          {
            payload: {
              services: [{ name: "nginx.service", active: "active" }],
            },
          },
        ],
      },
    ],
    applications: [
      {
        id: "app",
        deployments: [
          {
            id: "service",
            nodeId: "a",
            type: "systemd",
            target: "nginx.service",
          },
          {
            id: "wrong-node",
            nodeId: "b",
            type: "systemd",
            target: "nginx.service",
          },
          { id: "guess", nodeId: "a", type: "systemd", target: "nginx" },
        ],
      },
    ],
    probes: [],
    sites: [],
  };
  assert.deepEqual(topologyLinks(data).deploymentLinks, [
    {
      deploymentId: "service",
      resourceId: "service:a:nginx.service",
      state: "HEALTHY",
    },
  ]);
  data.nodes[0].metrics[0].payload.services[0].active = "inactive";
  assert.equal(topologyLinks(data).deploymentLinks[0].state, "UNHEALTHY");
  data.nodes[0].metrics[0].payload.services[0].active = "active";
  data.nodes[0].connected = false;
  assert.equal(topologyLinks(data).deploymentLinks[0].state, "UNHEALTHY");
  data.nodes[0].metrics[0].payload.services = [];
  assert.deepEqual(topologyLinks(data).deploymentLinks, []);
});
