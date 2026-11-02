"""部署路径、配置副本及 Docker Compose 操作。"""
# @file core.py
# @project PipkerOps
# @module deployment/core
# @description 独立部署的配置同步和容器操作。
# @logic 按脚本位置解析路径，启动前同步用户配置并执行初始化。
# @dependencies Python 3, Docker Compose v2
# @index_tags deployment, compose, config
# @author holic512
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / 'config'
DATA = ROOT / 'data'
RESOURCES = ROOT / 'resources'
SERVICES = ['web', 'gateway', 'worker', 'proxy', 'init']


def prepare():
    for path in (CONFIG, ROOT / 'certs' / 'web', DATA / 'config', DATA / 'certs' / 'web', DATA / 'pki', DATA / 'backups'):
        path.mkdir(parents=True, exist_ok=True)
    created = []
    for source, target in ((RESOURCES / 'app.conf.example', CONFIG / 'app.conf'),
                           (RESOURCES / 'compose.env.example', CONFIG / 'compose.env')):
        if not target.exists():
            shutil.copyfile(source, target)
            target.chmod(0o600)
            created.append(target)
    if created:
        raise RuntimeError('已创建配置模板：' + '、'.join(map(str, created)) + '。请填写配置，并在 certs/web 放置 fullchain.pem 和 privkey.pem 后重新运行。')


def sync():
    pairs = [(CONFIG / 'app.conf', DATA / 'config' / 'app.conf'),
             (CONFIG / 'compose.env', DATA / 'compose.env')]
    pairs += [(p, DATA / 'certs' / 'web' / p.name) for p in (ROOT / 'certs' / 'web' / 'fullchain.pem', ROOT / 'certs' / 'web' / 'privkey.pem')]
    # 允许应用配置引用同目录下的 CA 文件。
    pairs += [(p, DATA / 'config' / p.name) for p in CONFIG.iterdir() if p.is_file() and p.name not in ('app.conf', 'compose.env')]
    for source, _ in pairs:
        if not source.is_file():
            raise RuntimeError(f'缺少必要配置文件：{source}')
    for source, target in pairs:
        digest = lambda p: hashlib.sha256(p.read_bytes()).digest()
        if not target.exists() or digest(source) != digest(target):
            shutil.copyfile(source, target)
            target.chmod(0o600)
        if os.geteuid() == 0 and target.parent == DATA / 'config':
            os.chown(target, 10001, 10001)
    if os.geteuid() == 0:
        for path in (DATA / 'config', DATA / 'pki', DATA / 'backups'):
            os.chown(path, 10001, 10001)


def compose(*args, version=None):
    env = os.environ.copy()
    env.update(DEPLOY_CONFIG=str(DATA / 'config'), DEPLOY_DATA=str(DATA), DEPLOY_TLS=str(DATA / 'certs' / 'web'), DEPLOY_NGINX=str(RESOURCES / 'nginx.conf'))
    if version:
        env['PIPKEROPS_VERSION'] = version
    subprocess.run(['docker', 'compose', '--project-directory', str(ROOT), '--env-file', str(DATA / 'compose.env'), '-f', str(RESOURCES / 'compose.yaml'), *args], check=True, env=env)


def start():
    compose('config', '--quiet')
    compose('up', '--no-deps', '--force-recreate', '--exit-code-from', 'init', 'init')
    compose('up', '-d', '--wait', '--wait-timeout', '120', 'web', 'gateway', 'worker', 'proxy')
    print('PipkerOps 已启动。')


def run(action, version=None):
    prepare()
    if action in ('start', 'restart', 'update'):
        sync()
    elif not (DATA / 'compose.env').is_file():
        raise RuntimeError('尚未启动：请先执行启动操作以创建运行配置。')
    if action == 'status':
        print(f'配置：{CONFIG}\n运行数据：{DATA}', flush=True)
        compose('ps', '-a')
        compose('images')
    elif action == 'stop':
        compose('stop', *SERVICES)
    elif action == 'start':
        start()
    elif action == 'restart':
        compose('config', '--quiet')
        compose('stop', *SERVICES)
        start()
    elif action == 'update':
        if not version or not re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_.-]*', version):
            raise RuntimeError('请提供有效的镜像版本，例如 0.1.0 或 edge。')
        compose('config', '--quiet', version=version)
        compose('pull', 'web', version=version)
        compose('stop', *SERVICES)
        path = CONFIG / 'compose.env'
        lines = path.read_text().splitlines()
        lines = [line for line in lines if not line.startswith('PIPKEROPS_VERSION=')]
        path.write_text('\n'.join(lines + [f'PIPKEROPS_VERSION={version}']) + '\n')
        sync()
        start()


def main(action, version=None):
    try:
        run(action, version)
    except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        print(f'操作失败：{exc}', file=__import__('sys').stderr)
        return 1
    return 0
