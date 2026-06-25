package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

func startTestNATSServer(t *testing.T) *server.Server {
	t.Helper()

	ns, err := server.NewServer(&server.Options{
		Host:   "127.0.0.1",
		Port:   -1,
		NoSigs: true,
	})
	if err != nil {
		t.Fatalf("create nats server: %v", err)
	}

	go ns.Start()
	if !ns.ReadyForConnections(5 * time.Second) {
		t.Fatal("nats server did not become ready")
	}

	t.Cleanup(ns.Shutdown)
	return ns
}

func TestPublishesConfigUpdatedOnPutAndDelete(t *testing.T) {
	ns := startTestNATSServer(t)

	nc, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatalf("connect publisher nats client: %v", err)
	}
	t.Cleanup(func() { _ = nc.Drain() })

	subNC, err := nats.Connect(ns.ClientURL())
	if err != nil {
		t.Fatalf("connect subscriber nats client: %v", err)
	}
	t.Cleanup(func() { _ = subNC.Drain() })

	sub, err := subNC.SubscribeSync("config.updated")
	if err != nil {
		t.Fatalf("subscribe to config.updated: %v", err)
	}
	if err := subNC.Flush(); err != nil {
		t.Fatalf("flush subscriber connection: %v", err)
	}

	dbPath := filepath.Join(t.TempDir(), "config-test.db")
	storage, err := newStorage(dbPath)
	if err != nil {
		t.Fatalf("create storage: %v", err)
	}
	t.Cleanup(func() { _ = storage.close() })

	ts := httptest.NewServer(buildHandler(storage, nc))
	t.Cleanup(ts.Close)

	body, _ := json.Marshal(map[string]string{"key": "nats.key", "value": "v1"})
	req, err := http.NewRequest(http.MethodPut, ts.URL+"/api/put", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("build put request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("put request failed: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected PUT status %d, got %d", http.StatusOK, resp.StatusCode)
	}

	putMsg, err := sub.NextMsg(2 * time.Second)
	if err != nil {
		t.Fatalf("did not receive PUT update event: %v", err)
	}
	if string(putMsg.Data) != "nats.key" {
		t.Fatalf("expected PUT message data nats.key, got %q", string(putMsg.Data))
	}

	req, err = http.NewRequest(http.MethodDelete, ts.URL+"/api/delete?key=nats.key", nil)
	if err != nil {
		t.Fatalf("build delete request: %v", err)
	}
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("delete request failed: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected DELETE status %d, got %d", http.StatusOK, resp.StatusCode)
	}

	deleteMsg, err := sub.NextMsg(2 * time.Second)
	if err != nil {
		t.Fatalf("did not receive DELETE update event: %v", err)
	}
	if string(deleteMsg.Data) != "nats.key" {
		t.Fatalf("expected DELETE message data nats.key, got %q", string(deleteMsg.Data))
	}
}
