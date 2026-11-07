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

func TestPartitionIdentityUsesConfirmedSysfsParent(t *testing.T) {
	root := t.TempDir()
	write := func(path, value string) {
		t.Helper()
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("proc/sys/kernel/random/boot_id", "boot")
	write("sys/devices/block/vda/diskseq", "10")
	write("sys/devices/block/vda/vda1/partition", "1")
	write("sys/devices/block/vda/vda1/start", "2048")
	class := filepath.Join(root, "sys/class/block")
	if err := os.MkdirAll(class, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "sys/devices/block/vda/vda1"), filepath.Join(class, "vda1")); err != nil {
		t.Fatal(err)
	}
	read := func() string { return readDeviceIdentities(root, nil, []string{"vda1"})["io"]["vda1"] }
	first := read()
	if first != "boot:10:partition:1:2048" {
		t.Fatalf("partition identity: %q", first)
	}
	write("sys/devices/block/vda/diskseq", "11")
	if read() == first {
		t.Fatal("parent replacement reused identity")
	}
	write("sys/devices/block/vda/vda1/start", "4096")
	if read() != "boot:11:partition:1:4096" {
		t.Fatal("partition layout not in identity")
	}
	if err := os.Remove(filepath.Join(root, "sys/devices/block/vda/diskseq")); err != nil {
		t.Fatal(err)
	}
	if read() != "" {
		t.Fatal("guessed identity without parent generation")
	}
}
