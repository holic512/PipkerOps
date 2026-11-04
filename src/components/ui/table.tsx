/**
 * @file table.tsx
 * @project PipkerOps
 * @module shared-table-ui
 * @description 可组合表头与语义行内容的统一数据表格。
 * @logic 公共层管理列标题与键盘横向滚动，业务只传列定义和行内容。
 * @dependencies React, cn, global table styles
 * @index_tags table, composition, accessibility
 * @author holic512
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function DataTable({
  headers,
  children,
  label = "数据表格",
  className,
}: {
  headers: ReactNode[];
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("table-wrap", className)}
      role="region"
      aria-label={`${label}，可横向滚动`}
      tabIndex={0}
    >
      <table className="data-table">
        <thead>
          <tr>
            {headers.map((h, index) => (
              <th scope="col" key={index}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
