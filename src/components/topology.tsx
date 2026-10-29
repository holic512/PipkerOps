/**
 * @file topology.tsx
 * @project PipkerOps
 * @module topology-ui
 * @description 真实应用、部署、节点、站点和探针关系的交互式图与连通性矩阵。
 * @logic 准确身份合并部署容器，配置端点关联站点上游；资源刷新保留布局并更新详情与健康状态。
 * @dependencies React Flow, RPC, shared UI
 * @index_tags topology, connectivity, ui
 * @author holic512
 */
"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ReactFlow,
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type ReactFlowInstance,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus, RotateCw } from "lucide-react";
import {
  probeHealth,
  type AppData,
  type NodeData,
  type ProbeData,
} from "@/lib/client";
import {
  PageTitle,
  QueryState,
  useQuery,
  useOperation,
  ResourceForm,
  Status,
} from "./shared";
import { Button } from "./ui/button";
import { rpc } from "@/lib/client";
import { topologyLinks } from "@/lib/topology-links";
type GraphData = {
  applications: AppData[];
  nodes: NodeData[];
  dependencies: {
    id: string;
    fromApplicationId: string;
    toApplicationId: string;
    type: string;
  }[];
  probes: ProbeData[];
  sites: {
    id: string;
    name: string;
    nodeId: string;
    domain: string;
    upstream: string;
    status: string;
  }[];
};
export function Topology() {
  const q = useQuery<GraphData>("topology");
  const [tab, setTab] = useState("graph");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const [layout, setLayout] = useState<
    Record<string, Pick<Node, "position" | "measured" | "selected">>
  >({});
  const op = useOperation(() => void q.mutate());
  const graph = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const d = q.data;
    if (!d) return { nodes, edges };
    const links = topologyLinks(d);
    let deploymentRow = 0;
    d.applications.forEach((a) => {
      const probes = d.probes.filter(
        (p) =>
          (p as ProbeData & { applicationId?: string }).applicationId === a.id,
      );
      const state = probeHealth(probes);
      nodes.push({
        id: `app:${a.id}`,
        position: { x: 20, y: deploymentRow * 105 },
        data: {
          label: `应用 · ${a.name}`,
          kind: "应用",
          resourceId: a.id,
          state,
        },
        className: `graph-entity graph-${state.toLowerCase()}`,
      });
      a.deployments.forEach((deployment) => {
        const matched = links.deploymentLinks.filter(
          (l) => l.deploymentId === deployment.id,
        );
        const merged = deployment.type === "docker" && matched.length === 1;
        const deploymentGraphId = merged
          ? matched[0].resourceId
          : `deployment:${deployment.id}`;
        if (!merged)
          nodes.push({
            id: deploymentGraphId,
            position: { x: 350, y: deploymentRow++ * 105 },
            data: {
              label: `${deployment.type} · ${deployment.name}`,
              kind: "部署实例",
              target: deployment.target,
              association: matched.length
                ? `已关联 ${matched.length} 个容器`
                : "运行目标未关联到已发现资源",
              state: matched.length
                ? matched.every((l) => l.state === "HEALTHY")
                  ? "HEALTHY"
                  : "UNHEALTHY"
                : d.nodes.find((n) => n.id === deployment.nodeId)?.connected ===
                    false
                  ? "UNHEALTHY"
                  : deployment.status,
            },
            className: "graph-entity",
          });
        edges.push({
          id: `app-deploy:${deployment.id}`,
          source: `app:${a.id}`,
          target: deploymentGraphId,
          label: `部署 · ${deployment.name}`,
          markerEnd: { type: MarkerType.ArrowClosed },
        });
        if (!merged)
          edges.push({
            id: `deploy-node:${deployment.id}`,
            source: `deployment:${deployment.id}`,
            target: `node:${deployment.nodeId}`,
            label: "运行于",
            markerEnd: { type: MarkerType.ArrowClosed },
          });
      });
      if (!a.deployments.length) deploymentRow++;
    });
    let nodeRow = 0;
    d.nodes.forEach((n) => {
      const state = n.connected ? "HEALTHY" : "UNHEALTHY";
      nodes.push({
        id: `node:${n.id}`,
        position: { x: 720, y: nodeRow * 90 },
        data: {
          label: `节点 · ${n.name}`,
          kind: "节点",
          resourceId: n.id,
          state,
          hostname: n.hostname,
        },
        className: `graph-entity graph-${state.toLowerCase()}`,
      });
      links.resources
        .filter((r) => r.nodeId === n.id)
        .forEach((obj) => {
          const id = obj.id;
          nodes.push({
            id,
            position: { x: 1050, y: nodeRow++ * 90 },
            data: {
              label: `容器 · ${obj.name}`,
              target: obj.containerId,
              kind: "Docker 容器",
              state: obj.state,
            },
            className: `graph-entity graph-${obj.state.toLowerCase()}`,
          });
          edges.push({
            id: `node-container:${id}`,
            source: `node:${n.id}`,
            target: id,
            label: "发现",
            markerEnd: { type: MarkerType.ArrowClosed },
          });
        });
      nodeRow++;
    });
    links.deploymentLinks.forEach((link) => {
      const deployment = d.applications
        .flatMap((a) => a.deployments)
        .find((item) => item.id === link.deploymentId)!;
      if (deployment.type === "docker") return;
      edges.push({
        id: `deployment-resource:${link.deploymentId}:${link.resourceId}`,
        source: `deployment:${link.deploymentId}`,
        target: link.resourceId,
        label: "项目容器",
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    });
    links.siteLinks.forEach((link) =>
      edges.push({
        id: `site-upstream:${link.siteId}`,
        source: `site:${link.siteId}`,
        target: `app:${link.applicationId}`,
        label: "上游端点",
        markerEnd: { type: MarkerType.ArrowClosed },
      }),
    );
    d.dependencies.forEach((dep) => {
      const unhealthy = d.probes.some(
        (p) =>
          (p as ProbeData & { applicationId?: string }).applicationId ===
            dep.toApplicationId &&
          p.enabled &&
          p.status === "UNHEALTHY",
      );
      edges.push({
        id: dep.id,
        source: `app:${dep.fromApplicationId}`,
        target: `app:${dep.toApplicationId}`,
        label: dep.type,
        animated: unhealthy,
        style: { stroke: unhealthy ? "#b42318" : "#8597ac" },
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    });
    d.sites.forEach((s, i) => {
      nodes.push({
        id: `site:${s.id}`,
        position: {
          x: 350,
          y: Math.max(1, deploymentRow) * 105 + i * 90,
        },
        data: {
          label: `Nginx · ${s.domain}`,
          kind: "站点",
          state: s.status,
          target: s.upstream,
          association: links.siteLinks.some((l) => l.siteId === s.id)
            ? "已关联唯一配置端点"
            : "上游未关联",
        },
        className: "graph-entity",
      });
      edges.push({
        id: `site-node:${s.id}`,
        source: `site:${s.id}`,
        target: `node:${s.nodeId}`,
        label: "代理节点",
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    });
    return { nodes, edges };
  }, [q.data]);
  const resourceIds = graph.nodes
    .map((n) => n.id)
    .sort()
    .join("|");
  const selected = graph.nodes.find((n) => n.id === selectedId);
  useEffect(() => {
    void flow?.fitView();
  }, [flow, resourceIds]);
  const targets = [...new Set(q.data?.probes.map((p) => p.target) ?? [])];
  return (
    <>
      <PageTitle
        title="应用拓扑"
        description="从应用依赖定位部署与节点，查看真实探测得到的连通性。"
      >
        <Button variant="outline" onClick={() => void q.mutate()}>
          <RotateCw size={15} />
          刷新
        </Button>
        <Button onClick={() => setShow(!show)}>
          <Plus size={16} />
          添加依赖
        </Button>
      </PageTitle>
      {op.ui}
      {show && (
        <section className="panel form-panel">
          <h2>应用依赖</h2>
          <ResourceForm
            busy={op.busy}
            fields={[
              {
                name: "fromApplicationId",
                label: "来源应用",
                type: "select",
                required: true,
                options: q.data?.applications.map((a) => ({
                  value: a.id,
                  label: a.name,
                })),
              },
              {
                name: "toApplicationId",
                label: "依赖应用",
                type: "select",
                required: true,
                options: q.data?.applications.map((a) => ({
                  value: a.id,
                  label: a.name,
                })),
              },
              {
                name: "type",
                label: "关系类型",
                defaultValue: "depends_on",
                required: true,
              },
            ]}
            onSubmit={(d) => op.run(() => rpc("dependencies.save", d))}
          />
        </section>
      )}
      <div className="inner-tabs">
        <button
          className={tab === "graph" ? "active" : ""}
          onClick={() => setTab("graph")}
        >
          交互拓扑
        </button>
        <button
          className={tab === "matrix" ? "active" : ""}
          onClick={() => setTab("matrix")}
        >
          连通性矩阵
        </button>
      </div>
      <QueryState
        error={q.error}
        loading={q.isLoading}
        empty={!graph.nodes.length}
        retry={() => void q.mutate()}
        emptyTitle="还没有可以展示的资源"
        emptyText="接入节点、创建应用或关联部署实例后，拓扑将自动生成。"
      >
        {tab === "graph" ? (
          <div className="topology-layout">
            <section className="topology-canvas">
              <ReactFlow
                onInit={setFlow}
                nodes={graph.nodes.map((n) => ({
                  ...n,
                  ...layout[n.id],
                }))}
                onNodesChange={(changes) =>
                  setLayout((previous) =>
                    Object.fromEntries(
                      applyNodeChanges(
                        changes,
                        graph.nodes.map((n) => ({ ...n, ...previous[n.id] })),
                      ).map(({ id, position, measured, selected }) => [
                        id,
                        { position, measured, selected },
                      ]),
                    ),
                  )
                }
                deleteKeyCode={null}
                edges={graph.edges}
                fitView
                minZoom={0.2}
                maxZoom={1.8}
                nodesDraggable
                nodesConnectable={false}
                onNodeClick={(_, node) => setSelectedId(node.id)}
                onPaneClick={() => setSelectedId(null)}
                aria-label="应用与节点拓扑"
                ariaLabelConfig={{
                  "controls.ariaLabel": "拓扑视图操作",
                  "controls.zoomIn.ariaLabel": "放大拓扑",
                  "controls.zoomOut.ariaLabel": "缩小拓扑",
                  "controls.fitView.ariaLabel": "适配全部资源",
                  "controls.interactive.ariaLabel": "切换拓扑交互",
                }}
              >
                <Background color="#dce3eb" gap={24} />
                <Controls />
                <MiniMap
                  nodeColor={(n) =>
                    String(n.data.state) === "UNHEALTHY" ? "#e69a9a" : "#b5cbeb"
                  }
                  pannable
                  zoomable
                />
              </ReactFlow>
              <div className="graph-legend">
                <span>应用 → 部署 → 节点 → 容器</span>
                <span className="error-text">红色表示故障或离线</span>
              </div>
            </section>
            {!!q.data?.dependencies.length && (
              <section className="panel detail-panel">
                <div className="panel-header">
                  <h2>依赖关系</h2>
                </div>
                <div className="form-panel">
                  {q.data.dependencies.map((dep) => (
                    <div className="inline-actions" key={dep.id}>
                      <span>
                        {
                          q.data?.applications.find(
                            (a) => a.id === dep.fromApplicationId,
                          )?.name
                        }{" "}
                        →{" "}
                        {
                          q.data?.applications.find(
                            (a) => a.id === dep.toApplicationId,
                          )?.name
                        }{" "}
                        · {dep.type}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          op.ask(
                            "删除依赖关系？",
                            "只删除平台记录，不改变应用实际网络连接。",
                            () =>
                              rpc("dependencies.delete", {
                                id: dep.id,
                                confirmed: true,
                              }),
                          )
                        }
                      >
                        删除
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {selected && (
              <aside className="panel graph-details">
                <h2>{String(selected.data.kind)}</h2>
                <strong>{String(selected.data.label)}</strong>
                <Status value={String(selected.data.state ?? "UNKNOWN")} />
                {selected.data.association ? (
                  <p>{String(selected.data.association)}</p>
                ) : null}
                {selected.data.target ? (
                  <code>{String(selected.data.target)}</code>
                ) : null}
                {selected.data.kind === "节点" && (
                  <Link href={`/nodes/${selected.data.resourceId}`}>
                    节点详情
                  </Link>
                )}
                <p className="muted">拖动和缩放画布，点击资源查看详情。</p>
              </aside>
            )}
          </div>
        ) : (
          <section className="panel">
            <div className="panel-header">
              <h2>探针来源 × 实际目标</h2>
              <Link href="/probes">配置跨节点探针</Link>
            </div>
            <QueryState
              loading={false}
              empty={!targets.length}
              retry={() => {}}
              emptyTitle="暂无连通性结果"
              emptyText="创建从指定节点到其他节点端口的 TCP/HTTP 探针后，矩阵会显示真实结果。"
            >
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>来源</th>
                      {targets.map((t) => (
                        <th key={t}>{t}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { id: null, name: "主控" },
                      ...(q.data?.nodes.map((n) => ({
                        id: n.id,
                        name: n.name,
                      })) ?? []),
                    ].map((source) => (
                      <tr key={source.id ?? "control"}>
                        <th>{source.name}</th>
                        {targets.map((target) => {
                          const probes = q.data?.probes.filter(
                            (p) =>
                              p.sourceNodeId === source.id &&
                              p.target === target,
                          );
                          return (
                            <td key={target}>
                              {probes?.length ? (
                                <Status
                                  value={
                                    probes.some((p) => p.enabled)
                                      ? probeHealth(probes)
                                      : "PAUSED"
                                  }
                                />
                              ) : (
                                <span className="muted">未检测</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </QueryState>
          </section>
        )}
      </QueryState>
    </>
  );
}
