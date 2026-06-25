package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

type entry struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type errorResponse struct {
	Error string `json:"error"`
}

type clientOptions struct {
	reloadInterval time.Duration
	natsURL        string
	natsUser       string
	natsPass       string
}

type changeListener struct {
	key      string
	callback func(newVal, oldVal string)
}

// Option configures the Client.
type Option func(*clientOptions)

// WithReloadInterval overrides the fallback poll interval (default 5 min).
// Pass 0 to disable polling (only useful when NATS is configured).
func WithReloadInterval(d time.Duration) Option {
	return func(o *clientOptions) { o.reloadInterval = d }
}

// WithNATS subscribes to config.updated on the given NATS server so the cache
// is refreshed immediately whenever a key is written or deleted.
// user and pass may be empty for unauthenticated servers.
func WithNATS(natsURL, user, pass string) Option {
	return func(o *clientOptions) {
		o.natsURL = natsURL
		o.natsUser = user
		o.natsPass = pass
	}
}

// Client talks to the config server and keeps a local in-memory cache.
// Call Init once at startup; use Get/Set/Delete from any goroutine.
type Client struct {
	baseURL     string
	mu          sync.RWMutex
	cache       map[string]string
	initialized bool
	stop        chan struct{}
	nc          *nats.Conn
	sub         *nats.Subscription
	listenersMu sync.RWMutex
	listeners   map[string][]func(newVal, oldVal string)
}

var (
	instance *Client
	once     sync.Once
)

// Init creates the singleton client, seeds the local cache from the server,
// and starts a background poll (default 5 min) plus an optional NATS subscription
// for immediate cache refresh on any config.updated message.
func Init(baseURL string, opts ...Option) (*Client, error) {
	o := &clientOptions{reloadInterval: 5 * time.Minute}
	for _, opt := range opts {
		opt(o)
	}

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

		// NATS subscription for push-based cache refresh.
		if o.natsURL != "" {
			natsopts := []nats.Option{
				nats.MaxReconnects(-1),
				nats.ReconnectWait(2 * time.Second),
				nats.ConnectHandler(func(nc *nats.Conn) {
					log.Printf("[config] NATS connected: %s", nc.ConnectedUrl())
				}),
				nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
					if err != nil {
						log.Printf("[config] NATS disconnected: %v", err)
					} else {
						log.Printf("[config] NATS disconnected")
					}
				}),
				nats.ReconnectHandler(func(nc *nats.Conn) {
					log.Printf("[config] NATS reconnected: %s", nc.ConnectedUrl())
				}),
				nats.ClosedHandler(func(_ *nats.Conn) {
					log.Printf("[config] NATS connection closed")
				}),
				nats.ErrorHandler(func(_ *nats.Conn, _ *nats.Subscription, err error) {
					log.Printf("[config] NATS error: %v", err)
				}),
			}
			if o.natsUser != "" {
				natsopts = append(natsopts, nats.UserInfo(o.natsUser, o.natsPass))
			}
			nc, err := nats.Connect(o.natsURL, natsopts...)
			if err != nil {
				log.Printf("[config] NATS connect failed, using poll-only mode: %v", err)
			} else {
				c.nc = nc
				sub, err := nc.Subscribe("config.updated", func(msg *nats.Msg) {
					log.Printf("[config] NATS: config.updated received (key=%s), reloading cache", string(msg.Data))
					_ = c.syncCache()
				})
				if err != nil {
					log.Printf("[config] NATS subscribe failed: %v", err)
				} else {
					c.sub = sub
				}
			}
		}

		// Fallback poll.
		if o.reloadInterval > 0 {
			go c.reloadLoop(o.reloadInterval)
		}

		instance = c
	})
	if initErr != nil {
		return nil, initErr
	}
	return instance, nil
}

// OnChange registers a callback that fires whenever key's value changes during
// a cache refresh. The callback receives (newVal, oldVal); newVal is "" when
// the key was deleted. Callbacks are not fired on the first (init-time) sync.
func (c *Client) OnChange(key string, callback func(newVal, oldVal string)) {
	c.listenersMu.Lock()
	defer c.listenersMu.Unlock()
	if c.listeners == nil {
		c.listeners = make(map[string][]func(string, string))
	}
	c.listeners[key] = append(c.listeners[key], callback)
}

// Reload re-fetches all config from the server, updates the cache, and fires
// any registered OnChange callbacks for keys whose values changed.
func (c *Client) Reload() error {
	return c.syncCache()
}

// GetInstance returns the singleton; panics if Init has not been called.
func GetInstance() *Client {
	if instance == nil {
		panic("config: Init must be called before GetInstance")
	}
	return instance
}

// Close stops the background poll and drains the NATS connection.
func (c *Client) Close() {
	close(c.stop)
	if c.sub != nil {
		_ = c.sub.Unsubscribe()
	}
	if c.nc != nil {
		c.nc.Drain() //nolint:errcheck
	}
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
			log.Printf("[config] poll: reloading cache")
			if err := c.syncCache(); err != nil {
				log.Printf("[config] poll: reload failed: %v", err)
			}
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

	newCache := make(map[string]string, len(entries))
	for _, e := range entries {
		newCache[e.Key] = e.Value
	}

	c.mu.Lock()
	prevCache := c.cache
	wasInitialized := c.initialized
	c.cache = newCache
	c.initialized = true
	c.mu.Unlock()

	if wasInitialized {
		c.listenersMu.RLock()
		defer c.listenersMu.RUnlock()
		for key, callbacks := range c.listeners {
			oldVal := prevCache[key]
			newVal := newCache[key]
			if oldVal != newVal {
				for _, cb := range callbacks {
					cb(newVal, oldVal)
				}
			}
		}
	}

	return nil
}

// ── read ──────────────────────────────────────────────────────────────────────

// Get returns the value for key.
// Checks the local cache first; if absent, fetches from the server once and caches it.
// Returns ("", false, nil) when the key does not exist.
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
