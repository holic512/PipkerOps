---
name: pipkerops-skill
description: Use PipkerOps MCP to deploy applications, inspect infrastructure health, or diagnose node and service failures on authorized resources.
---

# PipkerOpsSkill

Use the connected PipkerOps MCP server and follow the reference for the requested work:

- Deployment or updates: [deploy](references/deploy.md).
- Metrics, probes and topology: [monitor](references/monitor.md).
- Diagnosing failures and reconciling operations or tasks: [troubleshoot](references/troubleshoot.md).

Combine references when the task spans modes. Respect the authorization and task reconciliation requirements in each reference.

Docker/Compose interactive calls use direct tools and independent operation logs; scheduled/background tasks retain the legacy task workflow. Read the selected reference before choosing either workflow.
