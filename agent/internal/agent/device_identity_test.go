package agent

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDeviceIdentityChangesAcrossBootAndReplacement(t *testing.T) {
	root := t.TempDir()
	write := func(path, value string) {
		t.Helper()
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(value+"\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("proc/sys/kernel/random/boot_id", "boot-a")
	write("sys/class/net/eth0/ifindex", "3")
	write("sys/class/net/eth0/address", "02:00:00:00:00:01")
	write("sys/class/block/sda/diskseq", "8")
	first := readDeviceIdentities(root, []string{"eth0", "missing"}, []string{"sda", "missing"})
	if first["network"]["eth0"] != "boot-a:3:02:00:00:00:00:01" || first["io"]["sda"] != "boot-a:8" {
		t.Fatalf("identities: %v", first)
	}
	if _, ok := first["io"]["missing"]; ok {
		t.Fatal("invented missing device identity")
	}
	write("sys/class/net/eth0/ifindex", "4")
	write("sys/class/block/sda/diskseq", "9")
	second := readDeviceIdentities(root, []string{"eth0"}, []string{"sda"})
	if first["network"]["eth0"] == second["network"]["eth0"] || first["io"]["sda"] == second["io"]["sda"] {
		t.Fatal("replacement kept old identity")
	}
	write("proc/sys/kernel/random/boot_id", "boot-b")
	third := readDeviceIdentities(root, []string{"eth0"}, []string{"sda"})
	if second["io"]["sda"] == third["io"]["sda"] {
		t.Fatal("reboot kept old identity")
	}
}
