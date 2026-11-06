// Versioned telemetry: independent schedules, bounded inventory, real counter deltas.
package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	gnet "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
)

type metricPoint struct {
	Metric string   `json:"metric"`
	Device string   `json:"device"`
	Unit   string   `json:"unit"`
	Value  *float64 `json:"value"`
}
type telemetry struct {
	SchemaVersion int            `json:"schemaVersion"`
	BootID        string         `json:"bootId"`
	Sequence      uint64         `json:"sequence"`
	Category      string         `json:"category"`
	SampledAt     string         `json:"sampledAt"`
	DurationMS    float64        `json:"durationMs"`
	Data          map[string]any `json:"data"`
	Series        []metricPoint  `json:"series"`
	Errors        []string       `json:"errors"`
	Truncated     bool           `json:"truncated"`
}

func (t *telemetry) point(metric, device, unit string, value float64) {
	if !math.IsNaN(value) && !math.IsInf(value, 0) {
		t.Series = append(t.Series, metricPoint{metric, device, unit, &value})
	}
}
func (t *telemetry) failure(name string, err error) {
	t.Errors = append(t.Errors, name+": "+err.Error())
}

type counterSample struct {
	value    float64
	at       time.Time
	identity string
}
type telemetryCollector struct {
	previous map[string]counterSample
	cpu      map[string]cpu.TimesStat
}

func newTelemetryCollector() *telemetryCollector {
	return &telemetryCollector{previous: map[string]counterSample{}, cpu: map[string]cpu.TimesStat{}}
}

// Counter resets, replaced devices and missing identities never produce a rate.
func (c *telemetryCollector) rate(key, identity string, value float64, at time.Time) *float64 {
	old, ok := c.previous[key]
	c.previous[key] = counterSample{value, at, identity}
	elapsed := at.Sub(old.at).Seconds()
	if !ok || identity == "" || old.identity != identity || value < old.value || elapsed <= 0 || elapsed > 120 {
		return nil
	}
	rate := (value - old.value) / elapsed
	return &rate
}
func (c *telemetryCollector) counter(t *telemetry, metric, device, unit, identity string, value float64, at time.Time) *float64 {
	v := c.rate(metric+":"+device, identity, value, at)
	t.Series = append(t.Series, metricPoint{metric, device, unit, v})
	return v
}
func newTelemetry(category string) telemetry {
	return telemetry{SchemaVersion: 2, Category: category, SampledAt: time.Now().UTC().Format(time.RFC3339Nano), Data: map[string]any{}, Series: []metricPoint{}, Errors: []string{}}
}
func (c *telemetryCollector) collect(ctx context.Context, category string) telemetry {
	t := newTelemetry(category)
	start := time.Now()
	switch category {
	case "fast":
		c.fast(ctx, &t)
	case "disks":
		c.disks(ctx, &t)
	case "details":
		c.details(ctx, &t)
	case "static":
		c.static(ctx, &t)
	}
	t.DurationMS = float64(time.Since(start).Microseconds()) / 1000
	if ctx.Err() != nil {
		t.failure(category, ctx.Err())
	}
	return t
}
func cpuTotal(v cpu.TimesStat) float64 {
	return v.User + v.Nice + v.System + v.Idle + v.Iowait + v.Irq + v.Softirq + v.Steal
}
func (c *telemetryCollector) fast(ctx context.Context, t *telemetry) {
	at := time.Now()
	boot := readIdentityFile("/proc/sys/kernel/random/boot_id")
	for _, perCPU := range []bool{false, true} {
		values, err := cpu.TimesWithContext(ctx, perCPU)
		if err != nil {
			t.failure("cpu", err)
			continue
		}
		cores := []map[string]any{}
		for _, v := range values {
			old, ok := c.cpu[v.CPU]
			c.cpu[v.CPU] = v
			total := cpuTotal(v) - cpuTotal(old)
			if !ok || total <= 0 {
				continue
			}
			fields := map[string]float64{"user": v.User - old.User, "system": v.System - old.System, "idle": v.Idle - old.Idle, "iowait": v.Iowait - old.Iowait, "steal": v.Steal - old.Steal}
			usage := math.Max(0, math.Min(100, 100*(total-(v.Idle-old.Idle)-(v.Iowait-old.Iowait))/total))
			if !perCPU {
				t.Data["cpuPercent"] = usage
				t.point("cpu.total", "", "%", usage)
				for name, value := range fields {
					t.point("cpu."+name, "", "%", math.Max(0, 100*value/total))
				}
			} else {
				cores = append(cores, map[string]any{"name": v.CPU, "percent": usage})
				if len(cores) >= 256 {
					t.Truncated = true
					break
				}
			}
		}
		if perCPU {
			t.Data["cpuCores"] = cores
		}
	}
	if v, err := load.AvgWithContext(ctx); err == nil {
		t.Data["load"] = v
		t.point("load.1", "", "", v.Load1)
		t.point("load.5", "", "", v.Load5)
		t.point("load.15", "", "", v.Load15)
		t.point("load.normalized", "", "%", v.Load1/float64(runtime.NumCPU())*100)
	} else {
		t.failure("load", err)
	}
	if v, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		t.Data["memory"] = v
		t.Data["memoryPercent"] = v.UsedPercent
		t.point("memory.percent", "", "%", v.UsedPercent)
		t.point("memory.used", "", "B", float64(v.Used))
		t.point("memory.available", "", "B", float64(v.Available))
		t.point("memory.free", "", "B", float64(v.Free))
		t.point("memory.cached", "", "B", float64(v.Cached))
		t.point("memory.buffers", "", "B", float64(v.Buffers))
	} else {
		t.failure("memory", err)
	}
	if v, err := mem.SwapMemoryWithContext(ctx); err == nil {
		t.Data["swap"] = v
		t.point("swap.percent", "", "%", v.UsedPercent)
		t.point("swap.used", "", "B", float64(v.Used))
		c.counter(t, "swap.in", "", "B/s", boot, float64(v.Sin), at)
		c.counter(t, "swap.out", "", "B/s", boot, float64(v.Sout), at)
	} else {
		t.failure("swap", err)
	}
	networks, err := gnet.IOCountersWithContext(ctx, true)
	networkNames := []string{}
	if err != nil {
		t.failure("network", err)
	}
	if len(networks) > 64 {
		networks = networks[:64]
		t.Truncated = true
	}
	for _, v := range networks {
		networkNames = append(networkNames, v.Name)
	}
	ios, ioErr := disk.IOCountersWithContext(ctx)
	ioNames := []string{}
	for name := range ios {
		ioNames = append(ioNames, name)
	}
	sort.Strings(ioNames)
	if len(ioNames) > 128 {
		ioNames = ioNames[:128]
		t.Truncated = true
	}
	identities := readDeviceIdentities("/", networkNames, ioNames)
	t.Data["deviceIdentity"] = identities
	rates := []map[string]any{}
	for _, v := range networks {
		identity := identities["network"][v.Name]
		rx := c.counter(t, "network.recv", v.Name, "B/s", identity, float64(v.BytesRecv), at)
		tx := c.counter(t, "network.sent", v.Name, "B/s", identity, float64(v.BytesSent), at)
		c.counter(t, "network.recvPackets", v.Name, "pps", identity, float64(v.PacketsRecv), at)
		c.counter(t, "network.sentPackets", v.Name, "pps", identity, float64(v.PacketsSent), at)
		c.counter(t, "network.recvErrors", v.Name, "/s", identity, float64(v.Errin), at)
		c.counter(t, "network.sentErrors", v.Name, "/s", identity, float64(v.Errout), at)
		c.counter(t, "network.recvDrops", v.Name, "/s", identity, float64(v.Dropin), at)
		c.counter(t, "network.sentDrops", v.Name, "/s", identity, float64(v.Dropout), at)
		rates = append(rates, map[string]any{"name": v.Name, "recvPerSecond": rx, "sentPerSecond": tx, "errorsIn": v.Errin, "errorsOut": v.Errout, "dropsIn": v.Dropin, "dropsOut": v.Dropout})
	}
	t.Data["network"] = networks
	t.Data["networkRates"] = rates
	if ioErr != nil {
		t.failure("io", ioErr)
	}
	ioValues := map[string]disk.IOCountersStat{}
	ioRates := []map[string]any{}
	for _, name := range ioNames {
		v := ios[name]
		ioValues[name] = v
		identity := identities["io"][name]
		read := c.counter(t, "io.read", name, "B/s", identity, float64(v.ReadBytes), at)
		write := c.counter(t, "io.write", name, "B/s", identity, float64(v.WriteBytes), at)
		reads := c.counter(t, "io.readIOPS", name, "IOPS", identity, float64(v.ReadCount), at)
		writes := c.counter(t, "io.writeIOPS", name, "IOPS", identity, float64(v.WriteCount), at)
		readTime := c.rate("io.readTime:"+name, identity, float64(v.ReadTime), at)
		writeTime := c.rate("io.writeTime:"+name, identity, float64(v.WriteTime), at)
		util := c.rate("io.busy:"+name, identity, float64(v.IoTime), at)
		queue := c.rate("io.queue:"+name, identity, float64(v.WeightedIO), at)
		var readLatency, writeLatency, utilPercent, queueDepth *float64
		if reads != nil && readTime != nil && *reads > 0 {
			x := *readTime / *reads
			readLatency = &x
			t.point("io.readLatency", name, "ms", x)
		}
		if writes != nil && writeTime != nil && *writes > 0 {
			x := *writeTime / *writes
			writeLatency = &x
			t.point("io.writeLatency", name, "ms", x)
		}
		if util != nil {
			x := *util / 10
			utilPercent = &x
			t.point("io.util", name, "%", x)
		}
		if queue != nil {
			x := *queue / 1000
			queueDepth = &x
			t.point("io.queue", name, "", x)
		}
		ioRates = append(ioRates, map[string]any{"name": name, "readPerSecond": read, "writePerSecond": write, "readIOPS": reads, "writeIOPS": writes, "readLatency": readLatency, "writeLatency": writeLatency, "utilPercent": utilPercent, "queueDepth": queueDepth})
	}
	t.Data["io"] = ioValues
	t.Data["ioRates"] = ioRates
	for key, sample := range c.previous {
		if at.Sub(sample.at) > 5*time.Minute {
			delete(c.previous, key)
		}
	}
}
func (c *telemetryCollector) disks(ctx context.Context, t *telemetry) {
	partitions, err := disk.PartitionsWithContext(ctx, false)
	if err != nil {
		t.failure("disk", err)
		return
	}
	if len(partitions) == 0 {
		partitions = []disk.PartitionStat{{Mountpoint: "/"}}
	}
	values := []map[string]any{}
	for i, p := range partitions {
		if i >= 64 {
			t.Truncated = true
			break
		}
		if ctx.Err() != nil {
			break
		}
		v, e := disk.UsageWithContext(ctx, p.Mountpoint)
		if e != nil {
			t.failure(p.Mountpoint, e)
			continue
		}
		var freeBytes any
		var fs syscall.Statfs_t
		if err := syscall.Statfs(p.Mountpoint, &fs); err == nil {
			freeBytes = uint64(fs.Bfree) * uint64(fs.Bsize)
		}
		values = append(values, map[string]any{"device": p.Device, "mountpoint": p.Mountpoint, "fstype": p.Fstype, "total": v.Total, "used": v.Used, "free": freeBytes, "available": v.Free, "usedPercent": v.UsedPercent, "inodesTotal": v.InodesTotal, "inodesUsed": v.InodesUsed, "inodesFree": v.InodesFree, "inodesUsedPercent": v.InodesUsedPercent, "options": p.Opts})
		t.point("disk.percent", p.Mountpoint, "%", v.UsedPercent)
		t.point("disk.used", p.Mountpoint, "B", float64(v.Used))
		t.point("disk.free", p.Mountpoint, "B", float64(v.Free))
		if v.InodesTotal > 0 {
			t.point("disk.inodePercent", p.Mountpoint, "%", v.InodesUsedPercent)
		}
	}
	t.Data["disk"] = values
}
func (c *telemetryCollector) static(ctx context.Context, t *telemetry) {
	if v, err := host.InfoWithContext(ctx); err == nil {
		t.Data["system"] = v
		t.Data["hostname"] = v.Hostname
		t.Data["os"] = v.OS
		t.Data["arch"] = runtime.GOARCH
		t.Data["agentVersion"] = Version
	} else {
		t.failure("host", err)
	}
	if v, err := cpu.InfoWithContext(ctx); err == nil {
		if len(v) > 256 {
			v = v[:256]
			t.Truncated = true
		}
		t.Data["cpuInfo"] = v
	} else {
		t.failure("cpuInfo", err)
	}
	t.Data["logicalCores"] = runtime.NumCPU()
	if v, err := cpu.CountsWithContext(ctx, false); err == nil {
		t.Data["physicalCores"] = v
	}
	if v, err := gnet.InterfacesWithContext(ctx); err == nil {
		if len(v) > 64 {
			v = v[:64]
			t.Truncated = true
		}
		t.Data["interfaces"] = v
		links := []map[string]any{}
		for _, iface := range v {
			var speed any
			if n, err := strconv.ParseInt(readIdentityFile("/sys/class/net/"+iface.Name+"/speed"), 10, 64); err == nil && n > 0 {
				speed = n
			}
			links = append(links, map[string]any{"name": iface.Name, "state": readIdentityFile("/sys/class/net/" + iface.Name + "/operstate"), "speedMbps": speed})
		}
		t.Data["links"] = links
	} else {
		t.failure("interfaces", err)
	}
}
func (c *telemetryCollector) processes(ctx context.Context, t *telemetry) {
	ids, err := process.PidsWithContext(ctx)
	if err != nil {
		t.failure("processes", err)
		return
	}
	t.Data["processCount"] = len(ids)
	states := map[string]int{}
	values := []map[string]any{}
	at := time.Now()
	seen := map[string]bool{}
	for i, id := range ids {
		if i >= 5000 || ctx.Err() != nil {
			t.Truncated = true
			break
		}
		p, err := process.NewProcessWithContext(ctx, id)
		if err != nil {
			continue
		}
		name, _ := p.NameWithContext(ctx)
		created, e := p.CreateTimeWithContext(ctx)
		identity := ""
		if e == nil {
			identity = fmt.Sprintf("%d:%d", id, created)
		}
		cpuValue := (*float64)(nil)
		if times, e := p.TimesWithContext(ctx); e == nil {
			key := fmt.Sprintf("process:%d", id)
			cpuValue = c.rate(key, identity, times.User+times.System, at)
			seen[key] = true
			if cpuValue != nil {
				v := *cpuValue * 100
				cpuValue = &v
			}
		}
		memory, memoryErr := p.MemoryInfoWithContext(ctx)
		threads, threadErr := p.NumThreadsWithContext(ctx)
		user, userErr := p.UsernameWithContext(ctx)
		status, statusErr := p.StatusWithContext(ctx)
		if statusErr == nil {
			for _, s := range status {
				states[s]++
			}
		}
		value := map[string]any{"pid": id, "name": name, "cpuPercent": cpuValue}
		if threadErr == nil {
			value["threads"] = threads
		}
		if userErr == nil {
			value["user"] = user
		}
		if statusErr == nil {
			value["status"] = status
		}
		if memoryErr == nil {
			value["rss"] = memory.RSS
			value["vms"] = memory.VMS
		}
		if v, e := p.MemoryPercentWithContext(ctx); e == nil {
			value["memoryPercent"] = v
		}
		if v, e := p.IOCountersWithContext(ctx); e == nil {
			value["io"] = v
		}
		values = append(values, value)
	}
	for key := range c.previous {
		if strings.HasPrefix(key, "process:") && !seen[key] {
			delete(c.previous, key)
		}
	}
	sort.Slice(values, func(i, j int) bool {
		a, _ := values[i]["cpuPercent"].(*float64)
		b, _ := values[j]["cpuPercent"].(*float64)
		if a == nil {
			return false
		}
		if b == nil {
			return true
		}
		return *a > *b
	})
	cpuTop := values
	if len(cpuTop) > 80 {
		cpuTop = cpuTop[:80]
	}
	memoryTop := append([]map[string]any{}, values...)
	sort.Slice(memoryTop, func(i, j int) bool {
		a, _ := memoryTop[i]["rss"].(uint64)
		b, _ := memoryTop[j]["rss"].(uint64)
		return a > b
	})
	if len(memoryTop) > 80 {
		memoryTop = memoryTop[:80]
	}
	t.Data["processes"] = cpuTop
	t.Data["memoryTop"] = memoryTop
	t.Data["processStates"] = states
	t.Data["processSampled"] = len(values)
	t.Data["processLimit"] = 80
}
func collectConnections(ctx context.Context, t *telemetry) {
	values, err := gnet.ConnectionsMaxWithContext(ctx, "inet", 2048)
	if err != nil {
		t.failure("connections", err)
		return
	}
	counts := map[string]int{}
	ports := []map[string]any{}
	for _, v := range values {
		state := v.Status
		if v.Type == 2 {
			state = "UDP"
		}
		counts[state]++
		if v.Status == "LISTEN" || v.Type == 2 {
			if len(ports) < 256 {
				ports = append(ports, map[string]any{"pid": v.Pid, "address": v.Laddr.IP, "port": v.Laddr.Port, "status": state})
			} else {
				t.Truncated = true
			}
		}
	}
	if len(values) >= 2048 {
		t.Truncated = true
	}
	t.Data["connections"] = counts
	t.Data["ports"] = ports
	t.Data["connectionLimit"] = 2048
}
func collectContainers(ctx context.Context, t *telemetry) {
	output, err := runCommand(ctx, nil, "docker", "ps", "-a", "--no-trunc", "--format", "{{json .}}")
	if err != nil {
		t.failure("docker", err)
		return
	}
	values := []map[string]any{}
	ids := []string{}
	byID := map[string]map[string]any{}
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		var raw map[string]any
		if json.Unmarshal([]byte(line), &raw) != nil {
			continue
		}
		id, _ := raw["ID"].(string)
		v := map[string]any{"id": id, "name": raw["Names"], "image": raw["Image"], "state": raw["State"], "status": raw["Status"], "ports": raw["Ports"]}
		values = append(values, v)
		ids = append(ids, id)
		byID[id] = v
		if len(values) >= 200 {
			t.Truncated = true
			break
		}
	}
	if len(ids) > 0 {
		args := append([]string{"inspect", "--format", `{"id":{{json .Id}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"restartCount":{{.RestartCount}},"composeProject":{{json (index .Config.Labels "com.docker.compose.project")}},"composeService":{{json (index .Config.Labels "com.docker.compose.service")}}}`}, ids...)
		if out, e := runCommand(ctx, nil, "docker", args...); e == nil {
			for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
				var raw map[string]any
				if json.Unmarshal([]byte(line), &raw) == nil {
					if v := byID[fmt.Sprint(raw["id"])]; v != nil {
						for k, x := range raw {
							v[k] = x
						}
					}
				}
			}
		} else {
			t.failure("dockerInspect", e)
		}
		running := []string{}
		for _, v := range values {
			if v["state"] == "running" {
				running = append(running, fmt.Sprint(v["id"]))
			}
		}
		if len(running) > 0 {
			args = append([]string{"stats", "--no-stream", "--no-trunc", "--format", "{{json .}}"}, running...)
			if out, e := runCommand(ctx, nil, "docker", args...); e == nil {
				for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
					var raw map[string]any
					if json.Unmarshal([]byte(line), &raw) == nil {
						if v := byID[fmt.Sprint(raw["ID"])]; v != nil {
							v["stats"] = raw
						}
					}
				}
			} else {
				t.failure("dockerStats", e)
			}
		}
	}
	t.Data["containers"] = values
	counts := map[string]int{}
	for _, value := range values {
		counts[fmt.Sprint(value["state"])]++
	}
	t.Data["containerStates"] = counts
}
func (c *telemetryCollector) details(ctx context.Context, t *telemetry) {
	type result struct {
		category string
		data     telemetry
	}
	ch := make(chan result, 4)
	var wg sync.WaitGroup
	for _, name := range []string{"processes", "connections", "services", "containers"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			child, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			part := newTelemetry("details")
			switch name {
			case "processes":
				c.processes(child, &part)
			case "connections":
				collectConnections(child, &part)
			case "services":
				if _, err := os.Stat("/run/systemd/system"); err == nil {
					if v, e := collectServices(child); e == nil {
						part.Data["services"] = v
						counts := map[string]int{}
						for _, unit := range v {
							counts[unit["active"]]++
						}
						part.Data["serviceStates"] = counts
						if len(v) >= 200 {
							part.Truncated = true
						}
					} else {
						part.failure("systemd", e)
					}
				} else {
					part.failure("systemd", fmt.Errorf("not supported"))
				}
			case "containers":
				collectContainers(child, &part)
			}
			if child.Err() != nil {
				part.failure(name, child.Err())
			}
			ch <- result{name, part}
		}(name)
	}
	wg.Wait()
	close(ch)
	for part := range ch {
		for key, value := range part.data.Data {
			t.Data[key] = value
		}
		t.Errors = append(t.Errors, part.data.Errors...)
		t.Truncated = t.Truncated || part.data.Truncated
	}
}

func (c *Client) monitorV2(ctx context.Context, conn *websocket.Conn) {
	boot := readIdentityFile("/proc/sys/kernel/random/boot_id")
	if boot == "" {
		boot = fmt.Sprintf("agent-%d", time.Now().UnixNano())
	}
	// A connection owns its collectors and sends; old goroutines cannot write into a replacement socket.
	send := func(message Message) error {
		data, err := json.Marshal(message)
		if err != nil {
			return err
		}
		if len(data) > maxFrame {
			return fmt.Errorf("telemetry exceeds frame limit")
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.conn != conn || ctx.Err() != nil {
			return context.Canceled
		}
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return conn.WriteMessage(websocket.TextMessage, data)
	}
	for _, schedule := range []struct {
		name              string
		period, timeLimit time.Duration
	}{{"fast", 5 * time.Second, 3 * time.Second}, {"disks", 15 * time.Second, 5 * time.Second}, {"details", 30 * time.Second, 8 * time.Second}, {"static", 10 * time.Minute, 5 * time.Second}} {
		go func(name string, period, limit time.Duration) {
			collector := newTelemetryCollector()
			ticker := time.NewTicker(period)
			defer ticker.Stop()
			var sequence uint64
			for {
				if ctx.Err() != nil {
					return
				}
				child, cancel := context.WithTimeout(ctx, limit)
				frame := collector.collect(child, name)
				cancel()
				if ctx.Err() != nil {
					return
				}
				sequence++
				frame.BootID = boot
				frame.Sequence = sequence
				if err := send(Message{Type: "telemetry", Payload: frame}); err != nil {
					return
				}
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}(schedule.name, schedule.period, schedule.timeLimit)
	}
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		if send(Message{Type: "heartbeat", Payload: map[string]any{"agentVersion": Version, "timestamp": time.Now().UTC().Format(time.RFC3339Nano)}}) != nil {
			return
		}
		c.mu.Lock()
		if c.conn == conn {
			_ = conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
		}
		c.mu.Unlock()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
