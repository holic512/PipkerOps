// @file container_files.go
// @project PipkerOps
// @module agent/container-files
// @description 容器命名空间内的文件任务，保持与宿主机文件接口相同的结果结构。
// @logic 固定脚本接收独立路径参数和stdin内容；NUL分隔目录元数据由Go解析；不回退到宿主机。
// @dependencies Docker CLI, container /bin/sh and BusyBox/GNU file utilities
// @index_tags agent, container, files, tasks
// @author holic512
package agent

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path"
	"strconv"
	"strings"
	"time"
)

// Paths and content are never interpolated into this script. Validation runs
// inside the container, where its symlinks and protected paths actually live.
const containerFileScript = `
action=$1
target=$2
fail() { printf '%s\n' "$*" >&2; exit 1; }
case "$target" in /proc|/proc/*|/sys|/sys/*|/dev|/dev/*) fail 'path is protected';; esac
current=
rest=${target#/}
while [ -n "$rest" ]; do
  part=${rest%%/*}
  current=$current/$part
  [ ! -L "$current" ] || fail 'symlink traversal is not allowed'
  case "$rest" in */*) rest=${rest#*/};; *) rest=;; esac
done
case "$action" in
  list)
    cd "$target"
    count=0
    limited=0
    for entry in .[!.]* ..?* *; do
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      if [ "$count" -ge 1000 ]; then limited=1; break; fi
      metadata=$(stat -c '%A %s %Y' -- "$entry")
      set -- $metadata
      printf '%s\000%s\000%s\000%s\000' "$entry" "$1" "$2" "$3"
      count=$((count + 1))
    done
    printf '%s\000' "$limited"
    ;;
  read)
    [ -f "$target" ] || fail 'only regular files can be read'
    head -c 262145 -- "$target"
    ;;
  write)
    [ ! -e "$target" ] || [ -f "$target" ] || fail 'only regular files can be written'
    parent=${target%/*}
    [ -n "$parent" ] || parent=/
    temporary=$(mktemp "$parent/.agent-XXXXXX")
    trap 'rm -f -- "$temporary"' 0
    cat > "$temporary"
    chmod 0600 "$temporary"
    sync -f "$temporary"
    mv -f -- "$temporary" "$target"
    sync -f "$parent"
    ;;
  mkdir) mkdir -m 0750 -- "$target";;
  remove)
    if [ -d "$target" ]; then rmdir -- "$target"; else rm -- "$target"; fi
    ;;
esac
`

func containerFileOperation(ctx context.Context, taskType string, p executionParams) (string, any, error) {
	cmd, target, err := containerFileCommand(ctx, taskType, p)
	if err != nil {
		return "", nil, err
	}
	var stdout bytes.Buffer
	stderr := &outputWriter{}
	cmd.Stdout = &stdout
	cmd.Stderr = stderr
	if err = cmd.Run(); err != nil {
		return "", nil, fmt.Errorf("container file operation failed: %w: %s", err, strings.TrimSpace(stderr.buffer.String()))
	}
	result := map[string]any{"path": target, "containerId": p.ContainerID}
	switch taskType {
	case "container.files.list":
		entries, limited, err := containerDirectoryEntries(stdout.Bytes())
		if err != nil {
			return "", nil, err
		}
		result["entries"], result["limited"] = entries, limited
	case "container.files.read":
		content, truncated, binary := fileText(stdout.Bytes())
		result["truncated"], result["binary"] = truncated, binary
		return content, result, nil
	}
	return "", result, nil
}

func containerFileCommand(ctx context.Context, taskType string, p executionParams) (*exec.Cmd, string, error) {
	if !objectName.MatchString(p.ContainerID) {
		return nil, "", errors.New("invalid container id or name")
	}
	if !path.IsAbs(p.Path) || strings.ContainsRune(p.Path, 0) {
		return nil, "", errors.New("path must be absolute")
	}
	action := strings.TrimPrefix(taskType, "container.files.")
	switch action {
	case "list", "read", "write", "mkdir", "remove":
	default:
		return nil, "", errors.New("unsupported container file operation")
	}
	target := path.Clean(p.Path)
	if target == "/" && action != "list" && action != "read" {
		return nil, "", errors.New("cannot modify filesystem root")
	}
	if len(p.Content) > maxOutput {
		return nil, "", errors.New("file content exceeds 256 KiB")
	}
	cmd := exec.CommandContext(ctx, "docker", "exec", "-i", p.ContainerID, "/bin/sh", "-ceu", containerFileScript, "pipkerops-files", action, target)
	cmd.Env = commandEnv()
	cmd.Stdin = strings.NewReader(p.Content)
	cmd.WaitDelay = 2 * time.Second
	return cmd, target, nil
}

func containerDirectoryEntries(raw []byte) ([]any, bool, error) {
	fields := bytes.Split(raw, []byte{0})
	if len(fields) < 2 || len(fields)%4 != 2 || len(fields[len(fields)-1]) != 0 {
		return nil, false, errors.New("invalid container directory metadata")
	}
	entries := make([]any, 0, len(fields)/4)
	for i := 0; i < len(fields)-2; i += 4 {
		mode := string(fields[i+1])
		size, sizeErr := strconv.ParseInt(string(fields[i+2]), 10, 64)
		modified, timeErr := strconv.ParseInt(string(fields[i+3]), 10, 64)
		if len(mode) == 0 || sizeErr != nil || timeErr != nil {
			return nil, false, errors.New("invalid container directory entry")
		}
		entries = append(entries, map[string]any{
			"name": string(fields[i]), "directory": mode[0] == 'd', "symlink": mode[0] == 'l',
			"size": size, "mode": mode, "modifiedAt": time.Unix(modified, 0).UTC().Format(time.RFC3339Nano),
		})
	}
	return entries, string(fields[len(fields)-2]) == "1", nil
}
