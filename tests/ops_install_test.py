import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'deploy'))
from internal import core
import menu


class OpsLifecycleTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / 'config/ops'
        self.data = self.root / 'data/ops'
        shutil.copytree(ROOT / 'deploy/resources', self.root / 'resources')
        (self.root / 'VERSION').write_text('0.1.1\n')
        for key, value in {'ROOT': self.root, 'CONFIG': self.config, 'DATA': self.data, 'RESOURCES': self.root / 'resources'}.items():
            self.enterContext(patch.object(core, key, value))
        self.enterContext(patch.object(core, 'docker_platform', return_value='linux/amd64'))
        self.enterContext(patch.object(core.os, 'geteuid', return_value=501))
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))
        self.images = {'ops': 'ghcr.io/holic512/pipkerops:0.1.4', 'proxy': 'nginx:1.28-alpine-slim'}
        self.commands = []
        self.running = ''
        def compose(*args, **kwargs):
            self.commands.append((args, kwargs))
            if args == ('config', '--format', 'json'):
                return subprocess.CompletedProcess([], 0, json.dumps({'services': {'web': {'image': self.images['ops']}, 'proxy': {'image': self.images['proxy']}}}))
            return subprocess.CompletedProcess([], 0, self.running)
        self.enterContext(patch.object(core, 'compose', side_effect=compose))

    def installed(self):
        core.prepare()
        core.sync()
        core.register_installation('ops')

    def test_status_and_service_operations_never_install_implicitly(self):
        core.run('status')
        self.assertFalse(self.config.exists())
        self.assertFalse(self.data.exists())
        self.assertFalse(self.commands)
        for action in ('start', 'stop', 'restart', 'update', 'mirrors'):
            with self.assertRaisesRegex(RuntimeError, '尚未安装'):
                core.run(action, '0.1.4')
        self.assertFalse((self.root / '.pipkerops-installation.json').exists())

    def test_install_creates_templates_prepares_images_and_registers_without_starting(self):
        with patch.object(core.mirrors, 'prepare_images', return_value=self.images) as prepare:
            core.run('install')
        self.assertTrue(core.installed())
        self.assertTrue((self.config / 'mirrors.conf').is_file())
        self.assertEqual((self.config / 'app.conf').stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.data / 'config/mirrors.conf').exists())
        self.assertEqual(json.loads((self.data / 'image-sources.json').read_text())['selected'], self.images)
        self.assertTrue(prepare.call_args.kwargs['allow_local'])
        self.assertFalse(any(args[0] in ('up', 'run', 'stop') for args, _ in self.commands))

    def test_failed_install_is_not_registered_and_retry_preserves_config_and_agent(self):
        core.register_installation('agent')
        with patch.object(core.mirrors, 'prepare_images', side_effect=RuntimeError('pull failed')), self.assertRaisesRegex(RuntimeError, 'pull failed'):
            core.run('install')
        self.assertFalse(core.installed())
        original = (self.config / 'app.conf').read_bytes() + b'\n# user configuration\n'
        (self.config / 'app.conf').write_bytes(original)
        (self.data / 'credentials/sentinel').write_text('preserved')
        with patch.object(core.mirrors, 'prepare_images', return_value=self.images):
            core.run('install')
        self.assertEqual((self.config / 'app.conf').read_bytes(), original)
        self.assertEqual((self.data / 'credentials/sentinel').read_text(), 'preserved')
        self.assertEqual(json.loads((self.root / '.pipkerops-installation.json').read_text())['components'], ['agent', 'ops'])

    def test_running_reinstall_rejected_before_changes(self):
        self.installed()
        self.running = 'running-container-id\n'
        before = (self.config / 'app.conf').read_bytes()
        with patch.object(core, 'prepare') as prepare, patch.object(core.mirrors, 'prepare_images') as pull, self.assertRaisesRegex(RuntimeError, '先停止'):
            core.run('install')
        prepare.assert_not_called()
        pull.assert_not_called()
        self.assertEqual((self.config / 'app.conf').read_bytes(), before)

    def test_start_and_restart_require_local_images_and_disable_pulls(self):
        self.installed()
        with patch.object(core.mirrors, 'local_image', return_value=True), patch.object(core.mirrors, 'prepare_images') as pull:
            for action in ('start', 'restart'):
                core.run(action)
        pull.assert_not_called()
        starts = [args for args, _ in self.commands if args[0] == 'up']
        self.assertEqual(len(starts), 4)
        for args in starts:
            self.assertEqual(args[args.index('--pull') + 1], 'never')
            self.assertIn('--no-build', args)
        self.commands.clear()
        with patch.object(core.mirrors, 'local_image', return_value=False), self.assertRaisesRegex(RuntimeError, '缺少本地镜像'):
            core.run('restart')
        self.assertFalse(any(args[0] == 'stop' for args, _ in self.commands))

    def test_update_pull_failure_keeps_running_service_version_and_selection(self):
        self.installed()
        core.save_images(self.images, self.images)
        before = {path: path.read_bytes() for path in (self.config / 'compose.env', self.data / 'compose.env', self.data / 'image-sources.json')}
        with patch.object(core.mirrors, 'prepare_images', side_effect=RuntimeError('no usable source')), self.assertRaises(RuntimeError):
            core.run('update', '0.1.5')
        self.assertFalse(any(args[0] == 'stop' for args, _ in self.commands))
        self.assertEqual(before, {path: path.read_bytes() for path in before})

    def test_version_update_preserves_order_comments_and_runtime_sources(self):
        self.installed()
        original = '# before\nPIPKEROPS_IMAGE=ghcr.io/holic512/pipkerops\nPIPKEROPS_VERSION="0.1.4" # keep this\nWEB_PORT=8080\n'
        (self.config / 'compose.env').write_text(original)
        self.images['ops'] = 'ghcr.io/holic512/pipkerops:0.1.5'
        selected = {'ops': 'ghcr.nju.edu.cn/holic512/pipkerops:0.1.5', 'proxy': self.images['proxy']}
        with patch.object(core.mirrors, 'prepare_images', return_value=selected):
            core.run('update', '0.1.5')
        self.assertEqual((self.config / 'compose.env').read_text(), original.replace('0.1.4', '0.1.5'))
        self.assertEqual(core.selected_images(self.images), selected)
        changed = {**self.images, 'ops': 'private.example/image:0.1.5'}
        self.assertEqual(core.selected_images(changed)['ops'], changed['ops'])

    def test_benchmark_does_not_change_selection_or_services(self):
        self.installed()
        with patch.object(core.mirrors, 'rank', return_value=[{'image': 'fixture'}]) as rank:
            core.run('mirrors')
        self.assertEqual(rank.call_count, 2)
        self.assertFalse((self.data / 'image-sources.json').exists())
        self.assertFalse(any(args[0] in ('up', 'stop', 'pull') for args, _ in self.commands))

    def test_status_and_stop_use_runtime_configuration_without_syncing_edits(self):
        self.installed()
        runtime = (self.data / 'compose.env').read_bytes()
        (self.config / 'compose.env').write_text('COMPOSE_PROJECT_NAME=edited-project\n')
        for action in ('status', 'stop'):
            core.run(action)
        self.assertEqual((self.data / 'compose.env').read_bytes(), runtime)
        for _, kwargs in self.commands:
            self.assertEqual(kwargs['source'], self.data / 'compose.env')

    def test_ops_menu_routes_install_start_update_and_benchmark_separately(self):
        with patch('builtins.input', side_effect=['1', '3', '6', '0.1.5', '7', '0']), patch.object(menu, 'control_main') as operation:
            menu.control_menu()
        self.assertEqual([call.args for call in operation.call_args_list], [('install', None), ('start', None), ('update', '0.1.5'), ('mirrors', None)])


class ConfigurationLayoutTest(unittest.TestCase):
    def test_examples_share_group_order_fields_and_do_not_contain_obsolete_keys(self):
        source = (ROOT / 'config/app.conf.example').read_text()
        self.assertEqual(source, (ROOT / 'deploy/resources/app.conf.example').read_text())
        fields = [line.split('=', 1)[0].strip().lstrip('#').strip() for line in source.splitlines() if '=' in line and not line.startswith('# 应用')]
        self.assertFalse(core.LEGACY_KEYS.intersection(fields))
        self.assertLess(fields.index('DATABASE_SSL_MODE'), fields.index('REDIS_HOST'))
        self.assertLess(fields.index('REDIS_TLS'), fields.index('BOOTSTRAP_EMAIL'))
        headings = ['# 数据库', '# 缓存 Redis', '# 初始管理员', '# 持久目录', '# 后台任务']
        self.assertEqual([source.index(heading) for heading in headings], sorted(source.index(heading) for heading in headings))

    def test_compose_environment_uses_selected_images_without_editing_user_config(self):
        images = {'ops': 'ghcr.nju.edu.cn/holic512/pipkerops:0.1.4', 'proxy': 'docker.nju.edu.cn/library/nginx:1.28-alpine-slim'}
        with patch.object(core.subprocess, 'run') as command:
            core.compose('config', '--quiet', images=images)
        env = command.call_args.kwargs['env']
        self.assertEqual(env['PIPKEROPS_IMAGE'], 'ghcr.nju.edu.cn/holic512/pipkerops')
        self.assertEqual(env['PIPKEROPS_VERSION'], '0.1.4')
        self.assertEqual(env['PIPKEROPS_PROXY_IMAGE'], images['proxy'])


if __name__ == '__main__':
    unittest.main()
