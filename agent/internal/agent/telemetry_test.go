package agent

import (
	"context"
	"testing"
	"time"
)

func TestTelemetryRatesRejectResetReplacementAndMissingBaseline(t *testing.T) {
	c := newTelemetryCollector()
	at := time.Now()
	if c.rate("net", "boot:if:mac", 100, at) != nil {
		t.Fatal("first counter is not a rate")
	}
	if v := c.rate("net", "boot:if:mac", 200, at.Add(5*time.Second)); v == nil || *v != 20 {
		t.Fatal("incorrect rate")
	}
	if c.rate("net", "boot:if:mac", 1, at.Add(10*time.Second)) != nil {
		t.Fatal("counter reset must break series")
	}
	if c.rate("net", "other", 1000, at.Add(15*time.Second)) != nil {
		t.Fatal("replaced device must break series")
	}
	if c.rate("net", "other", 2000, at.Add(150*time.Second)) != nil {
		t.Fatal("sampling gap must break series")
	}
	if c.rate("net", "", 3000, at.Add(155*time.Second)) != nil {
		t.Fatal("unknown identity must break series")
	}
}
func TestTelemetryFirstFastSampleKeepsMemoryWithoutFakeCPU(t *testing.T) {
	c := newTelemetryCollector()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result := c.collect(ctx, "fast")
	if _, ok := result.Data["cpuPercent"]; ok {
		t.Fatal("CPU needs a previous counter sample")
	}
	if _, ok := result.Data["memoryPercent"]; !ok {
		t.Fatalf("memory unavailable: %v", result.Errors)
	}
	if result.SchemaVersion != 2 || result.DurationMS < 0 {
		t.Fatal("missing collection metadata")
	}
}

func TestContainerInspectPreservesSurvivorsAndOptionalHealth(t *testing.T) {
	tel := newTelemetry("details")
	values := map[string]map[string]any{"a": {"id": "a"}, "b": {"id": "b"}, "gone": {"id": "gone"}}
	mergeContainerInspect(&tel, values, `{"id":"a","state":{"Status":"running"},"restartCount":0,"labels":null}
{"id":"b","state":{"Health":{"Status":"unhealthy"}},"restartCount":7,"labels":{"com.docker.compose.project":"app","com.docker.compose.service":"web"}}
invalid`, "No such object: gone", context.Canceled)
	if values["a"]["health"] != "none" || values["a"]["restartCount"] != 0 || values["a"]["inspectError"] != nil {
		t.Fatalf("container without healthcheck lost: %v", values["a"])
	}
	if values["b"]["health"] != "unhealthy" || values["b"]["restartCount"] != 7 || values["b"]["composeService"] != "web" || values["b"]["composeProject"] != "app" {
		t.Fatalf("inspect details lost: %v", values["b"])
	}
	if len(tel.Errors) != 1 || values["gone"]["inspectError"] == nil || values["gone"]["restartCount"] != nil {
		t.Fatalf("failure was not isolated: %v / %v", values, tel.Errors)
	}
}
