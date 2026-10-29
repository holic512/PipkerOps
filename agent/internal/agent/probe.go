// @file probe.go
// @project PipkerOps
// @module agent/probes
// @description HTTP/TCP 探测、耗时测量和受限 JSON 字段映射。
// @logic 显式超时、限制响应体、拒绝自动跨协议重定向；HTTP 配置复用可信系统 CA。
// @dependencies Go standard library
// @index_tags agent, http, tcp, probes
// @author holic512
package agent

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type probeRequest struct {
	ProbeID   string `json:"probeId"`
	Type      string `json:"type"`
	Target    string `json:"target"`
	TimeoutMS int    `json:"timeoutMs"`
	Config    struct {
		Method         string            `json:"method"`
		Headers        map[string]string `json:"headers"`
		Body           string            `json:"body"`
		ExpectedStatus int               `json:"expectedStatus"`
	} `json:"config"`
	Mapping map[string]string `json:"mapping"`
}

func runProbe(ctx context.Context, payload json.RawMessage) (map[string]any, error) {
	var p probeRequest
	if err := json.Unmarshal(payload, &p); err != nil {
		return nil, err
	}
	if p.TimeoutMS == 0 {
		p.TimeoutMS = 5000
	}
	if p.TimeoutMS < 100 || p.TimeoutMS > 120000 {
		return nil, errors.New("timeoutMs must be between 100 and 120000")
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(p.TimeoutMS)*time.Millisecond)
	defer cancel()
	started := time.Now()
	result := map[string]any{"probeId": p.ProbeID, "type": p.Type, "target": p.Target, "success": false, "data": map[string]any{}}
	var probeErr error
	switch p.Type {
	case "TCP":
		host, port, e := net.SplitHostPort(p.Target)
		if e != nil || host == "" {
			return nil, errors.New("TCP target must be host:port")
		}
		n, e := strconv.Atoi(port)
		if e != nil || n < 1 || n > 65535 {
			return nil, errors.New("invalid TCP port")
		}
		conn, e := (&net.Dialer{}).DialContext(ctx, "tcp", p.Target)
		probeErr = e
		if e == nil {
			conn.Close()
		}
	case "HTTP":
		u, e := url.Parse(p.Target)
		if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
			return nil, errors.New("HTTP target must be a URL without userinfo")
		}
		method := strings.ToUpper(p.Config.Method)
		if method == "" {
			method = "GET"
		}
		switch method {
		case "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS":
		default:
			return nil, errors.New("unsupported HTTP method")
		}
		if len(p.Config.Body) > 128<<10 {
			return nil, errors.New("probe request body too large")
		}
		req, e := http.NewRequestWithContext(ctx, method, p.Target, bytes.NewBufferString(p.Config.Body))
		if e != nil {
			return nil, e
		}
		for name, value := range p.Config.Headers {
			req.Header.Set(name, value)
		}
		transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, Proxy: http.ProxyFromEnvironment}
		defer transport.CloseIdleConnections()
		client := &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != u.Scheme || req.URL.Host != u.Host {
				return errors.New("cross-origin redirect rejected")
			}
			return nil
		}}
		resp, e := client.Do(req)
		probeErr = e
		if e == nil {
			defer resp.Body.Close()
			result["statusCode"] = resp.StatusCode
			body, e := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
			if e != nil {
				probeErr = e
			} else if len(body) > 1<<20 {
				probeErr = errors.New("probe response exceeds 1 MiB")
			}
			if probeErr == nil {
				if p.Config.ExpectedStatus > 0 {
					if resp.StatusCode != p.Config.ExpectedStatus {
						probeErr = fmt.Errorf("expected HTTP %d, received %d", p.Config.ExpectedStatus, resp.StatusCode)
					}
				} else if resp.StatusCode < 200 || resp.StatusCode >= 400 {
					probeErr = fmt.Errorf("HTTP %d", resp.StatusCode)
				}
				if len(p.Mapping) > 0 {
					var document any
					if e = json.Unmarshal(body, &document); e != nil {
						probeErr = fmt.Errorf("response JSON: %w", e)
					} else {
						data := map[string]any{}
						for name, path := range p.Mapping {
							v, found := jsonField(document, path)
							if !found {
								probeErr = fmt.Errorf("JSON field missing: %s", path)
								break
							}
							data[name] = v
						}
						result["data"] = data
					}
				}
			}
		}
	default:
		return nil, errors.New("probe type must be HTTP or TCP")
	}
	result["latencyMs"] = float64(time.Since(started).Microseconds()) / 1000
	result["success"] = probeErr == nil
	if probeErr != nil {
		result["error"] = probeErr.Error()
	}
	return result, probeErr
}

func jsonField(value any, path string) (any, bool) {
	path = strings.TrimPrefix(strings.TrimPrefix(path, "$"), ".")
	if path == "" {
		return value, true
	}
	for _, part := range strings.Split(path, ".") {
		switch current := value.(type) {
		case map[string]any:
			var ok bool
			value, ok = current[part]
			if !ok {
				return nil, false
			}
		case []any:
			index, err := strconv.Atoi(part)
			if err != nil || index < 0 || index >= len(current) {
				return nil, false
			}
			value = current[index]
		default:
			return nil, false
		}
	}
	return value, true
}
