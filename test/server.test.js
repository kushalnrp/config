import { test, expect } from "bun:test";
import { createServer } from "../server.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function startServer() {
  const dbPath = join(tmpdir(), `config-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const server = createServer({ dbPath });
  return {
    port: server.port,
    close() {
      server.closeStorage();
      server.stop(true);
      if (existsSync(dbPath)) unlinkSync(dbPath);
    },
  };
}

test("PUT and GET a single key", async () => {
  const app = startServer();
  try {
    let res = await fetch(`http://127.0.0.1:${app.port}/api/put`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "appName", value: "my-app" }),
    });
    expect(res.status).toBe(200);

    res = await fetch(`http://127.0.0.1:${app.port}/api/get?key=appName`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "appName", value: "my-app" });
  } finally {
    app.close();
  }
});

test("getall returns all entries ordered by key", async () => {
  const app = startServer();
  try {
    for (const [key, value] of [["b", "2"], ["a", "1"]]) {
      await fetch(`http://127.0.0.1:${app.port}/api/put`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
    }
    const res = await fetch(`http://127.0.0.1:${app.port}/api/getall`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ]);
  } finally {
    app.close();
  }
});

test("prefix returns matching entries", async () => {
  const app = startServer();
  try {
    await fetch(`http://127.0.0.1:${app.port}/api/putmany`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { key: "db.host", value: "localhost" },
        { key: "db.port", value: "5432" },
        { key: "app.name", value: "myapp" },
      ]),
    });
    const res = await fetch(`http://127.0.0.1:${app.port}/api/prefix?prefix=db.`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { key: "db.host", value: "localhost" },
      { key: "db.port", value: "5432" },
    ]);
  } finally {
    app.close();
  }
});

test("putmany inserts multiple entries", async () => {
  const app = startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/putmany`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { key: "x", value: "1" },
        { key: "y", value: "2" },
      ]),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 2 });
  } finally {
    app.close();
  }
});

test("delete removes a key", async () => {
  const app = startServer();
  try {
    await fetch(`http://127.0.0.1:${app.port}/api/put`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "toDelete", value: "val" }),
    });

    let res = await fetch(`http://127.0.0.1:${app.port}/api/delete?key=toDelete`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: "toDelete" });

    res = await fetch(`http://127.0.0.1:${app.port}/api/get?key=toDelete`);
    expect(res.status).toBe(404);
  } finally {
    app.close();
  }
});

test("deleteprefix removes matching keys", async () => {
  const app = startServer();
  try {
    await fetch(`http://127.0.0.1:${app.port}/api/putmany`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { key: "cache.ttl", value: "60" },
        { key: "cache.max", value: "100" },
        { key: "other", value: "val" },
      ]),
    });

    let res = await fetch(`http://127.0.0.1:${app.port}/api/deleteprefix?prefix=cache.`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2 });

    res = await fetch(`http://127.0.0.1:${app.port}/api/getall`);
    expect(await res.json()).toEqual([{ key: "other", value: "val" }]);
  } finally {
    app.close();
  }
});

test("returns 404 for missing key", async () => {
  const app = startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/get?key=missing`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Key not found" });
  } finally {
    app.close();
  }
});

test("deleteall removes all keys", async () => {
  const app = startServer();
  try {
    await fetch(`http://127.0.0.1:${app.port}/api/putmany`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { key: "a", value: "1" },
        { key: "b", value: "2" },
        { key: "c", value: "3" },
      ]),
    });

    let res = await fetch(`http://127.0.0.1:${app.port}/api/deleteall`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 3 });

    res = await fetch(`http://127.0.0.1:${app.port}/api/getall`);
    expect(await res.json()).toEqual([]);
  } finally {
    app.close();
  }
});

test("deleteall on empty db returns 0", async () => {
  const app = startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/deleteall`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 0 });
  } finally {
    app.close();
  }
});

test("validates put payload", async () => {
  const app = startServer();
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/put`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "x", value: 123 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "value must be a string" });
  } finally {
    app.close();
  }
});
