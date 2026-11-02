/**
 * @file updates.tsx
 * @project PipkerOps
 * @module updates-ui
 * @description 版本发现、部署目录登记与 Ops/Agent/脚本更新入口。
 * @logic 手动检查发布；更新前展示目标和目录并确认，结果弹窗提供持久任务入口，关闭后更新继续执行。
 * @dependencies React, node/update RPC, shared forms
 * @index_tags updates, deployment, releases, ui
 * @author holic512
 */
"use client";
import Link from "next/link";
import { useState } from "react";
import { rpc, type NodeData } from "@/lib/client";
import { useOperation, useQuery, PageTitle, QueryState } from "./shared";
import { Button } from "./ui/button";
import { BusinessDialog } from "./ui/dialog";
type Release = { tag: string; name: string };
export function Updates() {
  const nodes = useQuery<NodeData[]>("nodes.list");
  const user = useQuery<{ role: string }>("users.me");
  const op = useOperation();
  const [releases, setReleases] = useState<Release[]>([]);
  const [tag, setTag] = useState("");
  const [component, setComponent] = useState("agent");
  const [nodeId, setNodeId] = useState("");
  const [root, setRoot] = useState("");
  const [registered, setRegistered] = useState(false);
  const [taskId, setTaskId] = useState("");
  const [resultOpen, setResultOpen] = useState(false);
  const node = nodes.data?.find((n) => n.id === nodeId);
  const targetRoot = root || node?.deployRoot || "";
  return (
    <>
      <PageTitle
        title="版本更新"
        description="手动选择发布版本，更新应用和部署脚本。"
      >
        {taskId && (
          <Button variant="outline" onClick={() => setResultOpen(true)}>
            查看最近结果
          </Button>
        )}
      </PageTitle>
      {op.ui}
      {taskId && resultOpen && (
        <BusinessDialog
          title="更新任务已创建"
          readOnly
          onClose={() => setResultOpen(false)}
        >
          <p role="status">任务在后台继续执行。</p>
          <Link href={`/tasks/${taskId}`}>查看进度与结果</Link>
        </BusinessDialog>
      )}
      {user.data?.role !== "ADMIN" ? (
        <p>版本更新需要管理员权限。</p>
      ) : (
        <QueryState
          loading={nodes.isLoading}
          error={nodes.error}
          retry={() => void nodes.mutate()}
        >
          <section className="panel form-panel">
            <h2>选择更新目标</h2>
            <p className="muted">
              Ops 自身更新需选择安装在 Ops 宿主机上的
              Agent。首次安装仍通过本地部署脚本完成。
            </p>
            <label>
              组件
              <select
                value={component}
                onChange={(e) => {
                  setComponent(e.target.value);
                  setRegistered(false);
                }}
              >
                <option value="agent">Agent 程序</option>
                <option value="scripts">部署脚本</option>
                <option value="ops">Ops 应用（同机 Agent 执行）</option>
              </select>
            </label>
            <label>
              执行节点
              <select
                value={nodeId}
                onChange={(e) => {
                  setNodeId(e.target.value);
                  setRoot("");
                  setRegistered(false);
                }}
              >
                <option value="">请选择已接入的节点</option>
                {nodes.data
                  ?.filter((n) => n.agentId && n.status === "APPROVED")
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name} · Agent {n.agentVersion ?? "未知"}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              原部署目录（目标主机上的绝对路径）
              <input
                value={targetRoot}
                placeholder="例如 /opt/pipkerops/deploy"
                onChange={(e) => {
                  setRoot(e.target.value);
                  setRegistered(false);
                }}
              />
            </label>
            <Button
              variant="outline"
              disabled={op.busy || !nodeId || !targetRoot.startsWith("/")}
              onClick={async () => {
                const result = await op.run(
                  () =>
                    rpc("nodes.deployment", {
                      nodeId,
                      deployRoot: targetRoot,
                      component,
                      confirmed: true,
                    }),
                  "部署目录已验证并登记",
                );
                if (result) {
                  setRegistered(true);
                  void nodes.mutate();
                }
              }}
            >
              验证并登记目录
            </Button>
            <label>
              发布版本
              <select value={tag} onChange={(e) => setTag(e.target.value)}>
                <option value="">请先检查更新并选择版本</option>
                {releases.map((release) => (
                  <option key={release.tag} value={release.tag}>
                    {release.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="inline-actions">
              <Button
                variant="outline"
                disabled={op.busy}
                onClick={async () => {
                  const result = await op.run(
                    () => rpc<Release[]>("updates.releases"),
                    "已获取正式发布列表",
                  );
                  if (result) {
                    setReleases(result);
                    setTag("");
                  }
                }}
              >
                检查更新
              </Button>
              <Button
                disabled={op.busy || !tag || !registered || !node?.connected}
                onClick={() =>
                  op.ask(
                    "执行所选更新？",
                    `${node?.name} · ${component} · ${tag}。部署目录：${targetRoot}。程序可能短暂断线，配置和凭证将保留。`,
                    async () => {
                      const task = await rpc<{ id: string }>("updates.create", {
                        nodeId,
                        component,
                        releaseTag: tag,
                        deployRoot: targetRoot,
                        confirmed: true,
                        idempotencyKey: crypto.randomUUID(),
                      });
                      setTaskId(task.id);
                      setResultOpen(true);
                      return task;
                    },
                  )
                }
              >
                更新到所选版本
              </Button>
            </div>
            {registered && (
              <p role="status">
                已验证部署目录。只替换发布清单管理的程序文件。
              </p>
            )}
            {node && !node.connected && (
              <p className="error-text">节点当前离线，恢复连接后再更新。</p>
            )}
          </section>
        </QueryState>
      )}
    </>
  );
}
