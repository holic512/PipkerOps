package agent

import (
	"testing"
	"time"
)

func TestContainerRestartWindow(t *testing.T) {
	var history containerRestartHistory
	start := time.Now()
	sample := func(id string, seconds int, count int) map[string]any {
		row := map[string]any{"id": id, "restartCount": count}
		history = history.observe([]map[string]any{row}, start.Add(time.Duration(seconds)*time.Second))
		return row
	}
	if row := sample("a", 0, 8); row["recentRestartCount"] != nil || row["restartWindowComplete"] != false {
		t.Fatalf("historical count must not become a recent restart: %v", row)
	}
	for seconds := 30; seconds <= 270; seconds += 30 {
		sample("a", seconds, 8)
	}
	if row := sample("a", 300, 8); row["recentRestartCount"] != 0 || row["restartWindowComplete"] != true {
		t.Fatalf("expected a complete zero window: %v", row)
	}
	if row := sample("a", 330, 11); row["recentRestartCount"] != 3 || row["restartWindowComplete"] != true {
		t.Fatalf("expected three recent restarts: %v", row)
	}
	for seconds := 360; seconds <= 600; seconds += 30 {
		sample("a", seconds, 11)
	}
	if row := sample("a", 615, 11); row["recentRestartCount"] != 0 || row["restartWindowComplete"] != false {
		t.Fatalf("restart across the cutoff has unknown placement: %v", row)
	}
	if row := sample("a", 630, 11); row["recentRestartCount"] != 0 || row["restartWindowComplete"] != true {
		t.Fatalf("expected recent restarts to age out: %v", row)
	}
	if row := sample("a", 730, 15); row["recentRestartCount"] != nil {
		t.Fatalf("gap must reset the baseline: %v", row)
	}
	if row := sample("a", 760, 2); row["recentRestartCount"] != nil {
		t.Fatalf("counter reset must reset the baseline: %v", row)
	}
	if row := sample("replacement", 790, 9); row["recentRestartCount"] != nil || len(history) != 1 {
		t.Fatalf("replacement must not inherit history: %v", row)
	}
	history = history.observe(nil, start.Add(820*time.Second))
	if row := sample("replacement", 850, 12); row["recentRestartCount"] != nil {
		t.Fatalf("missing inventory must reset the baseline: %v", row)
	}
}
