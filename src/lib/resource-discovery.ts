/**
 * @file resource-discovery.ts
 * @project PipkerOps
 * @module stable-resource-discovery
 * @description 根据显式定位规则解释资源的当前容器集合和运行状态。
 * @logic 仅精确匹配节点内 Compose 项目服务、固定标签或固定名称，不降级规则；Compose 服务允许多副本。
 * @dependencies Docker contracts, resource contracts
 * @index_tags resources, identity, compose, matching
 * @author holic512
 */
import type { DockerContainer } from "./docker-contracts";
import type { ResourceLocator } from "./resource-contracts";

export function matchResource(
  locator: Pick<
    ResourceLocator,
    "strategy" | "project" | "service" | "containerName" | "labelValue"
  >,
  containers: DockerContainer[],
) {
  const instances = containers
    .filter((container) => {
      switch (locator.strategy) {
        case "compose":
          return (
            !!locator.project &&
            !!locator.service &&
            container.labels["com.docker.compose.project"] ===
              locator.project &&
            container.labels["com.docker.compose.service"] === locator.service
          );
        case "label":
          return (
            !!locator.labelValue &&
            container.labels["pipkerops.resource-id"] === locator.labelValue
          );
        case "name":
          return (
            !!locator.containerName &&
            container.name.replace(/^\//, "") === locator.containerName
          );
        default:
          return false;
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const identification =
    locator.strategy === "unconfirmed"
      ? "UNCONFIRMED"
      : !instances.length
        ? "MISSING"
        : locator.strategy !== "compose" && instances.length > 1
          ? "CONFLICT"
          : "LOCATED";
  const states = new Set(
    instances.map((instance) => instance.state.toLowerCase()),
  );
  const runtimeState = !instances.length
    ? "UNKNOWN"
    : states.has("dead") ||
        states.has("restarting") ||
        instances.some(
          (instance) =>
            instance.state.toLowerCase() === "exited" && !!instance.exitCode,
        )
      ? "FAILED"
      : [...states].every((state) => state === "running")
        ? "RUNNING"
        : [...states].every((state) =>
              ["exited", "created", "paused"].includes(state),
            )
          ? "STOPPED"
          : "PARTIAL";
  return { instances, identification, runtimeState };
}

export function locatorForContainer(
  strategy: "compose" | "label" | "name",
  container: DockerContainer,
): ResourceLocator {
  const project =
    strategy === "compose"
      ? container.labels["com.docker.compose.project"] || null
      : null;
  const service =
    strategy === "compose"
      ? container.labels["com.docker.compose.service"] || null
      : null;
  const containerName =
    strategy === "name" ? container.name.replace(/^\//, "") : null;
  const labelValue =
    strategy === "label"
      ? container.labels["pipkerops.resource-id"] || null
      : null;
  return {
    strategy,
    type: strategy === "compose" ? "compose" : "docker",
    project,
    service,
    containerName,
    labelValue,
    locatorKey: JSON.stringify(
      strategy === "compose"
        ? [strategy, project, service]
        : [strategy, labelValue ?? containerName],
    ),
  };
}

export const resourceFreshnessMs = 60000;
