// @file collector.go
// @project PipkerOps
// @module agent/metrics
// @description 本机 CPU、内存、文件系统、网络、IO、进程、端口与 Docker 采集。
// @logic 限制进程/端口/容器数量；逐项报告权限或采集失败，不生成模拟数据。
// @dependencies gopsutil/v4, Docker CLI (optional)
// @index_tags agent, metrics, linux
// @author holic512
package agent

import (
	"context"
	"encoding/json"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/mem"
	gnet "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
)

func Collect(ctx context.Context) map[string]any {
	hostname, _ := os.Hostname()
	result := map[string]any{"hostname": hostname, "os": runtime.GOOS, "arch": runtime.GOARCH, "agentVersion": Version, "recordedAt": time.Now().UTC().Format(time.RFC3339Nano), "disk": []any{}, "network": []any{}, "io": map[string]any{}, "processes": []any{}, "ports": []any{}, "containers": []any{}}
	errors := []string{}
	if values, err := cpu.PercentWithContext(ctx, 200*time.Millisecond, false); err == nil && len(values) > 0 {
		result["cpuPercent"] = values[0]
	} else if err != nil {
		errors = append(errors, "cpu: "+err.Error())
	}
	if memory, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		result["memoryPercent"] = memory.UsedPercent
		result["memory"] = memory
	} else {
		errors = append(errors, "memory: "+err.Error())
	}
	filesystems := []any{}
	if partitions, err := disk.PartitionsWithContext(ctx, false); err == nil {
		for i, p := range partitions {
			if i >= 64 {
				break
			}
			usage, e := disk.UsageWithContext(ctx, p.Mountpoint)
			if e == nil {
				filesystems = append(filesystems, map[string]any{"device": p.Device, "mountpoint": p.Mountpoint, "fstype": p.Fstype, "total": usage.Total, "used": usage.Used, "free": usage.Free, "usedPercent": usage.UsedPercent})
			} else {
				errors = append(errors, "disk "+p.Mountpoint+": "+e.Error())
			}
		}
	} else {
		errors = append(errors, "disk: "+err.Error())
	}
	result["disk"] = filesystems
	if network, err := gnet.IOCountersWithContext(ctx, true); err == nil {
		if len(network) > 64 {
			network = network[:64]
		}
		result["network"] = network
	} else {
		errors = append(errors, "network: "+err.Error())
	}
	if counters, err := disk.IOCountersWithContext(ctx); err == nil {
		result["io"] = counters
	} else {
		errors = append(errors, "io: "+err.Error())
	}
	procs := []any{}
	if ids, err := process.PidsWithContext(ctx); err == nil {
		result["processCount"] = len(ids)
		for i, id := range ids {
			if i >= 80 || ctx.Err() != nil {
				break
			}
			p, e := process.NewProcessWithContext(ctx, id)
			if e != nil {
				continue
			}
			name, _ := p.NameWithContext(ctx)
			memory, _ := p.MemoryPercentWithContext(ctx)
			procs = append(procs, map[string]any{"pid": id, "name": name, "memoryPercent": memory})
		}
	} else {
		errors = append(errors, "processes: "+err.Error())
	}
	result["processes"] = procs
	if conns, err := gnet.ConnectionsMaxWithContext(ctx, "inet", 256); err == nil {
		ports := []any{}
		for _, conn := range conns {
			if conn.Status == "LISTEN" || conn.Type == 2 {
				ports = append(ports, map[string]any{"pid": conn.Pid, "type": conn.Type, "address": conn.Laddr.IP, "port": conn.Laddr.Port, "status": conn.Status})
				if len(ports) >= 256 {
					break
				}
			}
		}
		result["ports"] = ports
	} else {
		errors = append(errors, "ports: "+err.Error())
	}
	dockerCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if output, err := runCommand(dockerCtx, nil, "docker", "ps", "-a", "--no-trunc", "--format", "{{json .}}"); err == nil {
		containers := []any{}
		for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
			var container map[string]any
			if json.Unmarshal([]byte(line), &container) == nil {
				containers = append(containers, map[string]any{"id": container["ID"], "name": container["Names"], "image": container["Image"], "state": container["State"], "status": container["Status"], "ports": container["Ports"], "composeProject": container["Labels"]})
			}
			if len(containers) >= 200 {
				break
			}
		}
		result["containers"] = containers
	} else {
		errors = append(errors, "docker: "+err.Error())
	}
	result["collectionErrors"] = errors
	return result
}
