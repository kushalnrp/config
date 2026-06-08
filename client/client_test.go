package config_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	config "github.com/kushalnrp/config/client"
)

// fakeServer is a minimal in-memory key-value store that implements the config
// server HTTP API for testing purposes.
type fakeServer struct {
	mu   sync.Mutex
	data map[string]string
}

func (f *fakeServer) set(key, value string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.data[key] = value
}

func (f *fakeServer) del(key string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.data, key)
}

func (f *fakeServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/api/getall":
		type kv struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		}
		out := make([]kv, 0, len(f.data))
		for k, v := range f.data {
			out = append(out, kv{Key: k, Value: v})
		}
		json.NewEncoder(w).Encode(out) //nolint:errcheck
	case "/api/put":
		var body struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		}
		json.NewDecoder(r.Body).Decode(&body) //nolint:errcheck
		f.data[body.Key] = body.Value
		w.Write([]byte(`{}`)) //nolint:errcheck
	case "/api/delete":
		delete(f.data, r.URL.Query().Get("key"))
		w.Write([]byte(`{}`)) //nolint:errcheck
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func newTestSetup(t *testing.T) (*fakeServer, *config.Client) {
	t.Helper()
	fake := &fakeServer{data: make(map[string]string)}
	ts := httptest.NewServer(fake)
	config.ResetInstance()
	c, err := config.Init(ts.URL, config.WithReloadInterval(0))
	if err != nil {
		ts.Close()
		t.Fatalf("init client: %v", err)
	}
	t.Cleanup(func() {
		config.ResetInstance()
		ts.Close()
	})
	return fake, c
}

func TestOnChangeFires_WhenKeyUpdated(t *testing.T) {
	fake, c := newTestSetup(t)
	fake.set("token", "old")
	if err := c.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}

	var gotNew, gotOld string
	var called bool
	c.OnChange("token", func(newVal, oldVal string) {
		called = true
		gotNew = newVal
		gotOld = oldVal
	})

	fake.set("token", "new")
	if err := c.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}

	if !called {
		t.Fatal("expected onChange to be called")
	}
	if gotNew != "new" {
		t.Errorf("newVal: got %q, want %q", gotNew, "new")
	}
	if gotOld != "old" {
		t.Errorf("oldVal: got %q, want %q", gotOld, "old")
	}
}

func TestOnChangeFires_WhenKeyDeleted(t *testing.T) {
	fake, c := newTestSetup(t)
	fake.set("token", "val")
	if err := c.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}

	var gotNew, gotOld string
	var called bool
	c.OnChange("token", func(newVal, oldVal string) {
		called = true
		gotNew = newVal
		gotOld = oldVal
	})

	fake.del("token")
	if err := c.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}

	if !called {
		t.Fatal("expected onChange to be called on deletion")
	}
	if gotNew != "" {
		t.Errorf("newVal: got %q, want empty string", gotNew)
	}
	if gotOld != "val" {
		t.Errorf("oldVal: got %q, want %q", gotOld, "val")
	}
}

func TestOnChangeDoesNotFire_WhenValueUnchanged(t *testing.T) {
	fake, c := newTestSetup(t)
	fake.set("stable", "same")
	if err := c.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}

	var called bool
	c.OnChange("stable", func(_, _ string) { called = true })

	if err := c.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}

	if called {
		t.Fatal("onChange should not fire when value is unchanged")
	}
}

func TestOnChangeAllCallbacksFire_ForSameKey(t *testing.T) {
	fake, c := newTestSetup(t)
	fake.set("key", "before")
	if err := c.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}

	var calls [][]string
	c.OnChange("key", func(n, o string) { calls = append(calls, []string{"a", n, o}) })
	c.OnChange("key", func(n, o string) { calls = append(calls, []string{"b", n, o}) })

	fake.set("key", "after")
	if err := c.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}

	if len(calls) != 2 {
		t.Fatalf("expected 2 callbacks, got %d", len(calls))
	}
	for _, call := range calls {
		if call[1] != "after" || call[2] != "before" {
			t.Errorf("callback %s: got (%q, %q)", call[0], call[1], call[2])
		}
	}
}

func TestOnChangeDoesNotFire_ForUnwatchedKeys(t *testing.T) {
	fake, c := newTestSetup(t)
	fake.set("watched", "val")
	fake.set("other", "x")
	if err := c.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}

	var called bool
	c.OnChange("watched", func(_, _ string) { called = true })

	fake.set("other", "y")
	if err := c.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}

	if called {
		t.Fatal("onChange for 'watched' should not fire when only 'other' changed")
	}
}

// TestOnChange_WorksWithoutNATS verifies that onChange fires via the polling
// path when NATS is unavailable (the common fallback scenario in production).
func TestOnChange_WorksWithoutNATS(t *testing.T) {
	fake, c := newTestSetup(t) // no NATS configured; polling disabled; explicit Reload used
	fake.set("key", "v1")
	if err := c.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}

	fired := make(chan struct{}, 1)
	c.OnChange("key", func(_, _ string) {
		select {
		case fired <- struct{}{}:
		default:
		}
	})

	fake.set("key", "v2")
	if err := c.Reload(); err != nil {
		t.Fatalf("reload: %v", err)
	}

	select {
	case <-fired:
	default:
		t.Fatal("onChange did not fire without NATS")
	}
}

func TestPeriodicSync_TriggersOnChange(t *testing.T) {
	fake := &fakeServer{data: make(map[string]string)}
	ts := httptest.NewServer(fake)
	defer ts.Close()

	config.ResetInstance()
	// Use a 200ms reload interval to test the timer-driven path.
	c, err := config.Init(ts.URL, config.WithReloadInterval(200*time.Millisecond))
	if err != nil {
		t.Fatalf("init client: %v", err)
	}
	defer func() { config.ResetInstance(); ts.Close() }()

	// Seed initial value via client so the cache is warm.
	if err := c.Set("periodic", "v1"); err != nil {
		t.Fatalf("set: %v", err)
	}

	fired := make(chan struct{}, 1)
	var gotNew, gotOld string
	c.OnChange("periodic", func(newVal, oldVal string) {
		gotNew = newVal
		gotOld = oldVal
		select {
		case fired <- struct{}{}:
		default:
		}
	})

	// Change the value on the server, bypassing the client cache.
	fake.set("periodic", "v2")

	// Wait for the periodic sync to fire the callback (timeout 2s).
	select {
	case <-fired:
	case <-time.After(2 * time.Second):
		t.Fatal("onChange was not triggered by the periodic sync within 2s")
	}

	if gotNew != "v2" {
		t.Errorf("newVal: got %q, want %q", gotNew, "v2")
	}
	if gotOld != "v1" {
		t.Errorf("oldVal: got %q, want %q", gotOld, "v1")
	}
}
