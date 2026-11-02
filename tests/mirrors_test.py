import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.request import Request

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'deploy'))
from internal import mirrors


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.architecture = 'amd64'
        self.delay = 0
        self.redirect = False
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                fixture.requests.append((self.path, dict(self.headers)))
                if self.path.startswith('/token?'):
                    self.respond({'access_token': 'fixture-anonymous-token'})
                    return
                if self.headers.get('Authorization') != 'Bearer fixture-anonymous-token':
                    self.send_response(401)
                    self.send_header('WWW-Authenticate', f'Bearer realm="http://127.0.0.1:{self.server.server_port}/token",service="fixture",scope="repository:team/image:pull"')
                    self.end_headers()
                    return
                if self.path.endswith('/manifests/missing'):
                    self.send_error(404)
                elif self.path.endswith('/manifests/test'):
                    self.respond({'manifests': [
                        {'platform': {'os': 'linux', 'architecture': arch}, 'digest': 'sha256:' + arch}
                        for arch in ('amd64', 'arm64')
                    ]})
                elif '/manifests/' in self.path:
                    self.respond({'config': {'digest': 'sha256:config'}, 'layers': [{'digest': 'sha256:layer', 'size': mirrors.SAMPLE_BYTES * 2}]})
                elif self.path.endswith('/blobs/sha256:config'):
                    self.respond({'os': 'linux', 'architecture': fixture.architecture})
                elif self.path.endswith('/blobs/sha256:layer'):
                    time.sleep(fixture.delay)
                    if fixture.redirect:
                        self.send_response(307)
                        self.send_header('Location', f'http://127.0.0.1:{self.server.server_port}/redirected')
                        self.end_headers()
                    else:
                        # 刻意忽略 Range，客户端仍只能读取采样上限。
                        self.respond(b'x' * (mirrors.SAMPLE_BYTES * 2))
                else:
                    self.send_error(404)

            def respond(self, data):
                payload = data if isinstance(data, bytes) else json.dumps(data).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                try:
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)
        self.reference = f'127.0.0.1:{self.server.server_port}/team/image:test'

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_bearer_index_architecture_and_bounded_layer_sample(self):
        result = mirrors.probe(self.reference, 'linux/amd64')
        self.assertIsNone(result['error'], result)
        self.assertGreater(result['speed'], 0)
        paths = [path for path, _ in self.requests]
        self.assertTrue(any('/token?service=fixture&scope=repository%3Ateam%2Fimage%3Apull' == path for path in paths))
        self.assertIn('/v2/team/image/manifests/sha256:amd64', paths)
        layer = next(headers for path, headers in self.requests if path.endswith('/blobs/sha256:layer'))
        self.assertEqual(layer['Range'], f'bytes=0-{mirrors.SAMPLE_BYTES - 1}')
        self.architecture = 'arm64'
        self.assertIsNone(mirrors.probe(self.reference, 'linux/arm64')['error'])

    def test_wrong_architecture_missing_version_and_timeout(self):
        self.assertIn('没有', mirrors.probe(self.reference, 'linux/arm64')['error'])
        self.assertEqual(mirrors.probe(self.reference.replace(':test', ':missing'), 'linux/amd64')['error'], 'HTTP 404')
        self.delay = 0.1
        with patch.object(mirrors, 'REQUEST_TIMEOUT', 0.02):
            self.assertIn('超时', mirrors.probe(self.reference, 'linux/amd64')['error'])

    def test_single_manifest_also_checks_actual_architecture(self):
        reference = self.reference.replace(':test', ':single')
        self.assertIsNone(mirrors.probe(reference, 'linux/amd64')['error'])
        self.assertIn('没有', mirrors.probe(reference, 'linux/arm64')['error'])

    def test_redirect_never_forwards_registry_token_to_other_host(self):
        request = Request('https://registry.example/v2/image/blobs/sha256:test', headers={'Authorization': 'Bearer fixture-only', 'Range': 'bytes=0-10'})
        redirected = mirrors.RegistryRedirect().redirect_request(request, None, 307, 'redirect', {}, 'https://cdn.example/blob')
        self.assertFalse(redirected.has_header('Authorization'))
        self.assertEqual(redirected.get_header('Range'), 'bytes=0-10')


class MirrorSelectionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'mirrors.conf'

    def test_repository_mapping_and_custom_images_do_not_use_public_proxies(self):
        self.path.write_text('GHCR_MIRRORS="ghcr.nju.edu.cn, m.daocloud.io/ghcr.io"\nOPS_REPOSITORIES=registry.cn-hangzhou.aliyuncs.com/team/pipkerops\n')
        settings = mirrors.read_settings(self.path)
        refs = mirrors.candidates('ghcr.io/holic512/pipkerops:0.1.4', 'ops', settings)
        self.assertIn('ghcr.nju.edu.cn/holic512/pipkerops:0.1.4', refs)
        self.assertIn('m.daocloud.io/ghcr.io/holic512/pipkerops:0.1.4', refs)
        self.assertIn('registry.cn-hangzhou.aliyuncs.com/team/pipkerops:0.1.4', refs)
        proxy = mirrors.candidates('nginx:1.28-alpine-slim', 'proxy', settings)
        self.assertIn('m.daocloud.io/docker.io/library/nginx:1.28-alpine-slim', proxy)
        custom = 'private.example/team/pipkerops:0.1.4'
        self.assertEqual(mirrors.candidates(custom, 'ops', settings), [custom])

    def test_invalid_and_empty_settings(self):
        for value in ['OPS_REPOSITORIES=https://example.com/team/image', 'GHCR_MIRRORS=example.com/image:tag', 'UNKNOWN=value']:
            self.path.write_text(value)
            with self.assertRaises(RuntimeError):
                mirrors.read_settings(self.path)
        self.path.write_text('GHCR_MIRRORS=\n')
        self.assertEqual(mirrors.candidates('ghcr.io/holic512/pipkerops:test', 'ops', mirrors.read_settings(self.path)), ['ghcr.io/holic512/pipkerops:test'])

    def test_ranking_uses_transfer_speed_then_latency_and_rejects_failed_sources(self):
        results = [
            {'image': 'failed', 'speed': 0, 'latency': 0, 'error': 'HTTP 404'},
            {'image': 'slow-response', 'speed': 100, 'latency': 2, 'error': None},
            {'image': 'fast-response', 'speed': 100, 'latency': 1, 'error': None},
            {'image': 'slow-transfer', 'speed': 50, 'latency': 0.1, 'error': None},
        ]
        with patch.object(mirrors, 'candidates', return_value=[entry['image'] for entry in results]), patch.object(mirrors, 'probe', side_effect=lambda ref, _: next(entry for entry in results if entry['image'] == ref)), contextlib.redirect_stdout(io.StringIO()):
            ordered = mirrors.rank('ghcr.io/holic512/pipkerops:test', 'ops', {}, 'linux/amd64')
        self.assertEqual([entry['image'] for entry in ordered], ['fast-response', 'slow-response', 'slow-transfer'])

    def test_pull_failure_falls_back_and_private_repository_uses_docker_login(self):
        images = {'ops': 'ghcr.io/holic512/pipkerops:test', 'proxy': 'private.example/nginx:test'}
        def ranking(original, component, *_):
            return [{'image': 'fast.example/image:test'}, {'image': 'next.example/image:test'}] if component == 'ops' else [{'image': original}]
        def pull(command, **_):
            if command[-1] == 'fast.example/image:test':
                raise subprocess.CalledProcessError(1, command)
        with patch.object(mirrors, 'rank', side_effect=ranking), patch.object(mirrors.subprocess, 'run', side_effect=pull) as command, patch.object(mirrors, 'local_image', return_value=True), contextlib.redirect_stdout(io.StringIO()):
            selected = mirrors.prepare_images(images, self.path, 'linux/amd64')
        self.assertEqual(selected['ops'], 'next.example/image:test')
        self.assertEqual(selected['proxy'], images['proxy'])
        self.assertEqual(command.call_args_list[-1].args[0], ['docker', 'pull', '--platform', 'linux/amd64', images['proxy']])

    def test_exhausted_sources_fail_and_preloaded_images_skip_network(self):
        images = {'ops': 'ghcr.io/holic512/pipkerops:test'}
        with patch.object(mirrors, 'rank', return_value=[]), self.assertRaisesRegex(RuntimeError, '所有镜像源'):
            mirrors.prepare_images(images, self.path, 'linux/amd64')
        with patch.object(mirrors, 'rank') as rank, patch.object(mirrors, 'local_image', return_value=True), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(mirrors.prepare_images(images, self.path, 'linux/amd64', allow_local=True), images)
            rank.assert_not_called()


if __name__ == '__main__':
    unittest.main()
