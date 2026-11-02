"""校验并替换发布清单管理的部署程序，保留实际配置和运行数据。"""
# @file script_updates.py
# @project PipkerOps
# @module deployment/script-updates
# @description 发布脚本安全替换、冲突检查和失败恢复。
# @logic 全量预检后暂存；只处理清单程序；保留旧副本并在替换失败时恢复。
# @dependencies Python 3 standard library
# @index_tags updates, manifest, preservation
# @author holic512
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
import uuid


def managed_path(name):
    path = PurePosixPath(name)
    return not path.is_absolute() and '..' not in path.parts and str(path) == name and (name in ('VERSION', 'menu.py') or path.parts[0] in ('internal', 'script', 'resources'))


def load_manifest(raw):
    manifest = json.loads(raw)
    if manifest.get('format') != 1 or not isinstance(manifest.get('version'), str) or not isinstance(manifest.get('files'), dict):
        raise RuntimeError('部署脚本清单格式无效。')
    if not manifest['files'] or any(not managed_path(name) or not isinstance(digest, str) or len(digest) != 64 for name, digest in manifest['files'].items()):
        raise RuntimeError('部署脚本清单包含无效路径或摘要。')
    return manifest


def atomic_write(path, content, mode=0o600):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
            temporary = Path(file.name)
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        temporary.chmod(mode)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def update_scripts(root, package, expected):
    root = Path(root).resolve()
    marker = root / '.pipkerops-installation.json'
    installation = json.loads(marker.read_text())
    if installation.get('format') != 1 or installation.get('root') != str(root):
        raise RuntimeError('安装标记与指定部署目录不匹配。')
    package = Path(package)
    if hashlib.sha256(package.read_bytes()).hexdigest() != expected:
        raise RuntimeError('部署脚本归档 SHA-256 校验失败。')
    old = load_manifest((root / 'managed-files.json').read_text())
    prefix = 'pipkerops/deploy/'
    with tempfile.TemporaryDirectory(prefix='pipkerops-scripts-') as temporary:
        stage = Path(temporary)
        with tarfile.open(package, 'r:gz') as archive:
            members = {}
            for member in archive.getmembers():
                if member.name in members:
                    raise RuntimeError('发布包存在重复文件。')
                members[member.name] = member
            source = members.get(prefix + 'managed-files.json')
            if source is None or not source.isfile() or source.size > 1048576:
                raise RuntimeError('发布包缺少有效脚本清单。')
            new = load_manifest(archive.extractfile(source).read())
            if sum(m.size for m in members.values()) > 64 * 1024 * 1024:
                raise RuntimeError('部署脚本发布包过大。')
            conflicts = []
            for name in set(old['files']) | set(new['files']):
                destination = root / name
                if any(parent.is_symlink() for parent in [destination, *destination.parents] if parent != root.parent):
                    raise RuntimeError('部署目录含符号链接，拒绝替换。')
                if name in old['files'] and not destination.exists():
                    conflicts.append(name)
                if destination.exists():
                    if not destination.is_file() or name not in old['files'] or hashlib.sha256(destination.read_bytes()).hexdigest() != old['files'][name]:
                        conflicts.append(name)
            if conflicts:
                raise RuntimeError('以下程序文件有本地修改或路径冲突，未执行更新：' + '、'.join(sorted(conflicts)))
            for name, digest in new['files'].items():
                member = members.get(prefix + name)
                if member is None or not member.isfile():
                    raise RuntimeError('发布包缺少常规文件：' + name)
                content = archive.extractfile(member).read()
                if hashlib.sha256(content).hexdigest() != digest:
                    raise RuntimeError('发布包内部文件摘要不匹配：' + name)
                destination = stage / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(content)
        backup = root / 'data' / 'agent' / 'updates' / ('scripts-' + uuid.uuid4().hex)
        backup.mkdir(parents=True, mode=0o700)
        names = set(old['files']) | set(new['files']) | {'managed-files.json', '.pipkerops-installation.json'}
        existed = set()
        for name in names:
            source = root / name
            if source.is_file():
                existed.add(name)
                target = backup / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        try:
            for name in new['files']:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                atomic_write(target, (stage / name).read_bytes(), (backup / name).stat().st_mode & 0o777 if name in existed else 0o644)
            for name in set(old['files']) - set(new['files']):
                (root / name).unlink(missing_ok=True)
            atomic_write(root / 'managed-files.json', (json.dumps(new, indent=2) + '\n').encode(), 0o644)
            installation['scriptsVersion'] = new['version']
            atomic_write(marker, (json.dumps(installation, indent=2) + '\n').encode())
        except BaseException:
            for name in names:
                target = root / name
                if name in existed:
                    shutil.copy2(backup / name, target)
                else:
                    target.unlink(missing_ok=True)
            raise
    return {'version': new['version'], 'backup': str(backup)}
