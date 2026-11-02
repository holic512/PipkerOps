#!/bin/sh
# @file package-agent.sh
# @project PipkerOps
# @module release/agent
# @description 构建带版本的 Linux Agent 原始 ELF、手工安装包和 SHA-256 清单。
# @logic 验证版本与架构；静态交叉编译；打包安装文件；对发布文件生成校验清单。
# @dependencies POSIX sh, Go 1.26+, tar, sha256sum or shasum
# @index_tags agent, release, packaging
# @author holic512
set -eu

main() {
  validate "$@"
  root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
  version=$1
  arch=$2
  output=${3:-"$root/dist/agent"}
  mkdir -p "$output"
  output=$(CDPATH= cd -- "$output" && pwd)
  name="pipker-agent-$version-linux-$arch"
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT HUP INT TERM

  cd "$root/agent"
  CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath \
    -ldflags="-s -w -X github.com/holic512/PipkerOps/agent/internal/agent.Version=$version" \
    -o "$output/$name" ./cmd/pipker-agent
  mkdir "$stage/$name"
  cp "$output/$name" "$stage/$name/pipker-agent"
  cp install.sh pipkerops-agent.service agent.env.example README.md "$stage/$name/"
  chmod 0755 "$stage/$name/pipker-agent" "$stage/$name/install.sh"
  tar -czf "$output/$name.tar.gz" -C "$stage" "$name"
  cd "$output"
  checksum "$name" "$name.tar.gz" > "SHA256SUMS-linux-$arch"
  printf 'Agent %s packaged for linux/%s in %s\n' "$version" "$arch" "$output"
}

validate() {
  if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
    printf 'Usage: sh scripts/package-agent.sh VERSION amd64|arm64 [OUTPUT_DIR]\n' >&2
    exit 2
  fi
  case "$1" in
    ''|*[!a-zA-Z0-9.+_-]*) printf 'Invalid Agent version.\n' >&2; exit 2 ;;
  esac
  case "$2" in
    amd64|arm64) ;;
    *) printf 'Agent architecture must be amd64 or arm64.\n' >&2; exit 2 ;;
  esac
}

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

main "$@"
