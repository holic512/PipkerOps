// @file config.go
// @project PipkerOps
// @module agent/config
// @description Agent 配置、TLS 信任及本地身份持久化。
// @logic 首次生成私钥与 CSR；可信 HTTPS 注册；审批通过后验证客户端证书并保存。
// @dependencies Go standard library
// @index_tags agent, tls, enrollment
// @author holic512
package agent

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const Version = "0.1.0"
const maxFrame = 2 << 20
const maxOutput = 256 << 10

type Config struct {
	Gateway, EnrollURL, Token, TokenFile, Name, StateDir, CAFile string
}

type identity struct {
	ID             string `json:"id"`
	Status         string `json:"status"`
	CertificatePEM string `json:"certificatePem"`
	CAPEM          string `json:"caPem"`
}

func (c Config) Validate() error {
	for _, p := range []struct{ raw, scheme string }{{c.Gateway, "wss"}, {c.EnrollURL, "https"}} {
		u, err := url.Parse(p.raw)
		if err != nil || u.Scheme != p.scheme || u.Hostname() == "" || u.User != nil {
			return fmt.Errorf("endpoint must be %s without userinfo", p.scheme)
		}
	}
	if !filepath.IsAbs(c.StateDir) || filepath.Clean(c.StateDir) == string(filepath.Separator) || c.Name == "" || len(c.Name) > 120 {
		return errors.New("a name up to 120 bytes and an absolute state-dir are required")
	}
	return nil
}

func privateWrite(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".agent-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func trustPool(c Config) (*x509.CertPool, error) {
	pool, err := x509.SystemCertPool()
	if err != nil {
		pool = x509.NewCertPool()
	}
	if c.CAFile != "" {
		b, e := os.ReadFile(c.CAFile)
		if e != nil {
			return nil, e
		}
		if !pool.AppendCertsFromPEM(b) {
			return nil, errors.New("CA file contains no certificates")
		}
	}
	if b, e := os.ReadFile(filepath.Join(c.StateDir, "ca.pem")); e == nil {
		if !pool.AppendCertsFromPEM(b) {
			return nil, errors.New("saved CA contains no certificates")
		}
	}
	return pool, nil
}

func enroll(ctx context.Context, c Config) (*identity, *tls.Config, error) {
	if err := os.MkdirAll(c.StateDir, 0700); err != nil {
		return nil, nil, err
	}
	if err := os.Chmod(c.StateDir, 0700); err != nil {
		return nil, nil, err
	}
	keyPath := filepath.Join(c.StateDir, "agent.key")
	keyPEM, err := os.ReadFile(keyPath)
	if os.IsNotExist(err) {
		key, e := rsa.GenerateKey(rand.Reader, 2048)
		if e != nil {
			return nil, nil, e
		}
		der, e := x509.MarshalPKCS8PrivateKey(key)
		if e != nil {
			return nil, nil, e
		}
		keyPEM = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
		err = privateWrite(keyPath, keyPEM)
	}
	if err != nil {
		return nil, nil, err
	}
	if err = os.Chmod(keyPath, 0600); err != nil {
		return nil, nil, err
	}
	block, _ := pem.Decode(keyPEM)
	if block == nil {
		return nil, nil, errors.New("invalid private key")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, nil, err
	}
	csrPath := filepath.Join(c.StateDir, "agent.csr")
	csrPEM, err := os.ReadFile(csrPath)
	if os.IsNotExist(err) {
		der, e := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: c.Name}}, key)
		if e != nil {
			return nil, nil, e
		}
		csrPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})
		err = privateWrite(csrPath, csrPEM)
	}
	if err != nil {
		return nil, nil, err
	}
	pool, err := trustPool(c)
	if err != nil {
		return nil, nil, err
	}
	client := &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool}}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	id := new(identity)
	idPath := filepath.Join(c.StateDir, "identity.json")
	if b, e := os.ReadFile(idPath); e == nil {
		if e = json.Unmarshal(b, id); e != nil {
			return nil, nil, e
		}
	}
	if id.CertificatePEM == "" {
		if c.TokenFile != "" {
			info, e := os.Lstat(c.TokenFile)
			if e != nil {
				return nil, nil, e
			}
			if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
				return nil, nil, errors.New("token-file must be a private regular file (0600 or 0400)")
			}
			f, e := os.Open(c.TokenFile)
			if e != nil {
				return nil, nil, e
			}
			token, e := io.ReadAll(io.LimitReader(f, 258))
			f.Close()
			if e != nil {
				return nil, nil, e
			}
			c.Token = strings.TrimSpace(string(token))
			if len(c.Token) < 20 || len(c.Token) > 256 {
				return nil, nil, errors.New("token-file must contain one valid enrollment token")
			}
		}
		if c.Token == "" {
			return nil, nil, errors.New("enrollment token required for first registration")
		}
		hostname, _ := os.Hostname()
		for {
			endpoint := strings.TrimRight(c.EnrollURL, "/") + "/enroll"
			payload := map[string]any{"token": c.Token, "name": c.Name, "hostname": hostname, "os": runtime.GOOS, "arch": runtime.GOARCH, "agentVersion": Version, "csrPem": string(csrPEM)}
			if id.ID != "" {
				endpoint += "/status"
				payload = map[string]any{"token": c.Token, "nodeId": id.ID, "csrPem": string(csrPEM)}
			}
			b, _ := json.Marshal(payload)
			req, e := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(b))
			if e != nil {
				return nil, nil, e
			}
			req.Header.Set("Content-Type", "application/json")
			resp, e := client.Do(req)
			if e != nil {
				return nil, nil, fmt.Errorf("enrollment connection: %w", e)
			}
			data, e := io.ReadAll(io.LimitReader(resp.Body, 128<<10))
			resp.Body.Close()
			if e != nil {
				return nil, nil, e
			}
			if resp.StatusCode < 200 || resp.StatusCode >= 300 {
				return nil, nil, fmt.Errorf("enrollment rejected (HTTP %d)", resp.StatusCode)
			}
			if e = json.Unmarshal(data, id); e != nil {
				return nil, nil, e
			}
			if id.ID == "" {
				return nil, nil, errors.New("enrollment response has no node id")
			}
			if id.Status == "REJECTED" || id.Status == "REVOKED" {
				return nil, nil, fmt.Errorf("node enrollment %s", id.Status)
			}
			if id.CertificatePEM != "" {
				break
			}
			pending, _ := json.Marshal(id)
			if e = privateWrite(idPath, pending); e != nil {
				return nil, nil, e
			}
			select {
			case <-ctx.Done():
				return nil, nil, ctx.Err()
			case <-time.After(10 * time.Second):
			}
		}
		if id.CAPEM != "" {
			if !pool.AppendCertsFromPEM([]byte(id.CAPEM)) {
				return nil, nil, errors.New("gateway CA invalid")
			}
			if err = privateWrite(filepath.Join(c.StateDir, "ca.pem"), []byte(id.CAPEM)); err != nil {
				return nil, nil, err
			}
		}
		pair, e := tls.X509KeyPair([]byte(id.CertificatePEM), keyPEM)
		if e != nil {
			return nil, nil, fmt.Errorf("issued certificate/key mismatch: %w", e)
		}
		cert, e := x509.ParseCertificate(pair.Certificate[0])
		if e != nil {
			return nil, nil, e
		}
		if _, e = cert.Verify(x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); e != nil {
			return nil, nil, fmt.Errorf("issued certificate verification: %w", e)
		}
		encoded, _ := json.Marshal(id)
		if err = privateWrite(idPath, encoded); err != nil {
			return nil, nil, err
		}
	}
	tlsConfig, err := identityTLS(c, id, keyPEM)
	if err != nil {
		return nil, nil, err
	}
	return id, tlsConfig, nil
}

// identity.json is the atomic source of truth for renewed certificate and CA.
// ca.pem remains a bootstrap compatibility file and is never partially rotated.
func identityTLS(c Config, id *identity, keyPEM []byte) (*tls.Config, error) {
	pool, err := trustPool(c)
	if err != nil {
		return nil, err
	}
	if id.CAPEM != "" && !pool.AppendCertsFromPEM([]byte(id.CAPEM)) {
		return nil, errors.New("identity CA contains no certificates")
	}
	pair, err := tls.X509KeyPair([]byte(id.CertificatePEM), keyPEM)
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, err
	}
	if id.Status != "APPROVED" || cert.Subject.CommonName != id.ID {
		return nil, errors.New("client certificate must be approved and bound to the enrolled node")
	}
	intermediates := x509.NewCertPool()
	for _, der := range pair.Certificate[1:] {
		chainCert, e := x509.ParseCertificate(der)
		if e != nil {
			return nil, e
		}
		intermediates.AddCert(chainCert)
	}
	if _, err = cert.Verify(x509.VerifyOptions{Roots: pool, Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err != nil {
		return nil, fmt.Errorf("saved client certificate is invalid or expired: %w", err)
	}
	pair.Leaf = cert
	return &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool, Certificates: []tls.Certificate{pair}}, nil
}
