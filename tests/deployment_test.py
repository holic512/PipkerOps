import contextlib
import hashlib
import io
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'deploy'))
from internal import agent
from internal import core
import menu


class AgentPackageTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.arch = 'amd64'
        self.addCleanup(patch.stopall)
        patch.object(agent.platform, 'machine', return_value='x86_64').start()

    def package(self, missing=None, machine=62, symlink=None):
        name = 'pipker-agent-0.1.0-linux-amd64'
        path = self.directory / f'{name}.tar.gz'
        header = bytearray(64)
        header[:6] = b'\x7fELF\x02\x01'
        header[18:20] = machine.to_bytes(2, 'little')
        with tarfile.open(path, 'w:gz') as archive:
            for filename in agent.PACKAGE_FILES:
                if filename == missing:
                    continue
                data = bytes(header) if filename == 'pipker-agent' else (ROOT / 'agent' / filename).read_bytes()
                member = tarfile.TarInfo(f'{name}/{filename}')
                if filename == symlink:
                    member.type = tarfile.SYMTYPE
                    member.linkname = '/outside'
                    archive.addfile(member)
                else:
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
            extra = tarfile.TarInfo('../outside')
            extra.size = 7
            archive.addfile(extra, io.BytesIO(b'ignored'))
        self.sums = self.directory / 'SHA256SUMS'
        self.sums.write_text(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n' + '0' * 64 + '  missing-other-architecture.tar.gz\n')
        return path

    def test_selected_archive_only_is_verified_and_known_files_are_staged(self):
        path = self.package()

        def installer(command, **kwargs):
            self.assertEqual(command[0], 'sh')
            staging = Path(command[1]).parent
            self.assertEqual(set(p.name for p in staging.iterdir()), set(agent.PACKAGE_FILES))
            self.assertEqual(Path(command[1]).read_bytes(), (ROOT / 'agent/install.sh').read_bytes())
            self.assertEqual(Path(command[2]).name, 'pipker-agent')

        with patch.object(agent.subprocess, 'run', side_effect=installer) as command, contextlib.redirect_stdout(io.StringIO()):
            agent.install(str(path), {'ActiveState': 'inactive'})
        command.assert_called_once()

    def test_bad_packages_fail_before_installer(self):
        cases = ('checksum', 'missing-sums', 'invalid-sums-text', 'missing-package', 'missing-member', 'symlink', 'wrong-elf', 'wrong-arch', 'duplicate-sum', 'corrupt-archive')
        for case in cases:
            with self.subTest(case=case):
                path = self.package(missing='install.sh' if case == 'missing-member' else None,
                                    machine=183 if case == 'wrong-elf' else 62,
                                    symlink='pipker-agent' if case == 'symlink' else None)
                if case == 'checksum':
                    path.write_bytes(b'changed')
                elif case == 'missing-sums':
                    self.sums.unlink()
                elif case == 'invalid-sums-text':
                    self.sums.write_bytes(b'\xff')
                elif case == 'missing-package':
                    path.unlink()
                elif case == 'wrong-arch':
                    path = path.rename(path.with_name(path.name.replace('amd64', 'arm64')))
                elif case == 'duplicate-sum':
                    self.sums.write_text(self.sums.read_text() * 2)
                elif case == 'corrupt-archive':
                    path.write_bytes(b'not an archive')
                    self.sums.write_text(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n')
                with patch.object(agent.subprocess, 'run') as command:
                    with self.assertRaises((RuntimeError, OSError, UnicodeError, tarfile.TarError)):
                        agent.install(str(path), {'ActiveState': 'inactive'})
                    command.assert_not_called()

    def test_active_service_rejects_reinstall(self):
        with self.assertRaisesRegex(RuntimeError, '先通过菜单停止'), patch.object(agent.subprocess, 'run') as command:
            agent.install(str(self.package()), {'ActiveState': 'active'})
        command.assert_not_called()

    def test_arm64_package(self):
        path = self.package(machine=183)
        renamed = path.rename(path.with_name(path.name.replace('amd64', 'arm64')))
        # Rebuild the real archive with the arm64 release directory name.
        with tarfile.open(renamed, 'r:gz') as source:
            members = [(m, source.extractfile(m).read()) for m in source.getmembers()]
        with tarfile.open(renamed, 'w:gz') as target:
            for member, data in members:
                member.name = member.name.replace('amd64', 'arm64')
                target.addfile(member, io.BytesIO(data))
        self.sums.write_text(f'{hashlib.sha256(renamed.read_bytes()).hexdigest()}  {renamed.name}\n')
        with patch.object(agent.platform, 'machine', return_value='aarch64'), patch.object(agent.subprocess, 'run') as command, contextlib.redirect_stdout(io.StringIO()):
            agent.install(str(renamed), {'ActiveState': 'inactive'})
        command.assert_called_once()


class AgentCommandTest(unittest.TestCase):
    def test_host_requirements_fail_before_systemd(self):
        for system, uid, executable in [('Darwin', 0, '/usr/bin/systemctl'), ('Linux', 501, '/usr/bin/systemctl'), ('Linux', 0, None)]:
            with self.subTest(system=system, uid=uid, executable=executable), patch.object(agent.platform, 'system', return_value=system), patch.object(agent.os, 'geteuid', return_value=uid), patch.object(agent.shutil, 'which', return_value=executable), patch.object(agent.subprocess, 'run') as command, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(agent.main('install', '/uploaded/package.tar.gz'), 1)
                command.assert_not_called()

    def test_missing_service_is_normal_status(self):
        result = subprocess.CompletedProcess([], 1, 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n', '')
        with patch.object(agent.platform, 'system', return_value='Linux'), patch.object(agent.shutil, 'which', return_value='/usr/bin/systemctl'), patch.object(agent, 'BINARY', Path('/nonexistent-agent-fixture')), patch.object(agent.subprocess, 'run', return_value=result), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(agent.main('status'), 0)
        self.assertIn('未安装', output.getvalue())
        self.assertIn('inactive', output.getvalue())

    def test_unavailable_systemd_fails(self):
        result = subprocess.CompletedProcess([], 1, '', 'System has not been booted with systemd')
        with patch.object(agent.subprocess, 'run', return_value=result):
            with self.assertRaises(subprocess.CalledProcessError):
                agent.service_state()

    def test_service_commands_and_failures(self):
        for action, arguments in [('start', ['enable', '--now']), ('stop', ['stop']), ('restart', ['restart'])]:
            with self.subTest(action=action), patch.object(agent, 'require_host'), patch.object(agent, 'service_state', return_value={'LoadState': 'loaded'}), patch.object(agent.subprocess, 'run') as command:
                self.assertEqual(agent.main(action), 0)
                command.assert_called_once_with(['systemctl', *arguments, agent.UNIT], check=True)
        with patch.object(agent, 'require_host'), patch.object(agent, 'service_state', return_value={'LoadState': 'loaded'}), patch.object(agent.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'systemctl')), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(agent.main('start'), 1)

    def test_menu_stays_in_agent_submenu_after_failure(self):
        with patch('builtins.input', side_effect=['2', '1', '/uploaded/agent.tar.gz', '2', '0', '0']), patch.object(menu, 'agent_main', side_effect=[1, 0]) as operation, patch.object(menu, 'control_main') as control:
            menu.menu()
        self.assertEqual(operation.call_args_list[0].args, ('install', '/uploaded/agent.tar.gz'))
        self.assertEqual(operation.call_args_list[1].args, ('status', None))
        control.assert_not_called()

    def test_release_deployment_archive_runs_without_repository(self):
        with tempfile.TemporaryDirectory() as temporary:
            subprocess.run(['sh', str(ROOT / 'scripts/package-release.sh'), '0.1.2', '0.1.0', temporary], check=True)
            with tarfile.open(Path(temporary) / f'pipkerops-deploy-{(ROOT / "deploy/VERSION").read_text().strip()}.tar.gz') as archive:
                archive.extractall(temporary, filter='data')
            deployment = Path(temporary) / 'pipkerops/deploy'
            self.assertTrue((deployment / 'internal/agent.py').is_file())
            result = subprocess.run([sys.executable, str(deployment / 'menu.py')], input='2\n0\n0\n', text=True, capture_output=True, cwd=temporary, check=True)
            self.assertIn('Agent 管理', result.stdout)
            subprocess.run([sys.executable, str(deployment / 'script/agent.py'), '--help'], capture_output=True, check=True, cwd=temporary)
            self.assertFalse((deployment / 'config').exists())
            self.assertFalse((deployment / 'data').exists())
            self.assertIn('PIPKEROPS_VERSION=0.1.2', (deployment / 'resources/compose.env.example').read_text())


class LegacyDeploymentTest(unittest.TestCase):
    def test_legacy_copy_removes_old_gateway_and_tls_ports_without_changing_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'config').mkdir()
            (root / 'VERSION').write_text('0.1.0\n')
            app = 'DATABASE_HOST=postgres\nDATABASE_PASSWORD="fixture-preserved"\nGATEWAY_PORT=9443\nENROLL_PORT=9444\nAPP_ORIGIN=https://old.example\nPKI_DIR=./.data/pki\n'
            compose = 'PIPKEROPS_IMAGE=custom/pipkerops\nPIPKEROPS_VERSION=0.1.2\nWEB_BIND=0.0.0.0\nWEB_PORT=443\nGATEWAY_PORT=9443\n'
            (root / 'config/app.conf').write_text(app)
            (root / 'config/compose.env').write_text(compose)
            with patch.object(core, 'ROOT', root), patch.object(core, 'CONFIG', root / 'config/ops'), patch.object(core, 'DATA', root / 'data/ops'):
                core.prepare()
            self.assertEqual((root / 'config/app.conf').read_text(), app)
            self.assertEqual((root / 'config/compose.env').read_text(), compose)
            migrated = (root / 'config/ops/app.conf').read_text()
            self.assertIn('DATABASE_PASSWORD="fixture-preserved"', migrated)
            self.assertNotIn('GATEWAY_PORT=', migrated)
            self.assertNotIn('PKI_DIR=', migrated)
            migrated = (root / 'config/ops/compose.env').read_text()
            self.assertIn('WEB_BIND=127.0.0.1\nWEB_PORT=8080', migrated)
            self.assertIn('PIPKEROPS_VERSION=0.1.2', migrated)
            self.assertNotIn('GATEWAY_PORT=', migrated)


class ComponentVersionTest(unittest.TestCase):
    def test_agent_documentation_preserves_version_but_source_requires_bump(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)

            def git(*arguments):
                return subprocess.check_output(['git', '-c', 'user.name=Version fixture', '-c', 'user.email=version@example.invalid', '-c', 'commit.gpgsign=false', *arguments], cwd=directory, text=True, stderr=subprocess.DEVNULL).strip()

            def commit():
                git('add', '.')
                git('commit', '-qm', 'version fixture')

            for name in ('agent', 'skills', 'deploy'):
                (directory / name).mkdir()
                (directory / name / 'VERSION').write_text('0.1.0\n')
            (directory / 'package.json').write_text('{"version":"0.1.2"}')
            (directory / 'agent/main.go').write_text('package main\n')
            git('init', '-q')
            commit()
            base = git('rev-parse', 'HEAD')
            (directory / 'agent/README.md').write_text('Agent installation documentation\n')
            commit()
            command = ['node', str(ROOT / 'scripts/check-component-versions.mjs'), base]
            documentation = subprocess.run(command, cwd=directory, capture_output=True, text=True)
            self.assertEqual(documentation.returncode, 0, documentation.stderr)
            (directory / 'agent/main.go').write_text('package main\nfunc main() {}\n')
            commit()
            source = subprocess.run(command, cwd=directory, capture_output=True, text=True)
            self.assertNotEqual(source.returncode, 0)
            self.assertIn('increase agent/VERSION', source.stderr)
            (directory / 'agent/VERSION').write_text('0.1.1\n')
            commit()
            bumped = subprocess.run(command, cwd=directory, capture_output=True, text=True)
            self.assertEqual(bumped.returncode, 0, bumped.stderr)


if __name__ == '__main__':
    unittest.main()
