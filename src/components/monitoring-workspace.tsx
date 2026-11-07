"use client";
import {
  createContext,
  useContext,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";

export type ObjectSelection = {
  kind: "process" | "container" | "service" | "diagnostics";
  objectIds: string[];
  metric: string;
  hours: number;
  from?: string;
  to?: string;
  focusId?: string;
};
type Workspace = {
  rank: string;
  hours: number;
  devices: { mount: string; network: string; io: string };
  filters: Record<
    string,
    { query: string; onlyAbnormal: boolean; sort: string; device: string }
  >;
  object?: ObjectSelection;
  returnTab?: string;
  abnormal?: boolean;
};
const initial: Workspace = {
  rank: "cpuPercent",
  hours: 1,
  devices: { mount: "", network: "", io: "" },
  filters: {},
};
const Context = createContext<{
  nodeId: string;
  state: Workspace;
  setState: Dispatch<SetStateAction<Workspace>>;
  navigate: (tab: string, abnormal?: boolean) => void;
} | null>(null);
export function MonitoringWorkspace({
  children,
  nodeId,
  onNavigate,
}: {
  children: ReactNode;
  nodeId: string;
  onNavigate: (tab: string) => void;
}) {
  const [state, setState] = useState<Workspace>(initial);
  const navigate = (tab: string, abnormal = false) => {
    setState((s) => ({
      ...s,
      abnormal,
      filters: abnormal
        ? Object.fromEntries(
            Object.entries(s.filters).map(([key, f]) => [
              key,
              tab === "services" &&
              (key.includes("容器") || key.includes("systemd"))
                ? { ...f, onlyAbnormal: true }
                : f,
            ]),
          )
        : s.filters,
    }));
    onNavigate(tab);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[role="tabpanel"]')?.focus(),
    );
  };
  return (
    <Context value={{ nodeId, state, setState, navigate }}>{children}</Context>
  );
}
export function useMonitoringWorkspace() {
  return useContext(Context);
}
