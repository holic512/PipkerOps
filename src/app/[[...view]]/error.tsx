"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="error-page">
      <h1>工作台暂时无法加载</h1>
      <p>请检查服务状态后重新加载。</p>
      <Button onClick={reset}>重新加载</Button>
    </main>
  );
}
