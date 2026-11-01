/**
 * @file backups.tsx
 * @project PipkerOps
 * @module platform-backup-ui
 * @description 系统备份列表、任务反馈、下载及删除入口。
 * @logic 仅管理员操作，复用查询和确认组件；异步任务持续刷新，备份文件独立保存在持久目录。
 * @dependencies React, shared UI, RPC, task pages
 * @index_tags backups, platform, persistence, ui
 * @author holic512
 */
"use client";
import Link from "next/link";
import { useState } from "react";
import { Archive, Download, RotateCw, Trash2 } from "lucide-react";
import { rpc, date } from "@/lib/client";
import { Button } from "./ui/button";
import {
  DataTable,
  PageTitle,
  QueryState,
  Status,
  useOperation,
  useQuery,
} from "./shared";

type Backup = {
  id: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
};
type BackupJob = {
  id: string;
  status: string;
  createdAt: string;
  error: string | null;
};
type BackupList = { items: Backup[]; jobs: BackupJob[] };
export function Backups() {
  const query = useQuery<BackupList>("backups.list", {}, 3000);
  const operation = useOperation(() => {
    void query.mutate();
  });
  const [creationKey, setCreationKey] = useState<string | null>(null);
  const active = query.data?.jobs.some((job) =>
    ["QUEUED", "RUNNING", "DISPATCHED"].includes(job.status),
  );
  return (
    <>
      <PageTitle
        title="系统备份"
        description="备份主应用数据库与 Agent 身份证书，记录执行结果并保存到持久存储。"
      >
        <Button
          variant="outline"
          onClick={() => void query.mutate()}
          disabled={query.isLoading}
        >
          <RotateCw size={15} />
          刷新
        </Button>
        <Button
          disabled={
            operation.busy || active || !!query.error || query.isLoading
          }
          onClick={() => {
            const key = creationKey ?? crypto.randomUUID();
            setCreationKey(key);
            operation.ask(
              "创建系统备份",
              "将备份当前业务数据库与 Agent PKI。备份包含敏感业务和私钥，请仅向可信管理员交付。备份在后台执行，可继续使用页面。",
              async () => {
                const task = await rpc<{ id: string }>("backups.create", {
                  confirmed: true,
                  idempotencyKey: key,
                });
                setCreationKey(null);
                return task;
              },
              "备份任务已记录，可在下方查看执行状态。",
            );
          }}
        >
          <Archive size={15} />
          {active ? "备份执行中" : "创建备份"}
        </Button>
      </PageTitle>
      {operation.ui}
      <p className="muted">
        备份保留在主应用的 Docker
        持久存储中，重启或更新容器不会删除。下载后请另存到独立存储。运行配置与
        Web HTTPS 证书需单独保管。
      </p>
      <QueryState
        error={query.error}
        loading={query.isLoading}
        retry={() => void query.mutate()}
      >
        {!!query.data?.jobs.length && (
          <section className="panel detail-panel">
            <div className="panel-header">
              <h2>最近备份任务</h2>
            </div>
            <DataTable headers={["任务创建时间", "状态", "结果", "任务"]}>
              {query.data.jobs.slice(0, 5).map((job) => (
                <tr key={job.id}>
                  <td>{date(job.createdAt)}</td>
                  <td>
                    <Status value={job.status} />
                  </td>
                  <td>
                    {job.error ??
                      (job.status === "SUCCEEDED"
                        ? "备份任务已完成"
                        : "查看任务执行状态")}
                  </td>
                  <td>
                    <Link href={`/tasks/${job.id}`}>查看任务</Link>
                  </td>
                </tr>
              ))}
            </DataTable>
          </section>
        )}
        <section className="panel detail-panel">
          <div className="panel-header">
            <h2>可用备份</h2>
          </div>
          <QueryState
            loading={false}
            empty={!query.data?.items.length}
            retry={() => void query.mutate()}
            emptyTitle="暂无备份"
            emptyText="创建首份系统备份后，可在这里下载和管理。"
          >
            <DataTable
              headers={[
                "备份创建时间",
                "备份编号",
                "大小",
                "完整性摘要",
                "操作",
              ]}
            >
              {query.data?.items.map((backup) => (
                <tr key={backup.id}>
                  <td>{date(backup.createdAt)}</td>
                  <td>
                    <code>{backup.id.slice(0, 8)}</code>
                  </td>
                  <td>{(backup.sizeBytes / 1024 / 1024).toFixed(2)} MB</td>
                  <td>
                    <code title={backup.sha256}>
                      {backup.sha256.slice(0, 16)}…
                    </code>
                  </td>
                  <td>
                    <div className="inline-actions">
                      <Button variant="outline" size="sm" asChild>
                        <a
                          href={`/api/backups/${backup.id}`}
                          download
                          aria-label={`下载备份 ${backup.id.slice(0, 8)}`}
                        >
                          <Download size={14} />
                          下载
                        </a>
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={operation.busy}
                        onClick={() =>
                          operation.ask(
                            "删除系统备份",
                            `将永久删除 ${date(backup.createdAt)} 创建的备份 ${backup.id.slice(0, 8)}。当前运行数据不受影响。`,
                            () =>
                              rpc("backups.delete", {
                                id: backup.id,
                                confirmed: true,
                              }),
                            "备份已删除。",
                          )
                        }
                      >
                        <Trash2 size={14} />
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </DataTable>
          </QueryState>
        </section>
        <section className="panel form-panel detail-panel">
          <h2>恢复说明</h2>
          <p>
            恢复需要维护窗口。停止应用后，使用选定备份恢复到空数据库和空 PKI
            目录，再核对任务状态后启动。现有业务数据不会被直接覆盖。
          </p>
          <p>完整步骤见项目部署文档的“系统备份与恢复”。</p>
        </section>
      </QueryState>
    </>
  );
}
