package config

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

type entry struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type errorResponse struct {
	Error string `json:"error"`
}

type Client struct {
	baseURL string
	mu      sync.RWMutex
	cache   map[string]string
}

var (
	instance *Client
	once     sync.Once
)

// Init creates the singleton client, loads the cache, and must be called before Get/Set/etc.
func Init(baseURL string) (*Client, error) {
	var initErr error
	once.Do(func() {
		c := &Client{
			baseURL: strings.TrimRight(baseURL, "/"),
			cache:   make(map[string]string),
		}
		if err := c.syncCache(); err != nil {
			initErr = err
			return
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

// ── private ───────────────────────────────────────────────────────────────────

func (c *Client) do(method, path string, reqBody any) ([]byte, error) {
	var bodyReader io.Reader
	if reqBody != nil {
		b, err := json.Marshal(reqBody)
		if err != nil {
			return nil, fmt.Errorf("config: marshal request: %w", err)
		}
		bodyReader = strings.NewReader(string(b))
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
		return nil, fmt.Errorf("config: read response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		var errResp errorResponse
		_ = json.Unmarshal(data, &errResp)
		if errResp.Error != "" {
			return nil, fmt.Errorf("config: %s", errResp.Error)
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

// Get returns the cached value for key, or nil if not found.
// If forceFetch is true, the server is queried directly.
func (c *Client) Get(key string, forceFetch bool) (*string, error) {
	if !forceFetch {
		c.mu.RLock()
		val, ok := c.cache[key]
		c.mu.RUnlock()
		if !ok {
			return nil, nil
		}
		return &val, nil
	}

	data, err := c.do("GET", "/api/get?key="+url.QueryEscape(key), nil)
	if err != nil {
		if strings.Contains(err.Error(), "Key not found") {
			return nil, nil
		}
		return nil, err
	}
	var e entry
	if err := json.Unmarshal(data, &e); err != nil {
		return nil, fmt.Errorf("config: parse get response: %w", err)
	}
	return &e.Value, nil
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

// GetByPrefix returns all entries whose key starts with prefix.
func (c *Client) GetByPrefix(prefix string) ([]entry, error) {
	data, err := c.do("GET", "/api/prefix?prefix="+url.QueryEscape(prefix), nil)
	if err != nil {
		return nil, err
	}
	var entries []entry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("config: parse prefix response: %w", err)
	}
	return entries, nil
}

// ── write ─────────────────────────────────────────────────────────────────────

// Set creates or updates a key, then resyncs the cache.
func (c *Client) Set(key, value string) error {
	_, err := c.do("PUT", "/api/put", map[string]string{"key": key, "value": value})
	if err != nil {
		return err
	}
	return c.syncCache()
}

// SetMany creates or updates multiple entries, then resyncs the cache.
func (c *Client) SetMany(entries []entry) error {
	_, err := c.do("PUT", "/api/putmany", entries)
	if err != nil {
		return err
	}
	return c.syncCache()
}

// Delete removes a key, then resyncs the cache.
func (c *Client) Delete(key string) error {
	_, err := c.do("DELETE", "/api/delete?key="+url.QueryEscape(key), nil)
	if err != nil {
		return err
	}
	return c.syncCache()
}

// DeleteByPrefix removes all keys with the given prefix, then resyncs the cache.
func (c *Client) DeleteByPrefix(prefix string) error {
	_, err := c.do("DELETE", "/api/deleteprefix?prefix="+url.QueryEscape(prefix), nil)
	if err != nil {
		return err
	}
	return c.syncCache()
}

// DeleteAll removes all entries, then resyncs the cache.
func (c *Client) DeleteAll() error {
	_, err := c.do("DELETE", "/api/deleteall", nil)
	if err != nil {
		return err
	}
	return c.syncCache()
}
