# config

Node.js server for storing and retrieving configs and secrets in SQLite.

## Run

```bash
npm install
npm start
```

Server starts on `PORT` (default `3000`) and uses `CONFIG_DB_PATH` (default `config.db`).

## API

- `PUT /configs/:key` with JSON body `{ "value": "string" }`
- `GET /configs/:key`
- `PUT /secrets/:key` with JSON body `{ "value": "string" }`
- `GET /secrets/:key`
