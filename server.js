import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

function createStorage(dbPath = "data/config.db") {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.run(`CREATE TABLE IF NOT EXISTS entries (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  const stmtGet          = db.prepare("SELECT value FROM entries WHERE key = ?");
  const stmtGetAll       = db.prepare("SELECT key, value FROM entries ORDER BY key");
  const stmtGetPrefix    = db.prepare("SELECT key, value FROM entries WHERE key LIKE ? ORDER BY key");
  const stmtSet          = db.prepare("INSERT INTO entries (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const stmtDelete       = db.prepare("DELETE FROM entries WHERE key = ?");
  const stmtDeletePrefix = db.prepare("DELETE FROM entries WHERE key LIKE ?");
  const stmtDeleteAll    = db.prepare("DELETE FROM entries");

  const setMany = db.transaction((entries) => {
    for (const { key, value } of entries) stmtSet.run(key, value);
  });

  return {
    get:           (key)            => stmtGet.get(key),
    getAll:        ()               => stmtGetAll.all(),
    getByPrefix:   (prefix)         => stmtGetPrefix.all(`${prefix}%`),
    set:           (key, value)     => stmtSet.run(key, value),
    setMany,
    delete:        (key)            => stmtDelete.run(key).changes,
    deleteByPrefix:(prefix)         => stmtDeletePrefix.run(`${prefix}%`).changes,
    deleteAll:     ()               => stmtDeleteAll.run().changes,
    close:         ()               => db.close(),
  };
}

function json(data, status = 200) {
  return Response.json(data, { status });
}

export function createServer({ dbPath = "data/config.db", port = 0 } = {}) {
  const storage = createStorage(dbPath);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const { pathname, searchParams } = new URL(req.url);

      try {
        // GET /api/get?key=
        if (pathname === "/api/get" && req.method === "GET") {
          const key = searchParams.get("key");
          if (!key) return json({ error: "key is required" }, 400);
          const row = storage.get(key);
          if (!row) return json({ error: "Key not found" }, 404);
          return json({ key, value: row.value });
        }

        // GET /api/getall
        if (pathname === "/api/getall" && req.method === "GET") {
          return json(storage.getAll());
        }

        // GET /api/prefix?prefix=
        if (pathname === "/api/prefix" && req.method === "GET") {
          const prefix = searchParams.get("prefix");
          if (prefix === null) return json({ error: "prefix is required" }, 400);
          return json(storage.getByPrefix(prefix));
        }

        // PUT /api/put  { key, value }
        if (pathname === "/api/put" && req.method === "PUT") {
          let body;
          try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
          const { key, value } = body ?? {};
          if (typeof key !== "string" || !key) return json({ error: "key must be a non-empty string" }, 400);
          if (typeof value !== "string") return json({ error: "value must be a string" }, 400);
          storage.set(key, value);
          return json({ key, value });
        }

        // PUT /api/putmany  [{ key, value }, ...]
        if (pathname === "/api/putmany" && req.method === "PUT") {
          let body;
          try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
          if (!Array.isArray(body)) return json({ error: "body must be an array" }, 400);
          for (const item of body) {
            if (typeof item.key !== "string" || !item.key) return json({ error: "each entry must have a non-empty string key" }, 400);
            if (typeof item.value !== "string") return json({ error: "each entry must have a string value" }, 400);
          }
          storage.setMany(body);
          return json({ count: body.length });
        }

        // DELETE /api/delete?key=
        if (pathname === "/api/delete" && req.method === "DELETE") {
          const key = searchParams.get("key");
          if (!key) return json({ error: "key is required" }, 400);
          const changes = storage.delete(key);
          if (!changes) return json({ error: "Key not found" }, 404);
          return json({ deleted: key });
        }

        // DELETE /api/deleteprefix?prefix=
        if (pathname === "/api/deleteprefix" && req.method === "DELETE") {
          const prefix = searchParams.get("prefix");
          if (prefix === null) return json({ error: "prefix is required" }, 400);
          const count = storage.deleteByPrefix(prefix);
          return json({ deleted: count });
        }

        // DELETE /api/deleteall
        if (pathname === "/api/deleteall" && req.method === "DELETE") {
          const count = storage.deleteAll();
          return json({ deleted: count });
        }

        return json({ error: "Not Found" }, 404);
      } catch (err) {
        return json({ error: err.message || "Internal Server Error" }, 500);
      }
    },
  });

  server.closeStorage = () => storage.close();
  return server;
}

if (import.meta.main) {
  const port = Number(process.env.CONFIG_PORT || 2001);
  const dbPath = process.env.CONFIG_DB_PATH || "data/config.db";
  const server = createServer({ dbPath, port });
  console.log(`Config server listening on port ${server.port}`);
}
