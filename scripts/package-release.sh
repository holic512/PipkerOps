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
cp "$root/deploy/menu.py" "$stage/pipkerops/deploy/"
cp "$root/docs/DEPLOYMENT.md" "$stage/pipkerops/docs/"
sed "s/^PIPKEROPS_VERSION=.*/PIPKEROPS_VERSION=$ops/" "$stage/pipkerops/deploy/resources/compose.env.example" > "$stage/compose.env.example"
mv "$stage/compose.env.example" "$stage/pipkerops/deploy/resources/compose.env.example"
tar -czf "$output/pipkerops-deploy-$ops.tar.gz" -C "$stage" pipkerops
tar -czf "$output/pipkerops-skill-$skill.tar.gz" -C "$root/skills" pipkerops-skill
