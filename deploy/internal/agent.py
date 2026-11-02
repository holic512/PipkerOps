"""从人工上传的 Release 包安装 Agent，并管理本机 systemd 服务。"""
# @file agent.py
# @project PipkerOps
# @module deployment/agent
# @description 独立于主控配置的 Agent 本地安装与服务管理。
# @logic 核验本地归档及架构，复用包内安装脚本，按明确操作管理 systemd。
# @dependencies Python 3 standard library, Linux, systemd, Agent release package
# @index_tags deployment, agent, install, systemd
# @author holic512
import hashlib
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

UNIT = 'pipkerops-agent.service'
BINARY = Path('/usr/local/bin/pipker-agent')
DEPLOY_ROOT = Path(__file__).resolve().parent.parent
PACKAGE_FILES = ('pipker-agent', 'install.sh', 'pipkerops-agent.service', 'agent.env.example')


def main(action, package=None):
    try:
        require_host(action)
        state = service_state()
        if action == 'install':
            install(package, state)
        elif action == 'status':
            version = subprocess.check_output([str(BINARY), '--version'], text=True).strip() if BINARY.is_file() else '未安装'
            print(f'Agent 版本：{version}\n服务状态：{state.get("ActiveState", "unknown")}\n开机自启：{state.get("UnitFileState") or "未设置"}')
        elif action in ('export', 'reset-key'):
            environment = DEPLOY_ROOT / 'config' / 'agent' / 'agent.env'
            if not environment.is_file():
                raise RuntimeError('尚未创建 Agent 配置。')
            # systemd 读取同一文件；显式命令不通过 shell 执行其内容。
            values = {}
            import shlex
            for line in environment.read_text().splitlines():
                if line.strip() and not line.lstrip().startswith('#'):
                    key, value = line.split('=', 1)
                    values[key] = shlex.split(value)[0] if shlex.split(value) else ''
            argument = '--export-connection' if action == 'export' else '--reset-key'
            subprocess.run([str(BINARY), argument], check=True, env={**os.environ, **values})
        else:
            if state['LoadState'] == 'not-found':
                raise RuntimeError('尚未安装 Agent，请先上传安装包并执行安装。')
            commands = {'start': ['enable', '--now'], 'stop': ['stop'], 'restart': ['restart']}
            subprocess.run(['systemctl', *commands[action], UNIT], check=True)
    except (RuntimeError, OSError, ValueError, UnicodeError, subprocess.CalledProcessError, tarfile.TarError) as exc:
        print(f'Agent 操作失败：{exc}', file=sys.stderr)
        return 1
    return 0


def require_host(action):
    if platform.system() != 'Linux':
        raise RuntimeError('Agent 安装及服务管理仅支持 Linux。')
    if action not in ('install', 'status', 'start', 'stop', 'restart', 'export', 'reset-key'):
        raise RuntimeError('不支持的 Agent 操作。')
    if action != 'status' and os.geteuid() != 0:
        raise RuntimeError('请使用 sudo 或 root 执行此操作。')
    if not shutil.which('systemctl'):
        raise RuntimeError('需要 systemd 和 systemctl。')


def service_state():
    result = subprocess.run(['systemctl', 'show', UNIT, '--property=LoadState,ActiveState,UnitFileState', '--no-pager'], capture_output=True, text=True)
    state = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if state.get('LoadState') != 'not-found':
        result.check_returncode()
    if 'LoadState' not in state:
        raise RuntimeError('无法读取 systemd 服务状态，请确认 systemd 正在运行。')
    return state


def install(package, state):
    if state.get('ActiveState') not in (None, 'inactive', 'failed'):
        raise RuntimeError('Agent 服务正在运行或切换状态，请先通过菜单停止，再重新安装。')
    path, directory, arch = verify_package(package)
    with tempfile.TemporaryDirectory(prefix='pipkerops-agent-') as temporary:
        target = Path(temporary)
        with tarfile.open(path, 'r:gz') as archive:
            for name in PACKAGE_FILES:
                try:
                    member = archive.getmember(f'{directory}/{name}')
                except KeyError:
                    raise RuntimeError(f'安装包缺少必要文件：{name}') from None
                if not member.isfile():
                    raise RuntimeError(f'安装包中的 {name} 必须是常规文件。')
                # 只读取已知文件，不将归档中的路径或链接解压到文件系统。
                with archive.extractfile(member) as source, (target / name).open('wb') as destination:
                    shutil.copyfileobj(source, destination)
        verify_binary(target / 'pipker-agent', arch)
        subprocess.run(['sh', str(target / 'install.sh'), str(target / 'pipker-agent'), str(DEPLOY_ROOT)], check=True)
    print(f'安装完成。请检查 {DEPLOY_ROOT}/config/agent/agent.env 中的可达 HTTPS 地址，然后启动服务。\n状态保存在 data/agent，与 Ops 分离；启动后通过“导出接入文件”添加到 Ops。')


def verify_package(package):
    if not package:
        raise RuntimeError('请提供本地 Agent .tar.gz 安装包路径。')
    path = Path(package).expanduser().absolute()
    match = re.fullmatch(r'(pipker-agent-[a-zA-Z0-9.+_-]+-linux-(amd64|arm64))\.tar\.gz', path.name)
    if not match:
        raise RuntimeError('安装包名称应为 pipker-agent-<版本>-linux-amd64.tar.gz 或 arm64.tar.gz。')
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    if arch is None or match[2] != arch:
        raise RuntimeError(f'安装包架构 {match[2]} 与当前主机 {platform.machine()} 不匹配。')
    sums = path.parent / 'SHA256SUMS'
    entries = [line.split(maxsplit=1) for line in sums.read_text().splitlines()]
    hashes = [parts[0] for parts in entries if len(parts) == 2 and parts[1].lstrip('*') == path.name]
    if len(hashes) != 1 or not re.fullmatch(r'[0-9a-fA-F]{64}', hashes[0]):
        raise RuntimeError(f'SHA256SUMS 必须包含唯一有效的 {path.name} 校验条目。')
    with path.open('rb') as source:
        digest = hashlib.sha256()
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != hashes[0].lower():
        raise RuntimeError('安装包 SHA-256 校验失败，请重新上传同一 Release 的安装包和 SHA256SUMS。')
    return path, match[1], arch


def verify_binary(path, arch):
    with path.open('rb') as source:
        header = source.read(64)
    machine = {'amd64': 62, 'arm64': 183}[arch]
    if len(header) < 64 or header[:6] != b'\x7fELF\x02\x01' or int.from_bytes(header[18:20], 'little') != machine:
        raise RuntimeError('安装包中的二进制不是对应架构的 Linux ELF。')
