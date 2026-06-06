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
	apiKey := os.Getenv("API_KEY")

	storage, err := newStorage(dbPath)
	if err != nil {
		slog.Error("failed to open storage", "error", err)
		os.Exit(1)
	}
	defer storage.close()

	seedPath := os.Getenv("CONFIG_SEED_PATH")
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

	handler := buildHandler(storage, apiKey, nc)

	addr := fmt.Sprintf(":%d", port)
	slog.Info("config server listening", "port", port)
	if err := http.ListenAndServe(addr, handler); err != nil {
		slog.Error("server error", "error", err)
		os.Exit(1)
	}
}

// buildHandler wires up all routes and middleware.
func buildHandler(storage *Storage, apiKey string, nc *nats.Conn) http.Handler {
	mux := http.NewServeMux()

	// /health is always unauthenticated.
	mux.HandleFunc("/health", handleHealth)

	// All /api/* routes go through the apiHandler, optionally wrapped in auth.
	var apiH http.Handler = &apiHandler{storage: storage, nc: nc}
	if apiKey != "" {
		apiH = authMiddleware(apiKey, apiH)
	}
	mux.Handle("/api/", apiH)

	// Catch-all 404.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		errJSON(w, http.StatusNotFound, "Not Found")
	})

	return mux
}

// authMiddleware rejects requests whose X-API-Key header does not match apiKey.
func authMiddleware(apiKey string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != apiKey {
			errJSON(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
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
