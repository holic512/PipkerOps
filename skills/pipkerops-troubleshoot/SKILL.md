---
name: pipkerops-troubleshoot
description: Diagnose PipkerOps node, container, Nginx and task failures using scoped MCP evidence and safe task reconciliation.
---

Start with the failing resource and time window. Read node connectivity/metrics, application dependencies, probe history and the original task with `tasks_get`. Distinguish controller/API failure, Gateway transport failure, Agent execution failure and target-service failure.

Use read tasks through `tasks_create` as needed: `system.info`, `docker.list`, `docker.stats`, `docker.logs`, `compose.status`, `compose.read`, `nginx.check`, `nginx.certificate`, `systemd.list`, `files.list` or `files.read`. Specify the authorized node, minimum useful scope and log bound. Read task completion before relying on its result. File reads and logs may contain credentials; redact them in reports.

QUEUED can be cancelled before dispatch. DISPATCHED/RUNNING may still execute after a connection drops. UNKNOWN means the controller cannot establish the outcome. Check Agent journal reconciliation and actual resource state before proposing retry; never blindly repeat Shell, deployment, lifecycle, firewall, ACME or other non-idempotent operations. Durable idempotency keys refer to the same request, not a permission to alter its payload.

Explain the likely cause and cite concrete task/result/timestamp evidence. If remediation is authorized, submit one audited task and validate its effect. A restart, configuration replacement, deletion or firewall change needs authorization covering the target and consequence. Invalid Nginx configuration must fail syntax validation and preserve the previous active configuration. Do not bypass TLS, expand a key's scopes, or erase audit/journal data to make an error disappear.
