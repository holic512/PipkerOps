// @file rotation.go
// @project PipkerOps
// @module agent/server-identity
// @description 自建私有 CA、HTTPS 证书、稳定节点 ID 和接入密钥。
// @logic 单份身份原子持久化；证书临期按原 CA 与私钥续签，接入包只导出 CA 公钥与调用密钥。
// @dependencies Go X509/TLS, private identity storage
// @index_tags agent, https, rotation, identity
// @author holic512
package agent

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const rotationWindow = 14 * 24 * time.Hour

type Connection struct {
	Format          int    `json:"format"`
	ProtocolVersion int    `json:"protocolVersion"`
	AgentID         string `json:"agentId"`
	URL             string `json:"url"`
	CAPEM           string `json:"caPem"`
	AccessKey       string `json:"accessKey"`
	DeployRoot      string `json:"deployRoot"`
}

type serverIdentity struct {
	AgentID        string `json:"agentId"`
	AccessKey      string `json:"accessKey"`
	CAPEM          string `json:"caPem"`
	CAKeyPEM       string `json:"caKeyPem"`
	CertificatePEM string `json:"certificatePem"`
	KeyPEM         string `json:"keyPem"`
}

type identityStore struct {
	mu       sync.Mutex
	config   Config
	identity serverIdentity
	pair     *tls.Certificate
}

func loadIdentity(c Config) (*identityStore, error) {
	dir := filepath.Join(c.StateDir, "identity")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	s := &identityStore{config: c}
	data, err := os.ReadFile(filepath.Join(dir, "identity.json"))
	if err == nil {
		if err = json.Unmarshal(data, &s.identity); err != nil {
			return nil, err
		}
		if !safeID.MatchString(s.identity.AgentID) {
			return nil, errors.New("saved agent id is invalid")
		}
		key, e := base64.RawURLEncoding.DecodeString(s.identity.AccessKey)
		if e != nil || len(key) != 32 {
			return nil, errors.New("saved access key is invalid")
		}
	} else if os.IsNotExist(err) {
		if err = s.initialize(time.Now()); err != nil {
			return nil, err
		}
	} else {
		return nil, err
	}
	if _, err = s.certificateAt(time.Now()); err != nil {
		return nil, err
	}
	return s, nil
}

func randomKey() (string, error) {
	var key [32]byte
	if _, err := rand.Read(key[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(key[:]), nil
}

func certificateSerial() (*big.Int, error) {
	return rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
}

func marshalPrivateKey(key *ecdsa.PrivateKey) (string, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), nil
}

func parsePrivateKey(raw string) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(raw))
	if block == nil {
		return nil, errors.New("private key is not PEM")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	private, ok := key.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errors.New("private key must be ECDSA")
	}
	return private, nil
}

func identityLeaf(raw string) (*x509.Certificate, error) {
	block, _ := pem.Decode([]byte(raw))
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("certificate is not PEM")
	}
	return x509.ParseCertificate(block.Bytes)
}

func (s *identityStore) initialize(now time.Time) error {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := certificateSerial()
	if err != nil {
		return err
	}
	ca := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "PipkerOps Agent private CA"}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(3650 * 24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	der, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		return err
	}
	caPEM, err := marshalPrivateKey(caKey)
	if err != nil {
		return err
	}
	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	keyPEM, err := marshalPrivateKey(serverKey)
	if err != nil {
		return err
	}
	accessKey, err := randomKey()
	if err != nil {
		return err
	}
	var id [16]byte
	if _, err = rand.Read(id[:]); err != nil {
		return err
	}
	s.identity = serverIdentity{AgentID: "agent-" + hex.EncodeToString(id[:]), AccessKey: accessKey, CAPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), CAKeyPEM: caPEM, KeyPEM: keyPEM}
	return nil
}

func (s *identityStore) persist(candidate serverIdentity) error {
	data, err := json.Marshal(candidate)
	if err != nil {
		return err
	}
	return privateWrite(filepath.Join(s.config.StateDir, "identity", "identity.json"), data)
}

func (s *identityStore) certificateAt(now time.Time) (*tls.Certificate, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, _ := url.Parse(s.config.PublicURL)
	ca, err := identityLeaf(s.identity.CAPEM)
	if err != nil {
		return nil, err
	}
	if !ca.IsCA || !ca.NotAfter.After(now.Add(rotationWindow)) {
		return nil, errors.New("Agent CA expires soon; replace the identity through local administration")
	}
	caKey, err := parsePrivateKey(s.identity.CAKeyPEM)
	if err != nil {
		return nil, err
	}
	caPub, err := x509.MarshalPKIXPublicKey(&caKey.PublicKey)
	if err != nil {
		return nil, err
	}
	certPub, err := x509.MarshalPKIXPublicKey(ca.PublicKey)
	if err != nil || string(caPub) != string(certPub) {
		return nil, errors.New("saved CA private key does not match certificate")
	}
	if s.pair == nil && s.identity.CertificatePEM != "" {
		pair, e := tls.X509KeyPair([]byte(s.identity.CertificatePEM), []byte(s.identity.KeyPEM))
		if e != nil {
			return nil, e
		}
		pair.Leaf, e = x509.ParseCertificate(pair.Certificate[0])
		if e != nil {
			return nil, e
		}
		roots := x509.NewCertPool()
		roots.AddCert(ca)
		if _, e = pair.Leaf.Verify(x509.VerifyOptions{Roots: roots, CurrentTime: pair.Leaf.NotBefore.Add(time.Second), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); e != nil {
			return nil, e
		}
		s.pair = &pair
	}
	if s.pair != nil && s.pair.Leaf.NotAfter.Sub(now) >= rotationWindow && s.pair.Leaf.VerifyHostname(u.Hostname()) == nil {
		return s.pair, nil
	}
	key, err := parsePrivateKey(s.identity.KeyPEM)
	if err != nil {
		return nil, err
	}
	serial, err := certificateSerial()
	if err != nil {
		return nil, err
	}
	cert := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: s.identity.AgentID}, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(90 * 24 * time.Hour), BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	if cert.NotAfter.After(ca.NotAfter) {
		cert.NotAfter = ca.NotAfter
	}
	seen := map[string]bool{}
	for _, host := range []string{u.Hostname(), "localhost", "127.0.0.1", "host.docker.internal"} {
		if seen[host] {
			continue
		}
		seen[host] = true
		if ip := net.ParseIP(host); ip != nil {
			cert.IPAddresses = append(cert.IPAddresses, ip)
		} else {
			cert.DNSNames = append(cert.DNSNames, host)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, cert, ca, &key.PublicKey, caKey)
	if err != nil {
		return nil, err
	}
	candidate := s.identity
	candidate.CertificatePEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	pair, err := tls.X509KeyPair([]byte(candidate.CertificatePEM), []byte(candidate.KeyPEM))
	if err != nil {
		return nil, err
	}
	pair.Leaf, err = x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	if err = s.persist(candidate); err != nil {
		return nil, err
	}
	s.identity = candidate
	s.pair = &pair
	return s.pair, nil
}

func (s *identityStore) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	return s.certificateAt(time.Now())
}

func (s *identityStore) connection() Connection {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Connection{Format: 1, ProtocolVersion: 1, AgentID: s.identity.AgentID, URL: strings.TrimRight(s.config.PublicURL, "/"), CAPEM: s.identity.CAPEM, AccessKey: s.identity.AccessKey, DeployRoot: filepath.Clean(s.config.DeployRoot)}
}

func ExportConnection(c Config) (Connection, error) {
	if err := c.Validate(); err != nil {
		return Connection{}, err
	}
	s, err := loadIdentity(c)
	if err != nil {
		return Connection{}, err
	}
	return s.connection(), nil
}

func ResetAccessKey(c Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	lock, err := lockState(c.StateDir)
	if err != nil {
		return err
	}
	defer lock.Close()
	s, err := loadIdentity(c)
	if err != nil {
		return err
	}
	key, err := randomKey()
	if err != nil {
		return err
	}
	s.identity.AccessKey = key
	return s.persist(s.identity)
}
