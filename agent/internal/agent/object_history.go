package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type processWatch struct {
	ObjectID   string `json:"objectId"`
	BootID     string `json:"bootId"`
	PID        int32  `json:"pid"`
	StartTicks string `json:"startTicks"`
}
type watchConfig struct {
	Revision int            `json:"revision"`
	Watches  []processWatch `json:"watches"`
}

func (c *Client) configureWatches(payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var config watchConfig
	if err := json.Unmarshal(raw, &config); err != nil {
		return err
	}
	if config.Revision < 0 || len(config.Watches) > 20 {
		return fmt.Errorf("invalid process watch configuration")
	}
	seen := map[string]bool{}
	for _, w := range config.Watches {
		if w.PID <= 0 || w.BootID == "" || w.StartTicks == "" || w.ObjectID != fmt.Sprintf("%s:%d:%s", w.BootID, w.PID, w.StartTicks) || seen[w.ObjectID] {
			return fmt.Errorf("invalid process instance")
		}
		if _, err := strconv.ParseUint(w.StartTicks, 10, 64); err != nil {
			return err
		}
		seen[w.ObjectID] = true
	}
	c.watchMu.Lock()
	if config.Revision < c.watches.Revision {
		c.watchMu.Unlock()
		return nil
	}
	c.watches = config
	c.watchMu.Unlock()
	// Replayed desired state has the same revision. A lost ACK is retried on the
	// next reconciliation or connection; it never enters the telemetry queue.
	return c.send(Message{Type: "monitoring.configure.ack", Payload: map[string]any{"revision": config.Revision}})
}
func (c *Client) currentWatches() watchConfig {
	c.watchMu.RLock()
	defer c.watchMu.RUnlock()
	return watchConfig{Revision: c.watches.Revision, Watches: append([]processWatch{}, c.watches.Watches...)}
}
func processStartTicks(root string, pid int32) (string, error) {
	raw, err := os.ReadFile(filepath.Join(root, strconv.Itoa(int(pid)), "stat"))
	if err != nil {
		return "", err
	}
	// comm may contain spaces and parentheses. Field 22 is index 19 after ')'.
	end := strings.LastIndexByte(string(raw), ')')
	if end < 0 {
		return "", fmt.Errorf("invalid process stat")
	}
	fields := strings.Fields(string(raw)[end+1:])
	if len(fields) <= 19 {
		return "", fmt.Errorf("incomplete process stat")
	}
	if _, err := strconv.ParseUint(fields[19], 10, 64); err != nil {
		return "", err
	}
	return fields[19], nil
}
func processHistoryRows(cpuTop, memoryTop, all []map[string]any, watches []processWatch) []map[string]any {
	selected := []map[string]any{}
	seen := map[string]bool{}
	add := func(row map[string]any) {
		id, ok := row["objectId"].(string)
		if !ok || id == "" || seen[id] || len(selected) >= 60 {
			return
		}
		seen[id] = true
		selected = append(selected, row)
	}
	for _, group := range [][]map[string]any{cpuTop, memoryTop} {
		for i, row := range group {
			if i >= 20 {
				break
			}
			add(row)
		}
	}
	wanted := map[string]bool{}
	for _, w := range watches {
		wanted[w.ObjectID] = true
	}
	for _, row := range all {
		if wanted[fmt.Sprint(row["objectId"])] {
			add(row)
		}
	}
	return selected
}
func dockerNumber(raw any) *float64 {
	s, ok := raw.(string)
	if !ok {
		return nil
	}
	s = strings.TrimSpace(strings.TrimSuffix(s, "%"))
	for _, suffix := range []struct {
		unit   string
		factor float64
	}{{"EiB", 1 << 60}, {"PiB", 1 << 50}, {"TiB", 1 << 40}, {"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10}, {"TB", 1e12}, {"GB", 1e9}, {"MB", 1e6}, {"kB", 1e3}, {"B", 1}} {
		if strings.HasSuffix(s, suffix.unit) {
			v, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(s, suffix.unit)), 64)
			if err != nil || v < 0 {
				return nil
			}
			v *= suffix.factor
			return &v
		}
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || v < 0 {
		return nil
	}
	return &v
}
func dockerPair(v any) (*float64, *float64) {
	s, ok := v.(string)
	if !ok {
		return nil, nil
	}
	p := strings.Split(s, "/")
	if len(p) != 2 {
		return nil, nil
	}
	return dockerNumber(p[0]), dockerNumber(p[1])
}
func (c *telemetryCollector) containerMetrics(t *telemetry) {
	values, _ := t.Data["containers"].([]map[string]any)
	at := time.Now()
	counters := telemetryCollector{previous: c.containerPrevious}
	seen := map[string]bool{}
	for _, row := range values {
		stats, ok := row["stats"].(map[string]any)
		if !ok {
			continue
		}
		identity := ""
		if started, ok := row["startedAt"].(string); ok && started != "" && c.bootID != "" {
			identity = c.bootID + ":" + fmt.Sprint(row["id"]) + ":" + started
		}
		prefix := "container:" + fmt.Sprint(row["id"]) + ":"
		old := counters.previous[prefix+"networkRecv"]
		metrics := map[string]any{"cpuPercent": dockerNumber(stats["CPUPerc"]), "memoryPercent": dockerNumber(stats["MemPerc"])}
		metrics["memoryUsed"], metrics["memoryLimit"] = dockerPair(stats["MemUsage"])
		recv, sent := dockerPair(stats["NetIO"])
		read, write := dockerPair(stats["BlockIO"])
		for key, value := range map[string]*float64{"networkRecv": recv, "networkSent": sent, "ioRead": read, "ioWrite": write} {
			metrics[key] = nil
			if value != nil {
				metrics[key] = counters.rate(prefix+key, identity, *value, at)
				seen[prefix+key] = true
			}
		}
		if !old.at.IsZero() && at.Sub(old.at) > 0 && at.Sub(old.at) <= 120*time.Second {
			metrics["intervalMs"] = float64(at.Sub(old.at).Milliseconds())
		}
		row["metrics"] = metrics
	}
	for key := range c.containerPrevious {
		if !seen[key] {
			delete(c.containerPrevious, key)
		}
	}
}
