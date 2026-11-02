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
       │                       └─ Redis (temporary coordination and rate limits)
       ▼
 Gateway / Worker
       │
       │  Agent initiates a TLS connection
       ▼
 Go Agent on each Linux node
```

Next.js provides the UI and API, the Gateway maintains Agent connections, and the Worker handles scheduling. See the [Agent documentation](agent/README.md) for installation, enrollment, and the task protocol.

## Deploy

Prepare a Linux server, Docker Compose v2, an external PostgreSQL 17 instance, a dedicated Redis logical database, and a Web HTTPS certificate. Clone the repository and run from its root:

```sh
sudo sh deploy/menu.sh
```

1. Select “安装” (Install) to create the configuration template.
2. Fill in `deploy/config/app.conf` and place `fullchain.pem` and `privkey.pem` in `deploy/certs/web`.
3. Select “安装” again to pull images, initialize, and start the services.

Host paths and versions are configured in `deploy/compose.env`; application credentials belong in the mapped configuration. After changing `deploy/config/app.conf`, select “重启并重读配置” (Restart and reload configuration). Switching to an empty database runs migrations and administrator initialization; switching configuration does not migrate data.

See the [deployment guide](docs/DEPLOYMENT.md) for permissions, private image registry login, recovery, and full instructions.

## Connect a node

Download the Linux amd64 or arm64 Agent package and `SHA256SUMS` from [GitHub Releases](https://github.com/holic512/PipkerOps/releases), verify the package, and install it. Create an enrollment token in the management interface, provide the control-plane CA public certificate to the node through a trusted channel, configure the Agent, and approve enrollment. Releases also include raw binaries for online upgrades.

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
