"""独立安装 Ops，管理配置副本及 Docker Compose 服务生命周期。"""
# @file core.py
# @project PipkerOps
# @module deployment/core
# @description 分离 Ops 安装、镜像准备和已有部署的服务管理。
# @logic 安装准备配置及镜像后登记；启动只用本地镜像；更新先拉取成功再停止服务。
# @dependencies Python 3, Docker Compose v2, deployment mirrors
# @index_tags deployment, compose, config, install
# @author holic512
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

from internal import mirrors

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / 'config' / 'ops'
DATA = ROOT / 'data' / 'ops'
RESOURCES = ROOT / 'resources'
SERVICES = ['web', 'gateway', 'worker', 'proxy', 'init']
DATA_DIRECTORIES = ('config', 'credentials', 'backups', 'releases', 'updates')
LEGACY_KEYS = {'APP_ORIGIN', 'ALLOW_INSECURE_BACKENDS', 'GATEWAY_PUBLIC_URL', 'ENROLL_PUBLIC_URL',
               'GATEWAY_HOST', 'GATEWAY_BIND', 'GATEWAY_PORT', 'ENROLL_PORT', 'PKI_DIR', 'PKI_HOSTS',
               'GATEWAY_TLS_CERT', 'GATEWAY_TLS_KEY'}


def run(action, version=None):
    if action == 'install':
        install()
        return
    if action not in ('status', 'start', 'stop', 'restart', 'update', 'mirrors'):
        raise RuntimeError('未知主控操作。')
    if not installed():
        if action == 'status':
            print('Ops 尚未安装，请先执行“安装 Ops”。')
            return
        raise RuntimeError('Ops 尚未安装，请先执行“安装 Ops”。')
    if action == 'update' and (not version or not re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}', version)):
        raise RuntimeError('请提供有效的镜像版本，例如 0.1.4 或 edge。')
    source = DATA / 'compose.env' if action in ('status', 'stop') and (DATA / 'compose.env').is_file() else CONFIG / 'compose.env'
    settings = configuration(version=version if action == 'update' else None, source=source)
    originals = configured_images(settings)
    images = selected_images(originals)
    if action == 'status':
        print(f'配置：{CONFIG}\n运行数据：{DATA}', flush=True)
        for component, reference in images.items():
            print(f'{component} 镜像：{reference}', flush=True)
        compose('ps', '-a', images=images, source=source)
        compose('images', images=images, source=source)
    elif action == 'stop':
        compose('stop', *SERVICES, images=images, source=source)
    elif action == 'mirrors':
        platform = docker_platform()
        candidates = mirrors.read_settings(CONFIG / 'mirrors.conf')
        available = [mirrors.rank(original, component, candidates, platform) for component, original in originals.items()]
        if not all(available):
            raise RuntimeError('部分镜像没有可用源，请检查 mirrors.conf 和目标版本。')
        print('测速完成；安装或更新时自动使用最快可用源。当前服务及镜像选择未修改。')
    elif action == 'update':
        images = mirrors.prepare_images(originals, CONFIG / 'mirrors.conf', docker_platform())
        # 失败的拉取不会改写版本、选源结果或停止正在运行的服务。
        compose('stop', *SERVICES, images=images, version=version)
        replace_version(version)
        sync()
        save_images(originals, images)
        start(images)
    else:
        require_local_images(images)
        sync()
        compose('config', '--quiet', images=images)
        if action == 'restart':
            compose('stop', *SERVICES, images=images)
        start(images)


def install():
    installed()
    platform = docker_platform()
    previous = next((path for path in (DATA / 'compose.env', CONFIG / 'compose.env', ROOT / 'config/compose.env') if path.is_file()), None)
    if previous and compose('ps', '--status', 'running', '--quiet', source=previous, capture=True).stdout.strip():
        raise RuntimeError('Ops 服务正在运行，请先停止，再重新安装。')
    created = prepare()
    originals = configured_images(configuration())
    images = mirrors.prepare_images(originals, CONFIG / 'mirrors.conf', platform, allow_local=True)
    sync()
    save_images(originals, images)
    register_installation('ops')
    if created:
        print('已生成配置：' + '、'.join(map(str, created)), flush=True)
    print(f'Ops 安装完成，尚未启动。请编辑 {CONFIG / "app.conf"} 和 {CONFIG / "compose.env"}，然后单独执行“启动”。')


def register_installation(component):
    marker = ROOT / '.pipkerops-installation.json'
    record = json.loads(marker.read_text()) if marker.exists() else {'format': 1, 'root': str(ROOT), 'components': []}
    if record.get('root') != str(ROOT) or record.get('format') != 1:
        raise RuntimeError('部署目录标记不匹配，拒绝使用。')
    record['components'] = sorted(set(record['components'] + [component]))
    record['scriptsVersion'] = (ROOT / 'VERSION').read_text().strip()
    atomic_write(marker, json.dumps(record, indent=2) + '\n')


def installed():
    marker = ROOT / '.pipkerops-installation.json'
    if not marker.is_file():
        return False
    record = json.loads(marker.read_text())
    if record.get('format') != 1 or record.get('root') != str(ROOT):
        raise RuntimeError('部署目录标记不匹配，拒绝使用。')
    return 'ops' in record.get('components', [])


def prepare():
    for path in (CONFIG, *(DATA / name for name in DATA_DIRECTORIES)):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    created = []
    for name in ('app.conf', 'compose.env', 'mirrors.conf'):
        target = CONFIG / name
        if target.exists():
            continue
        legacy = ROOT / 'config' / name
        if legacy.is_file():
            lines = [line for line in legacy.read_text().splitlines()
                     if line.split('=', 1)[0].strip().lstrip('#').strip() not in LEGACY_KEYS]
            if name == 'compose.env':
                lines = [line for line in lines if line.split('=', 1)[0].strip() not in {'WEB_BIND', 'WEB_PORT'}]
                lines += ['WEB_BIND=127.0.0.1', 'WEB_PORT=8080']
            atomic_write(target, '\n'.join(lines) + '\n')
        else:
            shutil.copyfile(RESOURCES / (name + '.example'), target)
            target.chmod(0o600)
        created.append(target)
    return created


def sync():
    pairs = [(CONFIG / 'app.conf', DATA / 'config' / 'app.conf'),
             (CONFIG / 'compose.env', DATA / 'compose.env')]
    # 仅应用配置和引用的 CA 文件进入容器运行副本。
    pairs += [(p, DATA / 'config' / p.name) for p in CONFIG.iterdir()
              if p.is_file() and p.name not in ('app.conf', 'compose.env', 'mirrors.conf')]
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
        for path in (DATA, *(DATA / name for name in DATA_DIRECTORIES)):
            os.chown(path, 10001, 10001)


def compose(*args, version=None, images=None, source=None, capture=False):
    env = os.environ.copy()
    env.update(DEPLOY_CONFIG=str(DATA / 'config'), DEPLOY_DATA=str(DATA), DEPLOY_NGINX=str(RESOURCES / 'nginx.conf'))
    if version:
        env['PIPKEROPS_VERSION'] = version
    if images:
        # 选源结果只覆盖本次 Compose 参数，原始仓库配置保留。
        env['PIPKEROPS_IMAGE'], env['PIPKEROPS_VERSION'] = images['ops'].rsplit(':', 1)
        env['PIPKEROPS_PROXY_IMAGE'] = images['proxy']
    return subprocess.run(['docker', 'compose', '--project-directory', str(ROOT), '--env-file', str(source or CONFIG / 'compose.env'),
                           '-f', str(RESOURCES / 'compose.yaml'), *args], check=True, env=env,
                          capture_output=capture, text=True)


def configuration(version=None, source=None):
    return json.loads(compose('config', '--format', 'json', version=version, source=source, capture=True).stdout)


def configured_images(settings):
    return {'ops': settings['services']['web']['image'], 'proxy': settings['services']['proxy']['image']}


def docker_platform():
    if not shutil.which('docker'):
        raise RuntimeError('请先安装 Docker Engine 和 Docker Compose；本工具只安装 Ops。')
    subprocess.run(['docker', 'compose', 'version'], check=True, capture_output=True)
    result = subprocess.run(['docker', 'info', '--format', '{{.OSType}}/{{.Architecture}}'], check=True, capture_output=True, text=True)
    system, arch = result.stdout.strip().split('/', 1)
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(arch, arch)
    if system != 'linux' or arch not in ('amd64', 'arm64'):
        raise RuntimeError('Ops 镜像需要 linux/amd64 或 linux/arm64 Docker Engine。')
    return f'{system}/{arch}'


def selected_images(originals):
    path = DATA / 'image-sources.json'
    if not path.is_file():
        return originals
    record = json.loads(path.read_text())
    return {component: record['selected'][component] if record.get('originals', {}).get(component) == reference else reference
            for component, reference in originals.items()}


def save_images(originals, images):
    atomic_write(DATA / 'image-sources.json', json.dumps({'format': 1, 'originals': originals, 'selected': images}, indent=2) + '\n')


def require_local_images(images):
    platform = docker_platform()
    for reference in images.values():
        if not mirrors.local_image(reference, platform):
            raise RuntimeError(f'缺少本地镜像 {reference}，请先停止服务并执行“安装 Ops”，或通过“更新”准备目标版本。')


def start(images):
    compose('up', '--pull', 'never', '--no-build', '--no-deps', '--force-recreate', '--exit-code-from', 'init', 'init', images=images)
    compose('up', '--pull', 'never', '--no-build', '-d', '--wait', '--wait-timeout', '120', 'web', 'gateway', 'worker', 'proxy', images=images)
    print('PipkerOps 已启动。HTTP 页面可访问，业务接口要求外部 HTTPS；代理配置示例见 resources/reverse-proxy.conf.example。')


def replace_version(version):
    path = CONFIG / 'compose.env'
    text, count = re.subn(r'(?m)^(\s*PIPKEROPS_VERSION\s*=\s*)("[^"]*"|\'[^\']*\'|[^\s#]*)([^\r\n]*)',
                         lambda match: match[1] + (match[2][0] + version + match[2][0] if match[2].startswith(('"', "'")) else version) + match[3], path.read_text())
    if not count:
        text = text.rstrip('\n') + f'\nPIPKEROPS_VERSION={version}\n'
    atomic_write(path, text)


def atomic_write(path, text):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(text)
    temporary.chmod(0o600)
    temporary.replace(path)


def main(action, version=None):
    try:
        run(action, version)
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as exc:
        # Compose 配置解析错误可能包含配置值；不回显捕获的 stdout/stderr。
        print(f'操作失败：{exc}', file=__import__('sys').stderr)
        return 1
    return 0
