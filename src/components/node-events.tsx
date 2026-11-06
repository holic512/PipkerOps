"use client";
import { useEffect } from "react";
import { useSWRConfig } from "swr";
/** One stream per console; existing SWR intervals remain the fallback. */
export function useNodeEvents(enabled: boolean) {
  const { mutate } = useSWRConfig();
  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = new Set<string>();
    const refresh = () => {
      const ids = new Set(changed);
      changed.clear();
      void mutate((key) => {
        if (!Array.isArray(key)) return false;
        if (["nodes.summary", "overview"].includes(key[0])) return true;
        if (!["nodes.get", "nodes.snapshot"].includes(key[0])) return false;
        try {
          return !ids.size || ids.has(JSON.parse(key[1]).nodeId);
        } catch {
          return false;
        }
      });
    };
    const open = () => {
      source?.close();
      source = undefined;
      if (document.hidden) return;
      refresh();
      source = new EventSource("/api/nodes/events");
      source.addEventListener("ready", refresh);
      source.addEventListener("nodes", (event) => {
        try {
          changed.add(JSON.parse((event as MessageEvent).data).nodeId);
        } catch {
          return;
        }
        if (!timer)
          timer = setTimeout(() => {
            timer = undefined;
            refresh();
          }, 250);
      });
    };
    open();
    document.addEventListener("visibilitychange", open);
    return () => {
      source?.close();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", open);
    };
  }, [enabled, mutate]);
}
