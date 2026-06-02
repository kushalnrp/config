# config

Bun server for flat key-value config storage backed by SQLite (`bun:sqlite`).

## Run

```bash
bun start
```

Server starts on `CONFIG_PORT` (default `2001`) and uses `CONFIG_DB_PATH` (default `data/config.db`).

## API

All routes are under `/api/`.

| Method   | Path                        | Body / Query            | Description                        |
|----------|-----------------------------|-------------------------|------------------------------------|
| `GET`    | `/api/get?key=`             | `?key=foo`              | Get a single value                 |
| `GET`    | `/api/getall`               | —                       | Get all entries                    |
| `GET`    | `/api/prefix?prefix=`       | `?prefix=db.`           | Get all entries with a key prefix  |
| `PUT`    | `/api/put`                  | `{ key, value }`        | Upsert a single entry              |
| `PUT`    | `/api/putmany`              | `[{ key, value }, ...]` | Upsert multiple entries            |
| `DELETE` | `/api/delete?key=`          | `?key=foo`              | Delete a single entry              |
| `DELETE` | `/api/deleteprefix?prefix=` | `?prefix=db.`           | Delete all entries with a prefix   |
