package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
)

func main() {
	portStr := getEnv("CONFIG_PORT", "2001")
	port, err := strconv.Atoi(portStr)
	if err != nil {
		log.Fatalf("invalid CONFIG_PORT %q: %v", portStr, err)
	}

	dbPath := getEnv("CONFIG_DB_PATH", "data/config.db")
	apiKey := os.Getenv("API_KEY")

	storage, err := newStorage(dbPath)
	if err != nil {
		log.Fatalf("failed to open storage: %v", err)
	}
	defer storage.close()

	seedPath := os.Getenv("CONFIG_SEED_PATH")
	if err := seedFromFile(storage, seedPath); err != nil {
		log.Fatalf("failed to seed from %s: %v", seedPath, err)
	}

	handler := buildHandler(storage, apiKey)

	addr := fmt.Sprintf(":%d", port)
	log.Printf("Config server listening on port %d", port)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

// buildHandler wires up all routes and middleware.
func buildHandler(storage *Storage, apiKey string) http.Handler {
	mux := http.NewServeMux()

	// /health is always unauthenticated.
	mux.HandleFunc("/health", handleHealth)

	// All /api/* routes go through the apiHandler, optionally wrapped in auth.
	var apiH http.Handler = &apiHandler{storage: storage}
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
	log.Printf("Seeded %d entries from %s", len(entries), path)
	return nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
