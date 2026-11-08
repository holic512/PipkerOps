package agent

import (
	"errors"
	"fmt"
	"os/user"
	"strconv"
)

type processUser struct {
	UID      uint32
	HasUID   bool
	Display  string
	Resolved bool
}
type processUserResult struct {
	value processUser
	err   error
}
type processUserResolver struct {
	lookup func(string) (*user.User, error)
	cache  map[uint32]processUserResult
}

// Cache only within this collection. Host account databases need not contain
// container UIDs, and a missing name does not make the numeric owner unavailable.
func newProcessUserResolver() *processUserResolver {
	return &processUserResolver{lookup: user.LookupId, cache: map[uint32]processUserResult{}}
}
func (r *processUserResolver) resolve(uids []uint32, readErr error) (processUser, error) {
	if readErr != nil {
		return processUser{}, readErr
	}
	if len(uids) == 0 {
		return processUser{}, errors.New("process UID is unavailable")
	}
	// Match gopsutil UsernameWithContext: the first entry is the real UID.
	uid := uids[0]
	if cached, ok := r.cache[uid]; ok {
		return cached.value, cached.err
	}
	value := processUser{UID: uid, HasUID: true, Display: "UID " + strconv.FormatUint(uint64(uid), 10)}
	account, err := r.lookup(strconv.FormatUint(uint64(uid), 10))
	var unknown user.UnknownUserIdError
	switch {
	case err == nil && account != nil && account.Username != "":
		value.Display, value.Resolved = account.Username, true
	case errors.As(err, &unknown):
		err = nil
	case err == nil:
		err = fmt.Errorf("username lookup returned no account for UID %d", uid)
	}
	r.cache[uid] = processUserResult{value, err}
	return value, err
}
