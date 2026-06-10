# config

A lightweight key-value config server written in Go, backed by SQLite. Comes with a JS client (`client/config.js`) and a Go client (`client/config.go`).

## Server

### Prerequisites

- Go 1.22+

### Run

```bash
go build -o config-server .
./config-server
```

### Environment variables

| Variable          | Default          | Description                                      |
|-------------------|------------------|--------------------------------------------------|
| `CONFIG_PORT`     | `2001`           | Port the server listens on                       |
| `CONFIG_DB_PATH`  | `data/config.db` | Path to the SQLite database file                 |
| `API_KEY`         | *(unset)*        | When set, all `/api/*` requests require `X-API-Key: <value>` |
| `CONFIG_SEED_PATH`| *(unset)*        | Path to a JSON seed file loaded at startup       |

### Seeding

Create a flat JSON file and point `CONFIG_SEED_PATH` at it. All key/value pairs are upserted into the DB on every startup. See `config.example.json` for the full set of keys this platform's services expect (copy it to `config.json` and fill in the placeholder NATS passwords from `nats.conf`):

```bash
cp config.example.json config.json
CONFIG_SEED_PATH=config.json ./config-server
```

### Docker

```bash
docker build -t config-server .
docker run -p 2001:2001 -e CONFIG_SEED_PATH=config.json config-server
```

### API

All routes are under `/api/`. Authenticated routes require `X-API-Key` when `API_KEY` is set.

| Method   | Path              | Body / Query     | Description            |
|----------|-------------------|------------------|------------------------|
| `GET`    | `/health`         | —                | Health check (no auth) |
| `GET`    | `/api/get?key=`   | `?key=foo`       | Get a single value     |
| `GET`    | `/api/getall`     | —                | Get all entries        |
| `PUT`    | `/api/put`        | `{ key, value }` | Upsert a single entry  |
| `DELETE` | `/api/delete?key=`| `?key=foo`       | Delete a single entry  |

---

## JS client

```js
import { Config } from './client/config.js';

const client = await new Config('http://localhost:2001').init();
// init() seeds the local cache and starts a 10s background reload.
// Pass a custom interval: .init(30_000), or 0 to disable.

const value = await client.get('app.name');   // cache-first, lazy server fetch on miss
await client.set('feature.flag', 'true');
await client.delete('feature.flag');
const all = await client.getAll();            // always hits server

client.close(); // stop background reload
```

### Singleton

```js
const a = Config.getInstance('http://localhost:2001');
// returns the same instance on subsequent calls
```

---

## Go client

```go
import "github.com/kushalnrp/config/client"

c, err := config.Init("http://localhost:2001", 10*time.Second)
// Init seeds the local cache and starts a background reload goroutine.
// Pass 0 as the interval to disable background reload.

val, ok, err := c.Get("app.name")   // cache-first, lazy server fetch on miss
err = c.Set("feature.flag", "true")
err = c.Delete("feature.flag")
entries, err := c.GetAll()          // always hits server

c.Close() // stop background reload
```

### Singleton

```go
c, err := config.Init("http://localhost:2001", 10*time.Second)
// ...
c = config.GetInstance() // returns the same instance anywhere
```

---

## Testing

Requires Node.js 18+ and Go 1.22+.

```bash
# Build binary and run integration tests
npm run setup

# Or separately:
npm run build   # go build -o config-server .
npm test        # node test/run.js
```
