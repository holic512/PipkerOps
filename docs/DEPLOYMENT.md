# 独立部署

从 GitHub Release 下载 `pipkerops-deploy-<Ops版本>.tar.gz` 和同一 Release 的 `SHA256SUMS`，校验后解压。包内的 `pipkerops/deploy` 目录可以复制到任意位置；从源码使用时则是仓库的 `deploy` 目录。以下命令在该目录中执行，脚本也支持通过绝对路径从其他目录调用。

```sh
sudo python3 menu.py
```

一级菜单选择“主控管理”或“Agent 管理”。主控部署需要 Python 3、Docker、Docker Compose v2、外部 PostgreSQL 17、独立 Redis 逻辑库和 Web HTTPS 证书；仅管理 Agent 则需要 Python 3、Linux 和 systemd，无需 Docker，也不会生成主控配置。

## 主控管理

首次选择“主控管理 → 启动”会创建 `config/app.conf` 和 `config/compose.env` 模板及 `certs/web` 目录，并提示先完成配置。填写数据库、Redis、域名及管理员配置，将 Web 证书 `fullchain.pem` 和 `privkey.pem` 放入 `certs/web`，然后再次执行启动。数据库和 Redis 必须预先可用。私有镜像仓库请事先使用执行部署命令的同一账户完成 `docker login ghcr.io`。

`config/` 和 `certs/` 是用户维护的配置来源。启动、重启、更新时脚本比较 SHA-256 并同步到 `data/` 下的运行副本；PKI 和备份也保存在 `data/`。不要直接修改运行副本。更改配置后执行重启。切换数据库不会迁移原有数据。本部署方式只面向全新部署，不自动迁移旧版数据。

```sh
sudo python3 script/status.py   # 查看服务和镜像
sudo python3 script/start.py    # 初始化并启动
sudo python3 script/stop.py     # 停止
sudo python3 script/restart.py  # 同步配置并重启
sudo python3 script/update.py 0.1.2  # 拉取指定版本并更新
```

更新会先拉取镜像，成功后才停止服务并执行初始化；初始化失败时不会自动回滚数据库。请自行维护数据库和 `data/` 的备份。日志可使用 Docker Compose 或 Docker 命令查看。

## Agent 管理

1. 根据目标节点架构，从同一 GitHub Release 下载 Agent `.tar.gz` 安装包和 `SHA256SUMS`。`uname -m` 为 `x86_64` 时选择 amd64，为 `aarch64` 或 `arm64` 时选择 arm64。Release 标题分别显示 Ops、Agent、Skill 版本，下载 Agent 包时使用其中的 Agent 版本。
2. 人工将这两个文件上传到目标 Linux 主机的同一目录，保留原文件名。例如 `/tmp/pipkerops-upload/pipker-agent-0.1.0-linux-amd64.tar.gz` 和 `/tmp/pipkerops-upload/SHA256SUMS`。只需上传对应架构的安装包，不需要下载其他附件。
3. 在该主机运行菜单，选择“Agent 管理 → 安装／重新安装”，输入本地安装包路径。工具检查 SHA-256、包内必要文件和 ELF 架构，再调用包内安装脚本。正在运行的 Agent 必须先停止才能重装。
4. 填写 `/etc/pipkerops/agent.env`，保留 0600 权限；通过安全编辑器准备权限为 0600 的 `/etc/pipkerops/enrollment.token`，并通过可信渠道提供主控 CA 公钥证书 `/etc/pipkerops/ca.pem`。配置细节见源码仓库的 `agent/README.md`。
5. 选择“启动并设为开机自启”，然后在主控审批节点。可用 `sudo journalctl -u pipkerops-agent -f` 查看注册和连接日志。

安装不会自动启动服务，重装保留已有配置和 `/var/lib/pipkerops-agent` 状态。菜单提供查看版本、服务状态、开机自启状态，以及停止和重启操作。“停止”保留开机自启设置；如需取消，可手工执行 `sudo systemctl disable pipkerops-agent`。

对应的独立命令为：

```sh
sudo python3 script/agent.py install /tmp/pipkerops-upload/pipker-agent-0.1.0-linux-amd64.tar.gz
python3 script/agent.py status
sudo python3 script/agent.py start    # 启动并设为开机自启
sudo python3 script/agent.py stop
sudo python3 script/agent.py restart
```

主控和 Agent 可以位于不同主机。目标节点需要部署目录中的菜单及 Python 模块，也可以继续使用 Agent 安装包自带的 `install.sh` 手工安装。原始 ELF 附件用于平台在线升级，不是此菜单接收的 `.tar.gz` 安装包。
