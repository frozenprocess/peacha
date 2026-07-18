package server

import (
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sync"
)

// lruCache is a tiny size-bounded cache keyed by sha256(canonical-json(req)).
// We don't reach for an external dependency because the access pattern is
// trivial (Get/Set, no TTL, no weights) and the implementation is ~40 lines.
//
// Goroutine-safe. Backing map + doubly-linked list, classic LRU.
type lruCache struct {
	mu     sync.Mutex
	max    int
	items  map[string]*list.Element
	order  *list.List
}

type cacheEntry struct {
	key  string
	resp *EditorResponse
}

func newLRU(max int) *lruCache {
	if max <= 0 {
		max = 1
	}
	return &lruCache{
		max:   max,
		items: make(map[string]*list.Element, max),
		order: list.New(),
	}
}

// requestKey is a deterministic fingerprint of an EditorRequest. We
// json.Marshal a value of *EditorRequest via a tiny canonicalisation pass
// (map keys are emitted alphabetically by encoding/json already), then hash.
// Two requests that the engine would treat identically produce the same key.
func requestKey(req *EditorRequest) (string, error) {
	b, err := json.Marshal(req)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func (c *lruCache) Get(key string) (*EditorResponse, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[key]
	if !ok {
		return nil, false
	}
	c.order.MoveToFront(el)
	return el.Value.(*cacheEntry).resp, true
}

func (c *lruCache) Set(key string, resp *EditorResponse) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.order.MoveToFront(el)
		el.Value.(*cacheEntry).resp = resp
		return
	}
	el := c.order.PushFront(&cacheEntry{key: key, resp: resp})
	c.items[key] = el
	for c.order.Len() > c.max {
		victim := c.order.Back()
		if victim == nil {
			break
		}
		c.order.Remove(victim)
		delete(c.items, victim.Value.(*cacheEntry).key)
	}
}
