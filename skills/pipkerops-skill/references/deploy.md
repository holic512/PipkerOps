
Use the connected PipkerOps MCP server. Call `nodes_list` and `applications_list` to identify the actual authorized node and application. Tool arguments are wrapped in `params`. Read the repository's `docs/API.md` if available for payload contracts; otherwise obtain the platform API description from the user or available server metadata rather than guessing fields.

For a Compose deployment, obtain the intended YAML, project name and target node. Verify image sources, ports, persistent volumes and requested scope. Create an application/instance association with `applications_save` and `deployments_save` when requested. Call `compose_deploy` with `params:{nodeId,project,yaml,idempotencyKey,confirmed}` and a unique `idempotencyKey`. Set `confirmed:true` only after the user's deployment instruction covers this concrete change.

Record the returned operation ID and poll `docker_operations_get` at a reasonable interval until completion. A timeout, disconnect or UNKNOWN result does not authorize resubmitting a deployment. Reconcile the original operation and actual `compose_status` before deciding what to do next. Failure does not imply that volumes or containers can safely be deleted.

Use `probes_save` / `probes_run` / `probes_history` to validate the requested service from its real source. Report operation ID, actual status and health evidence. Do not declare success from task creation alone. Never echo API keys or put registry credentials into a committed YAML file. Rollback requires the prior artifact/configuration and authorization; it is another explicitly authorized direct operation.

Use `docker_pull` for image pulls and `compose_list` / `compose_read` / `compose_status` for direct resource queries. A returned operation ID is not completion; its log status must become SUCCEEDED before validating service health. Docker logs and results are independent of `tasks_get`. Old `tasks_create` Docker types remain compatible for existing schedules and background actions.
