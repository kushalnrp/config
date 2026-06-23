package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/nats-io/nats.go"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelDebug})).With("service", "config"))

	portStr := getEnv("CONFIG_PORT", "2001")
	port, err := strconv.Atoi(portStr)
	if err != nil {
		slog.Error("invalid CONFIG_PORT", "value", portStr, "error", err)
		os.Exit(1)
	}

	dbPath := getEnv("CONFIG_DB_PATH", "data/config.db")

	storage, err := newStorage(dbPath)
	if err != nil {
		slog.Error("failed to open storage", "error", err)
		os.Exit(1)
	}
	defer storage.close()

	seedPath := getEnv("CONFIG_SEED_PATH", "config.seed.json")
	if err := seedFromFile(storage, seedPath); err != nil {
		slog.Error("failed to seed", "path", seedPath, "error", err)
		os.Exit(1)
	}

	var nc *nats.Conn
	if natsURL := os.Getenv("NATS_URL"); natsURL != "" {
		opts := []nats.Option{
			nats.MaxReconnects(-1),
			nats.ReconnectWait(2 * time.Second),
		}
		if u := os.Getenv("NATS_USER"); u != "" {
			opts = append(opts, nats.UserInfo(u, os.Getenv("NATS_PASS")))
		}
		var err error
		nc, err = nats.Connect(natsURL, opts...)
		if err != nil {
			slog.Error("failed to connect to NATS", "url", natsURL, "error", err)
			os.Exit(1)
		}
		defer nc.Drain()
		slog.Info("connected to NATS", "url", natsURL)
	}

	handler := buildHandler(storage, nc)

	addr := fmt.Sprintf(":%d", port)
	slog.Info("config server listening", "port", port)
	if err := http.ListenAndServe(addr, handler); err != nil {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}
}

// statusWriter captures the HTTP status code written by a handler.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (sw *statusWriter) WriteHeader(status int) {
	sw.status = status
	sw.ResponseWriter.WriteHeader(status)
}

// loggingMiddleware logs method, path, status, and duration for every request.
func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		slog.Debug("request", "method", r.Method, "path", r.URL.Path, "query", r.URL.RawQuery)
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		slog.Debug("response", "method", r.Method, "path", r.URL.Path, "status", sw.status, "duration", time.Since(start))
	})
}

// buildHandler wires up all routes and middleware.
func buildHandler(storage *Storage, nc *nats.Conn) http.Handler {
	mux := http.NewServeMux()

	// /health is always unauthenticated.
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		handleHealth(w, r, storage, nc)
	})

	// All /api/* routes.
	mux.Handle("/api/", &apiHandler{storage: storage, nc: nc})

	// Catch-all 404.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		errJSON(w, http.StatusNotFound, "Not Found")
	})

	return loggingMiddleware(mux)
}

// seedFromFile reads a flat JSON object from path and upserts each key/value
// into storage. Keys already in the DB are overwritten with the seed value.
// If the file does not exist, seedFromFile is a no-op.
func seedFromFile(s *Storage, path string) error {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read seed file: %w", err)
	}
	var raw map[string]string
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("parse seed file: %w", err)
	}
	entries := make([]Entry, 0, len(raw))
	for k, v := range raw {
		entries = append(entries, Entry{Key: k, Value: v})
	}
	if len(entries) == 0 {
		return nil
	}
	if err := s.setMany(entries); err != nil {
		return fmt.Errorf("write seed entries: %w", err)
	}
	slog.Info("seeded entries", "count", len(entries), "path", path)
	return nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
