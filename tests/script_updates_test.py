import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'deploy'))
from internal.script_updates import update_scripts
from internal import script_updates


class ScriptUpdateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = (Path(self.temp.name) / 'deploy').resolve()
        self.root.mkdir()
        self.old = {'menu.py': b'old menu', 'VERSION': b'0.1.0\n', 'internal/old.py': b'old module'}
        for name, content in self.old.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        self.manifest = self.make_manifest(self.old, '0.1.0')
        (self.root / 'managed-files.json').write_text(json.dumps(self.manifest))
        (self.root / '.pipkerops-installation.json').write_text(json.dumps({'format': 1, 'root': str(self.root), 'components': ['ops', 'agent'], 'scriptsVersion': '0.1.0'}))
        self.sentinels = ['config/ops/app.conf', 'config/agent/agent.env', 'data/ops/credentials/private', 'data/agent/identity/ca.key', 'custom.txt']
        for name in self.sentinels:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'preserve ' + name.encode())

    def make_manifest(self, files, version):
        return {'format': 1, 'version': version, 'files': {name: hashlib.sha256(value).hexdigest() for name, value in files.items()}}

    def package(self, files=None, symlink=False):
        files = files or {'menu.py': b'new menu', 'VERSION': b'0.1.1\n', 'internal/new.py': b'new module'}
        manifest = self.make_manifest(files, '0.1.1')
        path = Path(self.temp.name) / 'update.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, data in {**files, 'managed-files.json': json.dumps(manifest).encode()}.items():
                member = tarfile.TarInfo('pipkerops/deploy/' + name)
                if symlink and name == 'menu.py':
                    member.type = tarfile.SYMTYPE
                    member.linkname = '/outside'
                    archive.addfile(member)
                else:
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_update_preserves_both_components_and_custom_files(self):
        before = {name: (self.root / name).read_bytes() for name in self.sentinels}
        result = update_scripts(self.root, *self.package())
        self.assertEqual(result['version'], '0.1.1')
        self.assertEqual((self.root / 'menu.py').read_bytes(), b'new menu')
        self.assertFalse((self.root / 'internal/old.py').exists())
        self.assertEqual((Path(result['backup']) / 'menu.py').read_bytes(), b'old menu')
        self.assertEqual(before, {name: (self.root / name).read_bytes() for name in self.sentinels})
        marker = json.loads((self.root / '.pipkerops-installation.json').read_text())
        self.assertEqual(marker['components'], ['ops', 'agent'])
        self.assertEqual(marker['scriptsVersion'], '0.1.1')

    def test_local_modification_stops_before_any_replacement(self):
        (self.root / 'menu.py').write_bytes(b'user modification')
        with self.assertRaisesRegex(RuntimeError, '本地修改'):
            update_scripts(self.root, *self.package())
        self.assertEqual((self.root / 'menu.py').read_bytes(), b'user modification')
        self.assertEqual((self.root / 'VERSION').read_bytes(), b'0.1.0\n')

    def test_metadata_failure_restores_program_manifest_and_marker(self):
        before = {name: (self.root / name).read_bytes() for name in ['menu.py', 'managed-files.json', '.pipkerops-installation.json']}
        original = script_updates.atomic_write
        def fail_after_marker(path, content, mode=0o600):
            original(path, content, mode)
            if path.name == '.pipkerops-installation.json':
                raise OSError('metadata failure fixture')
        with patch.object(script_updates, 'atomic_write', side_effect=fail_after_marker), self.assertRaises(OSError):
            update_scripts(self.root, *self.package())
        self.assertEqual(before, {name: (self.root / name).read_bytes() for name in before})
        self.assertTrue((self.root / 'internal/old.py').is_file())
        self.assertFalse((self.root / 'internal/new.py').exists())

    def test_checksum_and_private_paths_and_symlinks_rejected(self):
        archive, digest = self.package()
        with self.assertRaisesRegex(RuntimeError, 'SHA-256'):
            update_scripts(self.root, archive, '0' * 64)
        for name in ['config/ops/app.conf', 'data/agent/identity/key', '../outside']:
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, '无效路径'):
                update_scripts(self.root, *self.package({name: b'overwrite'}))
        with self.assertRaisesRegex(RuntimeError, '常规文件'):
            update_scripts(self.root, *self.package(symlink=True))
        self.assertEqual((self.root / 'menu.py').read_bytes(), b'old menu')


if __name__ == '__main__':
    unittest.main()
