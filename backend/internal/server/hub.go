package server

import (
	"encoding/json"
	"sync"
)

// Message is a realtime notification pushed over SSE. Payloads only carry
// IDs/counters; clients refetch through their own authorised endpoint, so
// the stream never leaks photo URLs or private data.
//
//	photo.published  {id}         photo became visible (READY + approved)
//	photos.changed   {}           something changed (moderation, processing)
//	photo.removed    {id}         hidden or deleted
//	photo.liked      {id, likes}
//	event.updated    {}
type Message struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

// Hub fans out messages to SSE clients, partitioned by event ID so a
// subscriber of event A never receives anything about event B.
type Hub struct {
	mu      sync.Mutex
	clients map[string]map[chan []byte]struct{}
}

func NewHub() *Hub {
	return &Hub{clients: make(map[string]map[chan []byte]struct{})}
}

func (h *Hub) Subscribe(eventID string) chan []byte {
	ch := make(chan []byte, 16)
	h.mu.Lock()
	if h.clients[eventID] == nil {
		h.clients[eventID] = make(map[chan []byte]struct{})
	}
	h.clients[eventID][ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *Hub) Unsubscribe(eventID string, ch chan []byte) {
	h.mu.Lock()
	if set := h.clients[eventID]; set != nil {
		if _, ok := set[ch]; ok {
			delete(set, ch)
			close(ch)
		}
		if len(set) == 0 {
			delete(h.clients, eventID)
		}
	}
	h.mu.Unlock()
}

func (h *Hub) Count(eventID string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients[eventID])
}

func (h *Hub) Publish(eventID, msgType string, data any) {
	if data == nil {
		data = struct{}{}
	}
	b, err := json.Marshal(Message{Type: msgType, Data: data})
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.clients[eventID] {
		select {
		case ch <- b:
		default: // slow client: drop rather than block everyone
		}
	}
}
