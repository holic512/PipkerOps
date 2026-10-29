"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="error-page">
      <h1>工作台暂时无法加载</h1>
      <p>请检查服务状态后重新加载。</p>
      <button onClick={reset}>重新加载</button>
    </main>
  );
}
