"use client";
/**
 * @file resource-page.tsx
 * @project PipkerOps
 * @module ui-reference
 * @description 可编译的列表与创建弹窗组合示例，不注册业务路由或虚构 API。
 * @logic 数据与保存动作由调用方提供，复用查询态、表格、表单、确认与反馈。
 * @dependencies React, shared UI, Button, BusinessDialog
 * @index_tags example, forms, table, confirmation
 * @author holic512
 */
import { useState } from "react";
import {
  DataTable,
  Feedback,
  PageTitle,
  QueryState,
  ResourceForm,
  Status,
  useOperation,
} from "@/components/shared";
import { Button } from "@/components/ui/button";
import { BusinessDialog } from "@/components/ui/dialog";

export function ResourcePageExample({
  rows,
  loading,
  error,
  retry,
  onSave,
}: {
  rows: { id: string; name: string; status: string }[];
  loading: boolean;
  error?: Error;
  retry: () => void;
  onSave: (name: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const operation = useOperation(() => {
    setOpen(false);
    retry();
  }, true);
  const close = () => {
    setOpen(false);
    operation.clear();
  };
  return (
    <>
      <PageTitle title="资源列表">
        <Button variant="outline" onClick={retry} disabled={loading}>
          刷新
        </Button>
        <Button
          onClick={() => {
            operation.clear();
            setOpen(true);
          }}
        >
          创建资源
        </Button>
      </PageTitle>
      {!open && (
        <Feedback value={operation.feedback} onClose={operation.clear} />
      )}
      <section className="panel">
        <QueryState
          loading={loading}
          error={error}
          empty={!rows.length}
          retry={retry}
          emptyTitle="暂无资源"
          emptyText="创建第一条资源后，可在这里管理。"
        >
          <DataTable label="资源列表" headers={["名称", "状态"]}>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                <td>
                  <Status value={row.status} />
                </td>
              </tr>
            ))}
          </DataTable>
        </QueryState>
      </section>
      {open && (
        <BusinessDialog
          title="创建资源"
          onClose={close}
          operation={operation}
          formId="resource-example-form"
        >
          <ResourceForm
            id="resource-example-form"
            hideSubmit
            busy={operation.busy}
            fields={[{ name: "name", label: "名称", required: true }]}
            onSubmit={async (data) => {
              operation.ask(
                "创建此资源？",
                `名称：${data.name}`,
                () => onSave(String(data.name)),
                "资源已创建",
              );
            }}
          />
        </BusinessDialog>
      )}
    </>
  );
}
