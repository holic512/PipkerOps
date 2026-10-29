package agent

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

type testSigner struct {
	certificate *x509.Certificate
	key         *ecdsa.PrivateKey
	serial      int64
}

func newTestSigner(t *testing.T) *testSigner {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "rotation-test-ca"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(400 * 24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err = x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &testSigner{certificate: cert, key: key, serial: 1}
}
func (s *testSigner) issue(t *testing.T, id string, key *rsa.PrivateKey, expires time.Time) string {
	t.Helper()
	s.serial++
	cert := &x509.Certificate{SerialNumber: big.NewInt(s.serial), Subject: pkix.Name{CommonName: id}, NotBefore: time.Now().Add(-time.Hour), NotAfter: expires, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, s.certificate, &key.PublicKey, s.key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func rotationTestClient(t *testing.T, remaining time.Duration) (*Client, *testSigner, *rsa.PrivateKey) {
	t.Helper()
	dir := t.TempDir()
	signer := newTestSigner(t)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	if err = privateWrite(filepath.Join(dir, "agent.key"), keyPEM); err != nil {
		t.Fatal(err)
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: "initial-display-name"}}, key)
	if err != nil {
		t.Fatal(err)
	}
	if err = privateWrite(filepath.Join(dir, "agent.csr"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER})); err != nil {
		t.Fatal(err)
	}
	id := &identity{ID: "node-rotation", Status: "APPROVED", CertificatePEM: signer.issue(t, "node-rotation", key, time.Now().Add(remaining)), CAPEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: signer.certificate.Raw}))}
	encoded, err := json.Marshal(id)
	if err != nil {
		t.Fatal(err)
	}
	if err = privateWrite(filepath.Join(dir, "identity.json"), encoded); err != nil {
		t.Fatal(err)
	}
	config := Config{StateDir: dir}
	tlsConfig, err := identityTLS(config, id, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	return &Client{config: config, identity: id, tlsConfig: tlsConfig}, signer, key
}

func TestCertificateRotationIsThrottledValidatedAndAtomic(t *testing.T) {
	c, signer, key := rotationTestClient(t, 10*24*time.Hour)
	now := time.Now()
	before, err := os.ReadFile(filepath.Join(c.config.StateDir, "identity.json"))
	if err != nil {
		t.Fatal(err)
	}
	request, err := c.rotationRequest(now)
	if err != nil || request == nil || request.Type != "cert.renew" || request.RequestID == "" || request.CSRPEM == "" {
		t.Fatalf("renewal request: %v %v", request, err)
	}
	if duplicate, err := c.rotationRequest(now.Add(30 * time.Minute)); err != nil || duplicate != nil {
		t.Fatalf("renewal was not rate limited: %v %v", duplicate, err)
	}
	valid := signer.issue(t, "node-rotation", key, now.Add(90*24*time.Hour))
	if err = c.acceptRenewedIdentity(Message{Type: "cert.renewed", RequestID: "unsolicited", CertificatePEM: valid}, now); err == nil {
		t.Fatal("unsolicited identity accepted")
	}
	wrongNode := signer.issue(t, "other-node", key, now.Add(90*24*time.Hour))
	if err = c.acceptRenewedIdentity(Message{Type: "cert.renewed", RequestID: request.RequestID, CertificatePEM: wrongNode}, now); err == nil {
		t.Fatal("wrong-node certificate accepted")
	}
	after, err := os.ReadFile(filepath.Join(c.config.StateDir, "identity.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("failed renewal modified durable identity")
	}
	request, err = c.rotationRequest(now.Add(time.Hour))
	if err != nil || request == nil {
		t.Fatalf("hourly retry missing: %v %v", request, err)
	}
	if err = c.acceptRenewedIdentity(Message{Type: "cert.renewed", RequestID: request.RequestID, CertificatePEM: valid}, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if c.identity.CertificatePEM != valid || !c.currentTLS().Certificates[0].Leaf.NotAfter.After(now.Add(80*24*time.Hour)) {
		t.Fatal("renewed identity not active for next connection")
	}
	if next, err := c.rotationRequest(now.Add(2 * time.Hour)); err != nil || next != nil {
		t.Fatal("long-lived certificate requested another rotation")
	}
	persisted, _, err := enroll(context.Background(), Config{StateDir: c.config.StateDir})
	if err != nil {
		t.Fatalf("rotation did not survive restart: %v", err)
	}
	if persisted.CertificatePEM != valid {
		t.Fatal("restart did not load rotated certificate")
	}
}

func TestCertificateRotationRejectsKeyMismatchExpiryAndWriteFailure(t *testing.T) {
	c, signer, key := rotationTestClient(t, 10*24*time.Hour)
	now := time.Now()
	request, err := c.rotationRequest(now)
	if err != nil {
		t.Fatal(err)
	}
	otherKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	wrongKey := signer.issue(t, "node-rotation", otherKey, now.Add(90*24*time.Hour))
	if err = c.acceptRenewedIdentity(Message{Type: "cert.renewed", RequestID: request.RequestID, CertificatePEM: wrongKey}, now); err == nil {
		t.Fatal("key mismatch accepted")
	}
	request, err = c.rotationRequest(now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	shorter := signer.issue(t, "node-rotation", key, now.Add(5*24*time.Hour))
	if err = c.acceptRenewedIdentity(Message{Type: "cert.renewed", RequestID: request.RequestID, CertificatePEM: shorter}, now.Add(time.Hour)); err == nil {
		t.Fatal("shorter-lived certificate accepted")
	}
	request, err = c.rotationRequest(now.Add(2 * time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	valid := signer.issue(t, "node-rotation", key, now.Add(90*24*time.Hour))
	if err = c.acceptRenewedIdentity(Message{Type: "cert.renewed", RequestID: request.RequestID, CertificatePEM: valid}, now.Add(2*time.Hour+rotationRequestTTL+time.Second)); err == nil {
		t.Fatal("expired renewal request accepted")
	}
	request, err = c.rotationRequest(now.Add(3 * time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	oldPEM := c.identity.CertificatePEM
	identityPath := filepath.Join(c.config.StateDir, "identity.json")
	if err = os.Rename(identityPath, identityPath+".saved"); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(identityPath, 0700); err != nil {
		t.Fatal(err)
	}
	if err = c.acceptRenewedIdentity(Message{Type: "cert.renewed", RequestID: request.RequestID, CertificatePEM: valid}, now.Add(3*time.Hour)); err == nil {
		t.Fatal("unwritable identity path accepted")
	}
	if c.identity.CertificatePEM != oldPEM {
		t.Fatal("write failure changed live identity")
	}
}

func TestCertificateRotationSkipsLongLivedIdentity(t *testing.T) {
	c, _, _ := rotationTestClient(t, 90*24*time.Hour)
	request, err := c.rotationRequest(time.Now())
	if err != nil || request != nil {
		t.Fatalf("long-lived certificate rotated: %v %v", request, err)
	}
}
