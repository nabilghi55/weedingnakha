// Package audit writes an append-only JSON Lines log of sensitive actions.
// Entries never contain raw tokens, PINs, or precise guest coordinates.
package audit

import (
	"bufio"
	"encoding/json"
	"os"
	"sync"
	"time"

	"github.com/nakhasolution/weedingnakha/backend/internal/security"
)

type ActorType string

const (
	ActorAdmin  ActorType = "admin"
	ActorHost   ActorType = "host"
	ActorSystem ActorType = "system"
	ActorGuest  ActorType = "guest"
)

type Entry struct {
	ID        string            `json:"id"`
	ActorType ActorType         `json:"actorType"`
	ActorID   string            `json:"actorId"`
	EventID   string            `json:"eventId,omitempty"`
	Action    string            `json:"action"`
	TargetID  string            `json:"targetId,omitempty"`
	Metadata  map[string]string `json:"metadata,omitempty"`
	CreatedAt time.Time         `json:"createdAt"`
}

type Log struct {
	mu   sync.Mutex
	path string
	now  func() time.Time
}

func Open(path string, now func() time.Time) *Log {
	if now == nil {
		now = time.Now
	}
	return &Log{path: path, now: now}
}

func (l *Log) Write(e Entry) {
	e.ID = security.RandomHex(8)
	e.CreatedAt = l.now().UTC()
	b, err := json.Marshal(e)
	if err != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	if _, err := f.Write(append(b, '\n')); err == nil {
		_ = f.Sync() // audit entries must survive a crash
	}
}

// Snapshot returns the full log contents (for backups).
func (l *Log) Snapshot() []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, _ := os.ReadFile(l.path)
	return b
}

// Recent returns up to limit entries, newest first, optionally for one event.
func (l *Log) Recent(eventID string, limit int) []Entry {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := []Entry{}
	f, err := os.Open(l.path)
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		var e Entry
		if json.Unmarshal(sc.Bytes(), &e) != nil {
			continue
		}
		if eventID != "" && e.EventID != eventID {
			continue
		}
		out = append(out, e)
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}
