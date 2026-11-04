import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// 保留原生 checked / FormData / indeterminate 契约，方便列表批选与普通表单共用。
export function Checkbox({
  className,
  ...props
}: Omit<ComponentProps<"input">, "type">) {
  return (
    <input
      {...props}
      type="checkbox"
      data-slot="checkbox"
      className={cn("checkbox", className)}
    />
  );
}
