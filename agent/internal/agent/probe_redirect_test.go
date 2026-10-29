package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestPOSTProbeNeverReplaysAcrossSameOriginRedirect(t *testing.T) {
	var original, redirected atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/original" {
			original.Add(1)
			w.Header().Set("Location", "/redirected")
			w.WriteHeader(http.StatusTemporaryRedirect)
		} else {
			redirected.Add(1)
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer server.Close()
	payload, _ := json.Marshal(map[string]any{"probeId": "post", "type": "HTTP", "target": server.URL + "/original", "timeoutMs": 1000, "config": map[string]any{"method": "POST", "body": "side-effect"}})
	result, err := runProbe(context.Background(), payload)
	if err == nil || result["success"] != false {
		t.Fatalf("redirect must fail: %v %v", result, err)
	}
	if original.Load() != 1 || redirected.Load() != 0 {
		t.Fatalf("request replayed: original=%d redirected=%d", original.Load(), redirected.Load())
	}
}
