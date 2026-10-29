// @file rotation.go
// @project PipkerOps
// @module agent/certificate-rotation
// @description 已认证 mTLS 连接上的客户端证书自动轮换。
// @logic 有效期不足14天且每小时最多一次请求；校验私钥/节点/证书链后原子保存身份再重连。
// @dependencies Go TLS/X509, private identity storage, Gateway cert.renew protocol
// @index_tags agent, mtls, rotation, certificates
// @author holic512
package agent

import (
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

var errIdentityRotated = errors.New("client identity rotated")

const rotationWindow = 14 * 24 * time.Hour
const rotationRetry = time.Hour
const rotationRequestTTL = 15 * time.Minute

func randomRequestID() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	id[6] = (id[6] & 0x0f) | 0x40
	id[8] = (id[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16]), nil
}

func (c *Client) currentTLS() *tls.Config {
	c.rotationMu.Lock()
	defer c.rotationMu.Unlock()
	return c.tlsConfig.Clone()
}

func (c *Client) rotationRequest(now time.Time) (*Message, error) {
	c.rotationMu.Lock()
	defer c.rotationMu.Unlock()
	if c.identity == nil {
		return nil, nil
	}
	current, err := identityLeaf(c.identity.CertificatePEM)
	if err != nil {
		return nil, err
	}
	if current.NotAfter.Sub(now) >= rotationWindow {
		return nil, nil
	}
	if !c.rotationLastAttempt.IsZero() && now.Sub(c.rotationLastAttempt) < rotationRetry {
		return nil, nil
	}
	if c.rotationRequestID != "" && now.Sub(c.rotationRequestedAt) < rotationRequestTTL {
		return nil, nil
	}
	c.rotationLastAttempt = now
	csr, err := os.ReadFile(filepath.Join(c.config.StateDir, "agent.csr"))
	if err != nil {
		return nil, err
	}
	if len(csr) > 10000 {
		return nil, errors.New("saved CSR exceeds 10000 bytes")
	}
	id, err := randomRequestID()
	if err != nil {
		return nil, err
	}
	c.rotationRequestID = id
	c.rotationRequestedAt = now
	return &Message{Type: "cert.renew", RequestID: id, CSRPEM: string(csr)}, nil
}

func identityLeaf(certificatePEM string) (*x509.Certificate, error) {
	// tls.X509KeyPair is validated separately; decoding here only reads expiry.
	block, _ := pem.Decode([]byte(certificatePEM))
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("identity certificate is not PEM")
	}
	return x509.ParseCertificate(block.Bytes)
}

func (c *Client) maybeRenewCertificate() {
	message, err := c.rotationRequest(time.Now())
	if err != nil {
		slog.Warn("cannot prepare client certificate renewal", "error", err)
		return
	}
	if message == nil {
		return
	}
	if err = c.send(*message); err != nil {
		c.rotationMu.Lock()
		if c.rotationRequestID == message.RequestID {
			c.rotationRequestID = ""
		}
		c.rotationMu.Unlock()
		slog.Warn("client certificate renewal request could not be sent", "error", err)
	}
}

func (c *Client) acceptRenewedIdentity(message Message, now time.Time) error {
	c.rotationMu.Lock()
	defer c.rotationMu.Unlock()
	if c.rotationRequestID == "" || message.RequestID != c.rotationRequestID {
		return errors.New("certificate renewal response has no matching pending request")
	}
	if now.Sub(c.rotationRequestedAt) > rotationRequestTTL {
		return errors.New("certificate renewal response expired")
	}
	c.rotationRequestID = ""
	if message.Type == "cert.renew.error" {
		return errors.New("gateway rejected client certificate renewal")
	}
	if message.CertificatePEM == "" || len(message.CertificatePEM) > 128<<10 || len(message.CACertificatePEM) > 128<<10 {
		return errors.New("renewed certificate/CA is missing or too large")
	}
	keyPEM, err := os.ReadFile(filepath.Join(c.config.StateDir, "agent.key"))
	if err != nil {
		return err
	}
	oldCertificate, err := identityLeaf(c.identity.CertificatePEM)
	if err != nil {
		return err
	}
	candidate := *c.identity
	candidate.CertificatePEM = message.CertificatePEM
	if message.CACertificatePEM != "" {
		candidate.CAPEM = message.CACertificatePEM
	}
	tlsConfig, err := identityTLS(c.config, &candidate, keyPEM)
	if err != nil {
		return fmt.Errorf("renewed client identity rejected: %w", err)
	}
	if !tlsConfig.Certificates[0].Leaf.NotAfter.After(oldCertificate.NotAfter) {
		return errors.New("renewed certificate does not extend the current validity period")
	}
	encoded, err := json.Marshal(&candidate)
	if err != nil {
		return err
	}
	if err = privateWrite(filepath.Join(c.config.StateDir, "identity.json"), encoded); err != nil {
		return fmt.Errorf("renewed client identity was not persisted: %w", err)
	}
	c.identity = &candidate
	c.tlsConfig = tlsConfig
	return nil
}
