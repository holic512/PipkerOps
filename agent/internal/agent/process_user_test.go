package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/user"
	"testing"
)

func TestProcessUserUnknownUIDRemainsAvailable(t *testing.T) {
	r := newProcessUserResolver()
	calls := 0
	r.lookup = func(uid string) (*user.User, error) {
		calls++
		if uid != "70" {
			t.Fatalf("unexpected UID %s", uid)
		}
		return nil, fmt.Errorf("lookup: %w", user.UnknownUserIdError(70))
	}
	for i := 0; i < 35; i++ {
		owner, err := r.resolve([]uint32{70, 1000, 70, 70}, nil)
		if err != nil || !owner.HasUID || owner.UID != 70 || owner.Display != "UID 70" || owner.Resolved {
			t.Fatalf("numeric owner must remain usable: %+v, %v", owner, err)
		}
	}
	if calls != 1 {
		t.Fatalf("35 processes should share one lookup, got %d", calls)
	}
}
func TestProcessUserKnownUIDAndRoot(t *testing.T) {
	r := newProcessUserResolver()
	r.lookup = func(uid string) (*user.User, error) { return &user.User{Username: "root", Uid: uid}, nil }
	owner, err := r.resolve([]uint32{0}, nil)
	if err != nil || !owner.HasUID || owner.UID != 0 || !owner.Resolved || owner.Display != "root" {
		t.Fatalf("root is a valid UID: %+v, %v", owner, err)
	}
}
func TestProcessUserReadFailuresNeverInventUID(t *testing.T) {
	for _, readErr := range []error{os.ErrPermission, context.Canceled, os.ErrNotExist} {
		r := newProcessUserResolver()
		r.lookup = func(string) (*user.User, error) { t.Fatal("failed UID read must not look up a name"); return nil, nil }
		owner, err := r.resolve([]uint32{0}, readErr)
		if !errors.Is(err, readErr) || owner.HasUID || owner.Display != "" {
			t.Fatalf("failure lost: %+v, %v", owner, err)
		}
	}
	owner, err := newProcessUserResolver().resolve(nil, nil)
	if err == nil || owner.HasUID {
		t.Fatalf("empty UIDs must not become root: %+v", owner)
	}
}
func TestProcessUserLookupFailureIsStillReported(t *testing.T) {
	r := newProcessUserResolver()
	r.lookup = func(string) (*user.User, error) { return nil, os.ErrPermission }
	owner, err := r.resolve([]uint32{70}, nil)
	if !errors.Is(err, os.ErrPermission) || !owner.HasUID || owner.Display != "UID 70" {
		t.Fatalf("lookup failure was hidden: %+v, %v", owner, err)
	}
}
func TestProcessUserCacheDoesNotOutliveCollection(t *testing.T) {
	r := newProcessUserResolver()
	r.lookup = func(string) (*user.User, error) { return nil, user.UnknownUserIdError(70) }
	_, _ = r.resolve([]uint32{70}, nil)
	next := newProcessUserResolver()
	next.lookup = func(string) (*user.User, error) { return &user.User{Username: "new-account"}, nil }
	owner, err := next.resolve([]uint32{70}, nil)
	if err != nil || !owner.Resolved || owner.Display != "new-account" {
		t.Fatalf("new collection must resolve again: %+v, %v", owner, err)
	}
}
