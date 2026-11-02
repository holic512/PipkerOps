#!/bin/sh
# @file package-release.sh
# @project PipkerOps
# @module delivery/packaging
# @description 打包部署文件与 PipkerOpsSkill。
# @logic 基于受控文件列表生成带版本的发布压缩包。
# @dependencies POSIX sh, tar
# @index_tags release, deploy, skill
# @author holic512
set -eu
ops=$1
skill=$2
output=$3
scripts=$(cat "$(dirname -- "$0")/../deploy/VERSION")
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$output"
output=$(CDPATH= cd -- "$output" && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT HUP INT TERM
mkdir -p "$stage/pipkerops/deploy" "$stage/pipkerops/docs"
mkdir -p "$stage/pipkerops/deploy/resources" "$stage/pipkerops/deploy/script" "$stage/pipkerops/deploy/internal"
cp "$root/deploy/resources/"* "$stage/pipkerops/deploy/resources/"
cp "$root/deploy/script/"*.py "$stage/pipkerops/deploy/script/"
cp "$root/deploy/internal/"*.py "$stage/pipkerops/deploy/internal/"
cp "$root/deploy/menu.py" "$root/deploy/VERSION" "$stage/pipkerops/deploy/"
cp "$root/docs/DEPLOYMENT.md" "$stage/pipkerops/docs/"
sed "s/^PIPKEROPS_VERSION=.*/PIPKEROPS_VERSION=$ops/" "$stage/pipkerops/deploy/resources/compose.env.example" > "$stage/compose.env.example"
mv "$stage/compose.env.example" "$stage/pipkerops/deploy/resources/compose.env.example"
python3 - "$stage/pipkerops/deploy" <<'MANIFEST'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
files = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(root.rglob('*')) if path.is_file()}
(root / 'managed-files.json').write_text(json.dumps({'format': 1, 'version': (root / 'VERSION').read_text().strip(), 'files': files}, indent=2) + '\n')
MANIFEST
tar -czf "$output/pipkerops-deploy-$scripts.tar.gz" -C "$stage" pipkerops
tar -czf "$output/pipkerops-skill-$skill.tar.gz" -C "$root/skills" pipkerops-skill
