package main

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/nats-io/nats.go"
)

// writeJSON encodes data as JSON and writes it with the given status code.
func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data) //nolint:errcheck
}

func errJSON(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// handleHealth is unauthenticated and always returns 200.
func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// apiHandler routes all /api/* requests.
type apiHandler struct {
	storage *Storage
	nc      *nats.Conn
}

// publish sends a config.updated notification. No-op if NATS is not configured.
func (h *apiHandler) publish(key string) {
	if h.nc == nil {
		return
	}
	if err := h.nc.Publish("config.updated", []byte(key)); err != nil {
		slog.Error("NATS publish error", "error", err)
	}
}

func (h *apiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	switch {
	// GET /api/get?key=
	case path == "/api/get" && r.Method == http.MethodGet:
		key := r.URL.Query().Get("key")
		if key == "" {
			errJSON(w, http.StatusBadRequest, "key is required")
			return
		}
		entry, err := h.storage.get(key)
		if err != nil {
			errJSON(w, http.StatusInternalServerError, err.Error())
			return
		}
		if entry == nil {
			errJSON(w, http.StatusNotFound, "Key not found")
			return
		}
		writeJSON(w, http.StatusOK, entry)

	// GET /api/getall
	case path == "/api/getall" && r.Method == http.MethodGet:
		entries, err := h.storage.getAll()
		if err != nil {
			errJSON(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, entries)

	// PUT /api/put { key, value }
	case path == "/api/put" && r.Method == http.MethodPut:
		var body struct {
			Key   any `json:"key"`
			Value any `json:"value"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			errJSON(w, http.StatusBadRequest, "Invalid JSON body")
			return
		}
		key, ok := body.Key.(string)
		if !ok || key == "" {
			errJSON(w, http.StatusBadRequest, "key must be a non-empty string")
			return
		}
		value, ok := body.Value.(string)
		if !ok {
			errJSON(w, http.StatusBadRequest, "value must be a string")
			return
		}
		if err := h.storage.set(key, value); err != nil {
			errJSON(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, Entry{Key: key, Value: value})
		h.publish(key)

	// DELETE /api/delete?key=
	case path == "/api/delete" && r.Method == http.MethodDelete:
		key := r.URL.Query().Get("key")
		if key == "" {
			errJSON(w, http.StatusBadRequest, "key is required")
			return
		}
		n, err := h.storage.delete(key)
		if err != nil {
			errJSON(w, http.StatusInternalServerError, err.Error())
			return
		}
		if n == 0 {
			errJSON(w, http.StatusNotFound, "Key not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"deleted": key})
		h.publish(key)

	default:
		errJSON(w, http.StatusNotFound, "Not Found")
	}
}
