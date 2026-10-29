/**
 * @file topology.tsx
 * @project PipkerOps
 * @module topology-ui
 * @description 真实应用、部署、节点、站点和探针关系的交互式图与连通性矩阵。
 * @logic 基于业务资源构建有向图，探针健康标记依赖；矩阵只显示真实探测结果。
 * @dependencies React Flow, RPC, shared UI
 * @index_tags topology, connectivity, ui
 * @author holic512
 */
"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Plus, RotateCw } from "lucide-react";
import { type AppData, type NodeData, type ProbeData } from "@/lib/client";
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
    status: string;
  }[];
};
export function Topology() {
  const q = useQuery<GraphData>("topology");
  const [tab, setTab] = useState("graph");
  const [selected, setSelected] = useState<Node | null>(null);
  const [show, setShow] = useState(false);
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const op = useOperation(() => void q.mutate());
  const graph = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const d = q.data;
    if (!d) return { nodes, edges };
    let deploymentRow = 0;
    d.applications.forEach((a) => {
      const probes = d.probes.filter(
        (p) =>
          (p as ProbeData & { applicationId?: string }).applicationId === a.id,
      );
      const state = probes.some((p) => p.status === "UNHEALTHY")
        ? "UNHEALTHY"
        : probes.length && probes.every((p) => p.status === "HEALTHY")
          ? "HEALTHY"
          : "UNKNOWN";
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
        nodes.push({
          id: `deployment:${deployment.id}`,
          position: { x: 350, y: deploymentRow++ * 105 },
          data: {
            label: `${deployment.type} · ${deployment.name}`,
            kind: "部署实例",
            target: deployment.target,
            state: deployment.status,
          },
          className: "graph-entity",
        });
        edges.push({
          id: `app-deploy:${deployment.id}`,
          source: `app:${a.id}`,
          target: `deployment:${deployment.id}`,
          label: "部署",
          markerEnd: { type: MarkerType.ArrowClosed },
        });
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
      const containers = n.metrics[0]?.payload.containers;
      if (Array.isArray(containers))
        containers.slice(0, 12).forEach((c, j) => {
          if (!c || typeof c !== "object") return;
          const obj = c as Record<string, unknown>;
          const id = `container:${n.id}:${String(obj.id ?? j)}`;
          nodes.push({
            id,
            position: { x: 1050, y: nodeRow++ * 90 },
            data: {
              label: `容器 · ${String(obj.name ?? obj.id ?? "未命名")}`,
              kind: "Docker 容器",
              state: String(obj.state ?? "UNKNOWN"),
            },
            className: "graph-entity",
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
    d.dependencies.forEach((dep) => {
      const unhealthy = d.probes.some(
        (p) =>
          (p as ProbeData & { applicationId?: string }).applicationId ===
            dep.toApplicationId && p.status === "UNHEALTHY",
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
        data: { label: `Nginx · ${s.domain}`, kind: "站点", state: s.status },
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
                nodes={graph.nodes.map((n) => ({
                  ...n,
                  position: positions[n.id] ?? n.position,
                }))}
                onNodeDragStop={(_, node) =>
                  setPositions((p) => ({ ...p, [node.id]: node.position }))
                }
                edges={graph.edges}
                fitView
                minZoom={0.2}
                maxZoom={1.8}
                nodesDraggable
                onNodeClick={(_, node) => setSelected(node)}
                onPaneClick={() => setSelected(null)}
                aria-label="应用与节点拓扑"
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
                          const p = q.data?.probes.find(
                            (p) =>
                              p.sourceNodeId === source.id &&
                              p.target === target,
                          );
                          return (
                            <td key={target}>
                              {p ? (
                                <Status value={p.status} />
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
