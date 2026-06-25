# config — Config Server

Lightweight key-value configuration server written in Go, backed by SQLite. Provides runtime config to all platform services. Ships with a JS client and a Go client.

## Tech stack

- **Go 1.22+** — HTTP server
- **SQLite** — storage (`data/config.db`)

## Port

- `2001`

## API

```
GET  /api/get?key=foo          → { value: "..." }
POST /api/set                  → { key, value }
GET  /api/all                  → { key: value, ... }
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONFIG_PORT` | `2001` | Listen port |
| `CONFIG_DB_PATH` | `data/config.db` | SQLite path |
| `CONFIG_SEED_PATH` | `config.seed.json` | JSON file upserted into DB at startup |

## Seeding

`CONFIG_SEED_PATH` points at a flat JSON file used to pre-populate keys on startup, defaulting to `config.seed.json`. This is the primary way to inject secrets without committing them.

## Clients

- `client/config.js` — JS client used by `server` and `marketfeed`
- `client/config.go` — Go client used by `exec`

## Running

```bash
go build -o config-server .
./config-server
```
