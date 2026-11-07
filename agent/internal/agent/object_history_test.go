package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProcessStartTicksWithComplexComm(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "42"), 0700); err != nil {
		t.Fatal(err)
	}
	fields := append([]string{"S"}, make([]string, 19)...)
	for i := 1; i < len(fields); i++ {
		fields[i] = "0"
	}
	fields[19] = "9007199254740993123"
	if err := os.WriteFile(filepath.Join(root, "42", "stat"), []byte("42 (worker (task) name) "+strings.Join(fields, " ")), 0600); err != nil {
		t.Fatal(err)
	}
	ticks, err := processStartTicks(root, 42)
	if err != nil || ticks != "9007199254740993123" {
		t.Fatalf("ticks=%s error=%v", ticks, err)
	}
}
func TestProcessHistoryUnionAndWatchBound(t *testing.T) {
	values := []map[string]any{}
	watches := []processWatch{}
	for i := 0; i < 80; i++ {
		id := fmt.Sprintf("boot:%d:1", i+1)
		values = append(values, map[string]any{"objectId": id})
		if i >= 40 && i < 60 {
			watches = append(watches, processWatch{ObjectID: id})
		}
	}
	got := processHistoryRows(values, values[20:], values, watches)
	if len(got) != 60 {
		t.Fatalf("expected60 distinct instances, got%d", len(got))
	}
	got = processHistoryRows(values, values, values, nil)
	if len(got) != 20 {
		t.Fatalf("overlapping top lists were not deduplicated: %d", len(got))
	}
}
func TestDockerNumericUnits(t *testing.T) {
	for raw, want := range map[string]float64{"120.5%": 120.5, "2MiB": 2097152, "1.5kB": 1500, "0B": 0} {
		v := dockerNumber(raw)
		if v == nil || *v != want {
			t.Fatalf("%s => %v", raw, v)
		}
	}
	if dockerNumber("N/A") != nil {
		t.Fatal("missing must stay nil")
	}
}
