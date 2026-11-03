package agent

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestContainerFileCommandKeepsTargetAndContentOutOfScript(t *testing.T) {
	p := executionParams{ContainerID: "app-1", Path: "/tmp/中文 ' $(touch unwanted).txt", Content: "hello\n$(id)\n"}
	cmd, target, err := containerFileCommand(context.Background(), "container.files.write", p)
	if err != nil {
		t.Fatal(err)
	}
	if target != p.Path || cmd.Args[3] != p.ContainerID || cmd.Args[len(cmd.Args)-1] != p.Path || cmd.Args[len(cmd.Args)-2] != "write" {
		t.Fatalf("target not passed as separate argument: %v", cmd.Args)
	}
	if strings.Contains(cmd.Args[6], p.Path) || strings.Contains(cmd.Args[6], p.Content) {
		t.Fatal("user data was interpolated into script")
	}
	content, err := io.ReadAll(cmd.Stdin)
	if err != nil || string(content) != p.Content {
		t.Fatalf("content not preserved on stdin: %q %v", content, err)
	}
	for _, invalid := range []executionParams{
		{ContainerID: "--privileged", Path: "/tmp/test"},
		{ContainerID: "app;id", Path: "/tmp/test"},
		{ContainerID: "app", Path: "relative"},
		{ContainerID: "app", Path: "/tmp/\x00file"},
		{ContainerID: "app", Path: "/tmp/.."},
		{ContainerID: "app", Path: "/tmp/test", Content: strings.Repeat("x", maxOutput+1)},
	} {
		if _, _, err = containerFileCommand(context.Background(), "container.files.write", invalid); err == nil {
			t.Fatalf("invalid request accepted: %#v", invalid)
		}
	}
	if _, _, err = containerFileCommand(context.Background(), "files.write", p); err == nil {
		t.Fatal("host task accepted as container task")
	}
}

func TestFileReadKeepsBinaryOutOfTaskTextStorage(t *testing.T) {
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(directory, "file")
	for _, content := range [][]byte{{'a', 0, 'b'}, {0xff, 0xfe}} {
		if err := os.WriteFile(file, content, 0600); err != nil {
			t.Fatal(err)
		}
		output, result, err := fileOperation("files.read", executionParams{Path: file}, "")
		if err != nil || output != "" || result.(map[string]any)["binary"] != true {
			t.Fatalf("binary read: %q %v %v", output, result, err)
		}
	}
	if err := os.WriteFile(file, []byte(strings.Repeat("x", maxOutput+1)), 0600); err != nil {
		t.Fatal(err)
	}
	output, result, err := fileOperation("files.read", executionParams{Path: file}, "")
	if err != nil || len(output) != maxOutput || result.(map[string]any)["truncated"] != true || result.(map[string]any)["binary"] != false {
		t.Fatalf("truncated text read: %d %v %v", len(output), result, err)
	}
	if err := os.WriteFile(file, []byte(strings.Repeat("中", maxOutput/3+1)), 0600); err != nil {
		t.Fatal(err)
	}
	output, result, err = fileOperation("files.read", executionParams{Path: file}, "")
	if err != nil || !utf8.ValidString(output) || len(output) != maxOutput-1 || result.(map[string]any)["binary"] != false || result.(map[string]any)["truncated"] != true {
		t.Fatalf("UTF-8 boundary read: %d %v %v", len(output), result, err)
	}
}

func TestContainerDirectoryMetadataPreservesNamesAndTypes(t *testing.T) {
	raw := []byte("中文 ' a\nfile\x00-rw-------\x0012\x001730000000\x00folder\x00drwxr-x---\x004096\x001730000001\x00link\x00lrwxrwxrwx\x004\x001730000002\x001\x00")
	entries, limited, err := containerDirectoryEntries(raw)
	if err != nil || !limited || len(entries) != 3 {
		t.Fatalf("metadata: %v %v %v", entries, limited, err)
	}
	file := entries[0].(map[string]any)
	if file["name"] != "中文 ' a\nfile" || file["directory"] != false || file["size"] != int64(12) || file["modifiedAt"] != "2024-10-27T03:33:20Z" {
		t.Fatalf("file metadata altered: %v", file)
	}
	if entries[1].(map[string]any)["directory"] != true || entries[2].(map[string]any)["symlink"] != true {
		t.Fatal("directory/symlink type lost")
	}
	entries, limited, err = containerDirectoryEntries([]byte("0\x00"))
	if err != nil || limited || len(entries) != 0 {
		t.Fatalf("empty directory: %v %v %v", entries, limited, err)
	}
	for _, raw := range []string{"", "bad", "file\x00-rw\x00invalid\x001\x000\x00"} {
		if _, _, err = containerDirectoryEntries([]byte(raw)); err == nil {
			t.Fatalf("invalid metadata accepted: %q", raw)
		}
	}
}
