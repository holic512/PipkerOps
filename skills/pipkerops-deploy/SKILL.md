---
name: pipkerops-deploy
description: Deploy or update an application through PipkerOps MCP on authorized Linux nodes using durable tasks, health probes and execution audit.
---

Use the connected PipkerOps MCP server. Call `nodes_list` and `applications_list` to identify the actual authorized node and application. Tool arguments are wrapped in `params`. Read the repository's `docs/API.md` if available for payload contracts; otherwise obtain the platform API description from the user or available server metadata rather than guessing fields.

For a Compose deployment, obtain the intended YAML, project name and target node. Verify image sources, ports, persistent volumes and requested scope. Create an application/instance association with `applications_save` and `deployments_save` when requested. Submit `tasks_create` with `type:compose.deploy`, `nodeId`, `payload:{project,yaml}` and a unique `idempotencyKey`. Set `confirmed:true` only after the user's deployment instruction covers this concrete change.

Record the returned task ID and poll `tasks_get` at a reasonable interval until completion. A timeout, disconnect or UNKNOWN result does not authorize resubmitting a deployment. Reconcile the original task and actual `compose.status` before deciding what to do next. Failure does not imply that volumes or containers can safely be deleted.

Use `probes_save` / `probes_run` / `probes_history` to validate the requested service from its real source. Report task ID, actual status and health evidence. Do not declare success from task creation alone. Never echo API keys or put registry credentials into a committed YAML file. Rollback requires the prior artifact/configuration and authorization; it is another audited task.
