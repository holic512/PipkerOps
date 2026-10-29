export default function Loading() {
  return (
    <div className="page-loading" aria-busy="true">
      <div className="skeleton" />
      <div className="skeleton" />
      <span>正在载入工作台…</span>
    </div>
  );
}
