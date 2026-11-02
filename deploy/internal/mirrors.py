"""按目标镜像和 Docker 架构测速，选择并拉取公开镜像或显式指定的仓库。"""
# @file mirrors.py
# @project PipkerOps
# @module deployment/mirrors
# @description 镜像源映射、Registry manifest 和分层采样测速及 Docker 拉取回退。
# @logic 公共候选匿名测速；自定义镜像交给 Docker 认证；全部镜像就绪才返回选择结果。
# @dependencies Python 3 standard library, Docker Engine
# @index_tags deployment, registry, mirrors, install
# @author holic512
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import json
import re
import shlex
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

DEFAULTS = {
    'GHCR_MIRRORS': 'ghcr.nju.edu.cn,m.daocloud.io/ghcr.io',
    'DOCKER_HUB_MIRRORS': 'docker.nju.edu.cn,m.daocloud.io/docker.io,mirror.ccs.tencentyun.com',
    'OPS_REPOSITORIES': '',
    'NGINX_REPOSITORIES': '',
}
OFFICIAL = {'ops': 'ghcr.io/holic512/pipkerops', 'proxy': 'docker.io/library/nginx'}
SAMPLE_BYTES = 1024 * 1024
PROBE_TIMEOUT = 12
REQUEST_TIMEOUT = 4
PULL_TIMEOUT = 600
ACCEPT = ', '.join([
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
])


@dataclass(frozen=True)
class Image:
    registry: str
    repository: str
    suffix: str

    @property
    def base(self):
        return f'{self.registry}/{self.repository}'


def candidates(original, component, settings):
    image = parse_image(original)
    if image.base != OFFICIAL[component]:
        return [original]
    key = 'GHCR_MIRRORS' if image.registry == 'ghcr.io' else 'DOCKER_HUB_MIRRORS'
    repositories = [f'{prefix}/{image.repository}' for prefix in settings[key]]
    repositories += settings['OPS_REPOSITORIES' if component == 'ops' else 'NGINX_REPOSITORIES']
    return list(dict.fromkeys([original, *[base + image.suffix for base in repositories]]))


def rank(original, component, settings, platform):
    references = candidates(original, component, settings)
    if parse_image(original).base != OFFICIAL[component]:
        print(f'{component}: 使用显式仓库 {original}，不经过公共代理。', flush=True)
        return [{'image': original, 'speed': 0, 'latency': 0, 'error': None}]
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda ref: probe(ref, platform), references))
    results.sort(key=lambda result: (result['error'] is not None, -result['speed'], result['latency']))
    for result in results:
        detail = result['error'] or f"{result['speed'] / 1024:.0f} KiB/s，响应 {result['latency'] * 1000:.0f} ms"
        print(f"{component}: {result['image']} — {detail}", flush=True)
    return [result for result in results if result['error'] is None]


def prepare_images(images, config, platform, allow_local=False):
    settings = read_settings(config)
    selected = {}
    for component, original in images.items():
        if allow_local and local_image(original, platform):
            print(f'{component}: 使用已准备的本地镜像 {original}', flush=True)
            selected[component] = original
            continue
        for result in rank(original, component, settings, platform):
            reference = result['image']
            print(f'拉取 {reference}', flush=True)
            try:
                subprocess.run(['docker', 'pull', '--platform', platform, reference], check=True, timeout=PULL_TIMEOUT)
                if not local_image(reference, platform):
                    raise RuntimeError('拉取后未找到目标架构镜像。')
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired, RuntimeError):
                print(f'{reference} 拉取失败，尝试下一候选。', flush=True)
                continue
            selected[component] = reference
            break
        else:
            raise RuntimeError(f'{component} 所有镜像源均不可用；请检查 mirrors.conf、目标版本或 Docker 登录。')
    return selected


def local_image(reference, platform):
    result = subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', reference],
                            capture_output=True, text=True, check=False)
    return result.returncode == 0 and result.stdout.strip() == '/'.join(platform.split('/')[:2])


def probe(reference, platform):
    result = {'image': reference, 'speed': 0, 'latency': 0, 'error': None}
    started = time.monotonic()
    try:
        image = parse_image(reference)
        registry = Registry(image, started + PROBE_TIMEOUT)
        manifest = registry.manifest(image.suffix[1:])
        if 'manifests' in manifest:
            target = platform.split('/')
            match = next((entry for entry in manifest['manifests']
                          if entry.get('platform', {}).get('os') == target[0]
                          and entry.get('platform', {}).get('architecture') == target[1]
                          and (len(target) < 3 or entry.get('platform', {}).get('variant') == target[2])), None)
            if match is None:
                raise RuntimeError(f'没有 {platform} 镜像')
            manifest = registry.manifest(match['digest'])
        # 单架构 manifest 也必须核对 config，不能把其他架构当作可用。
        config = registry.json('blobs/' + manifest['config']['digest'])
        if f"{config.get('os')}/{config.get('architecture')}" != '/'.join(platform.split('/')[:2]):
            raise RuntimeError(f'没有 {platform} 镜像')
        layers = manifest['layers']
        layer = max(layers, key=lambda entry: entry['size'])
        with registry.request('blobs/' + layer['digest'], {'Range': f'bytes=0-{SAMPLE_BYTES - 1}'}) as response:
            result['latency'] = time.monotonic() - started
            sampling = time.monotonic()
            received = 0
            while received < SAMPLE_BYTES:
                if time.monotonic() >= registry.deadline:
                    raise TimeoutError()
                chunk = response.read(min(65536, SAMPLE_BYTES - received))
                if not chunk:
                    break
                received += len(chunk)
            if received != min(SAMPLE_BYTES, layer['size']):
                raise RuntimeError('镜像层采样不完整')
            result['speed'] = received / max(time.monotonic() - sampling, 0.001)
    except HTTPError as exc:
        result['error'] = f'HTTP {exc.code}'
        exc.close()
    except (TimeoutError, URLError, OSError):
        result['error'] = '连接失败或测速超时'
    except (RuntimeError, ValueError, KeyError, IndexError, StopIteration, TypeError) as exc:
        result['error'] = str(exc) if isinstance(exc, RuntimeError) else '镜像响应格式无效'
    return result


class Registry:
    def __init__(self, image, deadline):
        self.image = image
        host = 'registry-1.docker.io' if image.registry == 'docker.io' else image.registry
        scheme = 'http' if host.split(':')[0] in ('127.0.0.1', 'localhost') else 'https'
        self.base = f'{scheme}://{host}/v2/{image.repository}/'
        self.deadline = deadline
        self.token = None
        self.opener = build_opener(RegistryRedirect())

    def manifest(self, reference):
        return self.json('manifests/' + reference, {'Accept': ACCEPT})

    def json(self, path, headers=None):
        with self.request(path, headers) as response:
            return json.loads(response.read(1024 * 1024))

    def request(self, path, headers=None):
        request = Request(self.base + path, headers=headers or {})
        if self.token:
            request.add_header('Authorization', 'Bearer ' + self.token)
        try:
            return self.open(request)
        except HTTPError as exc:
            challenge = exc.headers.get('WWW-Authenticate', '')
            if exc.code != 401 or not challenge.lower().startswith('bearer '):
                raise
            exc.close()
            fields = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
            realm = fields.pop('realm', '')
            address = urlsplit(realm)
            if address.scheme != 'https' and not (address.scheme == 'http' and address.hostname in ('127.0.0.1', 'localhost')):
                raise RuntimeError('Registry 认证地址必须使用 HTTPS')
            separator = '&' if address.query else '?'
            with self.open(Request(realm + separator + urlencode(fields))) as response:
                payload = json.loads(response.read(65536))
            self.token = payload.get('token') or payload['access_token']
            request.add_header('Authorization', 'Bearer ' + self.token)
            return self.open(request)

    def open(self, request):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        return self.opener.open(request, timeout=min(REQUEST_TIMEOUT, remaining))


class RegistryRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(request, fp, code, msg, headers, newurl)
        if redirected is not None and urlsplit(request.full_url).netloc != urlsplit(newurl).netloc:
            redirected.remove_header('Authorization')
        return redirected


def parse_image(reference):
    if not re.fullmatch(r'[a-zA-Z0-9_./:@-]+', reference) or '://' in reference:
        raise RuntimeError('镜像地址不能包含协议、空格或登录凭据。')
    if '@' in reference:
        base, digest = reference.rsplit('@', 1)
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
            raise RuntimeError('镜像 digest 无效。')
        suffix = '@' + digest
    elif ':' in reference.rsplit('/', 1)[-1]:
        base, tag = reference.rsplit(':', 1)
        suffix = ':' + tag
    else:
        base, suffix = reference, ':latest'
    first, separator, rest = base.partition('/')
    if separator and ('.' in first or ':' in first or first == 'localhost'):
        registry, repository = first, rest
    else:
        registry, repository = 'docker.io', base
    if registry in ('index.docker.io', 'registry-1.docker.io'):
        registry = 'docker.io'
    if registry == 'docker.io' and '/' not in repository:
        repository = 'library/' + repository
    if not re.fullmatch(r'[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*', repository):
        raise RuntimeError('镜像仓库路径无效。')
    return Image(registry, repository, suffix)


def read_settings(path):
    values = dict(DEFAULTS)
    if path.is_file():
        for line in path.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            key, separator, value = line.partition('=')
            key = key.strip()
            if not separator or key not in DEFAULTS:
                raise RuntimeError('mirrors.conf 含未知配置项或无效行。')
            values[key] = ' '.join(shlex.split(value, comments=True))
    settings = {key: [part.strip().rstrip('/') for part in value.split(',') if part.strip()] for key, value in values.items()}
    for prefixes in settings.values():
        for prefix in prefixes:
            # 所有配置项都是不带版本的仓库或代理前缀。
            parsed = parse_image(prefix)
            if parsed.suffix != ':latest' or '@' in prefix or ':' in prefix.rsplit('/', 1)[-1]:
                raise RuntimeError('mirrors.conf 地址不能包含版本或 digest。')
    return settings
