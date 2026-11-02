package agent

import (
	"crypto/x509"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

func fixtureConfig(t *testing.T) Config {
	t.Helper()
	root := t.TempDir()
	return Config{Listen: "127.0.0.1:9443", PublicURL: "https://agent.example.invalid:9443", Name: "test-agent", StateDir: filepath.Join(root, "data", "agent"), DeployRoot: root}
}

func TestServerIdentityPersistsAndRotatesLeafOnly(t *testing.T) {
	c := fixtureConfig(t)
	store, err := loadIdentity(c)
	if err != nil {
		t.Fatal(err)
	}
	before := store.connection()
	if before.Format != 1 || before.ProtocolVersion != 1 || before.AgentID == "" || before.AccessKey == "" {
		t.Fatalf("invalid connection: %#v", before)
	}
	initial, err := store.certificateAt(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, host := range []string{"agent.example.invalid", "localhost", "127.0.0.1", "host.docker.internal"} {
		if err = initial.Leaf.VerifyHostname(host); err != nil {
			t.Fatal(err)
		}
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM([]byte(before.CAPEM))
	if _, err = initial.Leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: "agent.example.invalid"}); err != nil {
		t.Fatal(err)
	}
	if _, err = initial.Leaf.Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}); err == nil {
		t.Fatal("server certificate accepted for client authentication")
	}
	longLived, err := store.certificateAt(time.Now().Add(24 * time.Hour))
	if err != nil || longLived != initial {
		t.Fatalf("long-lived certificate rotated: %v", err)
	}
	next, err := store.certificateAt(initial.Leaf.NotAfter.Add(-rotationWindow + time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if !next.Leaf.NotAfter.After(initial.Leaf.NotAfter) {
		t.Fatal("leaf validity was not extended")
	}
	if !reflect.DeepEqual(before, store.connection()) {
		t.Fatal("rotation changed trust root, agent ID or access key")
	}
	reloaded, err := loadIdentity(c)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, reloaded.connection()) || reloaded.pair.Leaf.SerialNumber.Cmp(next.Leaf.SerialNumber) != 0 {
		t.Fatal("identity/leaf did not survive reload")
	}
	info, err := os.Stat(filepath.Join(c.StateDir, "identity", "identity.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("identity permissions: %v %v", info, err)
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := store.GetCertificate(nil); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
}

func TestLeafRotationWriteFailureKeepsLiveIdentity(t *testing.T) {
	c := fixtureConfig(t)
	store, err := loadIdentity(c)
	if err != nil {
		t.Fatal(err)
	}
	old := store.pair
	path := filepath.Join(c.StateDir, "identity", "identity.json")
	if err = os.Rename(path, path+".saved"); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err = store.certificateAt(old.Leaf.NotAfter.Add(-time.Hour)); err == nil {
		t.Fatal("unwritable identity accepted")
	}
	if store.pair != old {
		t.Fatal("failed persistence replaced the live certificate")
	}
}

func TestResetAccessKeyRetainsIdentityAndRequiresStoppedAgent(t *testing.T) {
	c := fixtureConfig(t)
	before, err := ExportConnection(c)
	if err != nil {
		t.Fatal(err)
	}
	lock, err := lockState(c.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	if err = ResetAccessKey(c); err == nil {
		t.Fatal("running Agent key was reset")
	}
	lock.Close()
	if err = ResetAccessKey(c); err != nil {
		t.Fatal(err)
	}
	after, err := ExportConnection(c)
	if err != nil {
		t.Fatal(err)
	}
	if before.AccessKey == after.AccessKey {
		t.Fatal("key did not change")
	}
	after.AccessKey = before.AccessKey
	if !reflect.DeepEqual(before, after) {
		t.Fatal("key reset replaced stable identity")
	}
}
