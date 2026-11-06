# PipkerOps

**A central operations platform for Linux nodes, bringing infrastructure visibility, remote operations, and AI tools together.**

[简体中文](README.md) · [Deployment guide](docs/DEPLOYMENT.md) · [API & MCP](docs/API.md) · [Agent](agent/README.md)

PipkerOps is designed for individual developers and small teams managing 10–50 Linux nodes. It brings node and device history, application health, probes, and topology into one place, with traceable remote tasks.

> This project is under development. See [Development and validation](docs/DEVELOPMENT.md) for the current public-production and long-term stability validation boundaries. The linked detailed documentation is currently in Chinese.

## What it does

- **Observe infrastructure:** inspect node and device history, application health, probes, and topology.
- **Run remote tasks:** manage hosts through the Agent and track task status and results.
- **Connect AI workflows:** expose platform capabilities to AI agents through MCP. Web, MCP, and Cron share authorization and task services.
- **Handle uncertain outcomes:** non-idempotent tasks with unknown results retain the `UNKNOWN` state and are reconciled against the Agent journal.

## How it works

```text
Web / MCP / Cron
       │
       ▼
 Authorization & task services ── PostgreSQL (business and task records)
       │                       └─ Redis (sessions, live cache and coordination)
       ▼
 Gateway / Worker
       │
       │  Ops initiates a TLS/WSS connection
       ▼
 Go Agent on each Linux node
```

Next.js provides the UI and API, the Gateway maintains Agent connections, and the Worker handles scheduling. See the [Agent documentation](agent/README.md) for installation, connection, and the task protocol.

## Deploy

Prepare a Linux server, Docker Compose v2, an external PostgreSQL 17 instance, a dedicated Redis logical database. Clone the repository and run from its root:

```sh
sudo python3 deploy/menu.py
```

Select “主控管理 → 启动” (Control plane → Start) to create configuration templates. Fill in `deploy/config/ops/app.conf` and `deploy/config/ops/compose.env`, then start again. Ops exposes HTTP on `127.0.0.1:8080`; use your existing HTTPS reverse proxy before signing in. No domain or Web certificate is required in Ops configuration. Ops and Agent configuration and data are stored separately. The standalone deployment archive in Releases includes the same menu. See the [deployment guide](docs/DEPLOYMENT.md).

## Connect a node

Download `pipker-agent-<version>-linux-amd64.tar.gz` or `arm64.tar.gz` and `SHA256SUMS` from the same [GitHub Release](https://github.com/holic512/PipkerOps/releases). Manually upload both to the same directory on the target Linux host. In the deployment menu, select “Agent 管理 → 安装／重新安装” (Agent → Install/reinstall) and enter the local archive path. The tool verifies and installs the package without downloading files or starting the service.

An Agent-only host needs Python 3, Linux, and systemd. Set its reachable HTTPS URL and start it; the Agent creates its own CA, server certificate, stable identity and access key. Export one connection file, import it in Ops, test and confirm. Managed updates are explicitly initiated from Ops, which downloads and verifies GitHub release artifacts before distribution. An Agent on the Ops host can perform Ops container updates.

See [Agent installation and protocol](agent/README.md) for commands and configuration.

## Documentation

| Document | Contents |
| --- | --- |
| [Deployment and operations](docs/DEPLOYMENT.md) | Configuration, container menu, versions, TLS, backup and recovery |
| [Development and validation](docs/DEVELOPMENT.md) | Local development, repository structure, tests, CI and validation boundaries |
| [API and MCP](docs/API.md) | Methods, authorization, tasks and structured output |
| [Database model and maintenance](docs/database.md) | Migrations, metric retention and capacity validation |
| [Agent](agent/README.md) | Installation, configuration, task protocol and upgrades |
| [Product direction](PRODUCT.md) · [Design guidelines](DESIGN.md) | Product goals and design conventions |

Use HTTPS/TLS in production. Real configuration, private keys, backups, and runtime state are not committed to the repository.

## License

[Apache License 2.0](LICENSE)
