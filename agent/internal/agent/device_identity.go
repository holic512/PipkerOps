// @file device_identity.go
// @project PipkerOps
// @module agent/device-identity
// @description 读取 Linux 启动世代及设备内核身份，避免累计速率跨设备替换计算。
// @logic 网络使用启动ID、ifindex和MAC，块设备使用启动ID和diskseq；缺失时不猜测身份。
// @dependencies procfs, sysfs
// @index_tags metrics, devices, identity, counters
// @author holic512
package agent

import (
	"os"
	"path/filepath"
	"strings"
)

func readDeviceIdentities(root string, network, io []string) map[string]map[string]string {
	identities := map[string]map[string]string{"network": {}, "io": {}}
	boot := readIdentityFile(filepath.Join(root, "proc/sys/kernel/random/boot_id"))
	if boot == "" {
		return identities
	}
	for _, name := range network {
		base := filepath.Join(root, "sys/class/net", name)
		index, address := readIdentityFile(filepath.Join(base, "ifindex")), readIdentityFile(filepath.Join(base, "address"))
		if index != "" && address != "" {
			identities["network"][name] = boot + ":" + index + ":" + address
		}
	}
	for _, name := range io {
		base := filepath.Join(root, "sys/class/block", name)
		sequence := readIdentityFile(filepath.Join(base, "diskseq"))
		if sequence != "" {
			identities["io"][name] = boot + ":" + sequence
		}
	}
	return identities
}

func readIdentityFile(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}
