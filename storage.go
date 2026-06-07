package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// Entry is a key/value pair stored in SQLite.
type Entry struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// Storage wraps the SQLite database.
type Storage struct {
	db *sql.DB
}

func newStorage(dbPath string) (*Storage, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("create db dir: %w", err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	// Single connection serializes all access and avoids SQLITE_BUSY under
	// concurrent reads + writes from the same process.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`
		PRAGMA journal_mode=WAL;
		PRAGMA busy_timeout=5000;
		CREATE TABLE IF NOT EXISTS entries (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`); err != nil {
		db.Close()
		return nil, fmt.Errorf("init db: %w", err)
	}
	return &Storage{db: db}, nil
}

func (s *Storage) close() error { return s.db.Close() }

func (s *Storage) ping() error { return s.db.Ping() }

func (s *Storage) get(key string) (*Entry, error) {
	var value string
	err := s.db.QueryRow("SELECT value FROM entries WHERE key = ?", key).Scan(&value)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &Entry{Key: key, Value: value}, nil
}

// getAll returns all entries ordered by key.
// Returns an empty slice (not nil) so the JSON response is always [].
func (s *Storage) getAll() ([]Entry, error) {
	rows, err := s.db.Query("SELECT key, value FROM entries ORDER BY key")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []Entry{}
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.Key, &e.Value); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

func (s *Storage) set(key, value string) error {
	_, err := s.db.Exec(
		"INSERT INTO entries (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		key, value,
	)
	return err
}

// setMany upserts a batch of entries in a single transaction.
// Used internally by seedFromFile; not exposed via HTTP.
func (s *Storage) setMany(entries []Entry) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck

	stmt, err := tx.Prepare(
		"INSERT INTO entries (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, e := range entries {
		if _, err := stmt.Exec(e.Key, e.Value); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Storage) delete(key string) (int64, error) {
	res, err := s.db.Exec("DELETE FROM entries WHERE key = ?", key)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
