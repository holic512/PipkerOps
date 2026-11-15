package agent

import "time"

const (
	restartWindow    = 5 * time.Minute
	restartSampleGap = 90 * time.Second
)

type restartSample struct {
	at    time.Time
	count int
}

type containerRestartHistory map[string][]restartSample

// The Docker counter is cumulative for one Docker container ID. Count only
// deltas between observations inside the window, retaining one boundary sample.
func (history containerRestartHistory) observe(rows []map[string]any, now time.Time) containerRestartHistory {
	next := make(containerRestartHistory, len(rows))
	cutoff := now.Add(-restartWindow)
	for _, row := range rows {
		id, _ := row["id"].(string)
		count, valid := row["restartCount"].(int)
		if id == "" || !valid || count < 0 || row["inspectError"] != nil {
			continue
		}
		samples := history[id]
		if len(samples) > 0 {
			last := samples[len(samples)-1]
			if !now.After(last.at) || now.Sub(last.at) > restartSampleGap || count < last.count {
				samples = nil
			}
		}
		samples = append(samples, restartSample{at: now, count: count})
		for len(samples) > 1 && !samples[1].at.After(cutoff) {
			samples = samples[1:]
		}
		next[id] = samples
		first := samples[0]
		complete := first.at.Equal(cutoff)
		if first.at.Before(cutoff) {
			// A change across the boundary might have occurred before the window.
			complete = first.count == samples[1].count
			first = samples[1]
		}
		row["restartWindowComplete"] = complete
		if now.After(first.at) || complete {
			row["recentRestartCount"] = count - first.count
		}
	}
	return next
}
