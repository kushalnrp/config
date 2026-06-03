package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type entry struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type errorResponse struct {
	Error string `json:"error"`
}

// Client talks to the config server and keeps a local in-memory cache.
// Call Init once at startup; use Get/Set/Delete from any goroutine.
type Client struct {
	baseURL string
	mu      sync.RWMutex
	cache   map[string]string
	stop    chan struct{}
}

var (
	instance *Client
	once     sync.Once
)

// Init creates the singleton client, seeds the local cache from the server,
// and starts a background goroutine that reloads all keys every reloadInterval.
// Pass 0 to disable the background reload.
func Init(baseURL string, reloadInterval time.Duration) (*Client, error) {
	var initErr error
	once.Do(func() {
		c := &Client{
			baseURL: strings.TrimRight(baseURL, "/"),
			cache:   make(map[string]string),
			stop:    make(chan struct{}),
		}
		if err := c.syncCache(); err != nil {
			initErr = err
			return
		}
		if reloadInterval > 0 {
			go c.reloadLoop(reloadInterval)
		}
		instance = c
	})
	if initErr != nil {
		return nil, initErr
	}
	return instance, nil
}

// GetInstance returns the singleton; panics if Init has not been called.
func GetInstance() *Client {
	if instance == nil {
		panic("config: Init must be called before GetInstance")
	}
	return instance
}

// Close stops the background reload goroutine.
func (c *Client) Close() {
	close(c.stop)
}

// ResetInstance stops any background reload and clears the singleton.
// Intended for tests.
func ResetInstance() {
	if instance != nil {
		instance.Close()
		instance = nil
	}
	once = sync.Once{}
}

// ── private ───────────────────────────────────────────────────────────────────

func (c *Client) reloadLoop(interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			_ = c.syncCache()
		case <-c.stop:
			return
		}
	}
}

func (c *Client) do(method, path string, reqBody any) ([]byte, error) {
	var bodyReader io.Reader
	if reqBody != nil {
		b, err := json.Marshal(reqBody)
		if err != nil {
			return nil, fmt.Errorf("config: marshal request: %w", err)
		}
		bodyReader = bytes.NewReader(b)
	}

	req, err := http.NewRequest(method, c.baseURL+path, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("config: build request: %w", err)
	}
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("config: server unreachable: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("config: read response: %w", err)
	}
	if resp.StatusCode >= 400 {
		var e errorResponse
		_ = json.Unmarshal(data, &e)
		if e.Error != "" {
			return nil, fmt.Errorf("config: %s", e.Error)
		}
		return nil, fmt.Errorf("config: request failed with status %d", resp.StatusCode)
	}
	return data, nil
}

func (c *Client) syncCache() error {
	data, err := c.do("GET", "/api/getall", nil)
	if err != nil {
		return err
	}
	var entries []entry
	if err := json.Unmarshal(data, &entries); err != nil {
		return fmt.Errorf("config: parse getall response: %w", err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cache = make(map[string]string, len(entries))
	for _, e := range entries {
		c.cache[e.Key] = e.Value
	}
	return nil
}

// ── read ──────────────────────────────────────────────────────────────────────

// Get returns the value for key.
// Checks the local cache first; if the key is absent, fetches it from the
// server once and stores it so future reads stay local.
// Returns ("", false) when the key does not exist.
func (c *Client) Get(key string) (string, bool, error) {
	c.mu.RLock()
	val, ok := c.cache[key]
	c.mu.RUnlock()
	if ok {
		return val, true, nil
	}

	data, err := c.do("GET", "/api/get?key="+url.QueryEscape(key), nil)
	if err != nil {
		if strings.Contains(err.Error(), "Key not found") {
			return "", false, nil
		}
		return "", false, err
	}
	var e entry
	if err := json.Unmarshal(data, &e); err != nil {
		return "", false, fmt.Errorf("config: parse get response: %w", err)
	}
	c.mu.Lock()
	c.cache[key] = e.Value
	c.mu.Unlock()
	return e.Value, true, nil
}

// GetAll returns all entries from the server.
func (c *Client) GetAll() ([]entry, error) {
	data, err := c.do("GET", "/api/getall", nil)
	if err != nil {
		return nil, err
	}
	var entries []entry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("config: parse getall response: %w", err)
	}
	return entries, nil
}

// ── write ─────────────────────────────────────────────────────────────────────

// Set creates or updates a key and updates the local cache directly.
func (c *Client) Set(key, value string) error {
	_, err := c.do("PUT", "/api/put", map[string]string{"key": key, "value": value})
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.cache[key] = value
	c.mu.Unlock()
	return nil
}

// Delete removes a key and evicts it from the local cache.
func (c *Client) Delete(key string) error {
	_, err := c.do("DELETE", "/api/delete?key="+url.QueryEscape(key), nil)
	if err != nil {
		return err
	}
	c.mu.Lock()
	delete(c.cache, key)
	c.mu.Unlock()
	return nil
}
