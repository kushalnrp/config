/**
 * Integration tests for the Go config server binary.
 * Same scenarios as server.test.js — fresh server per test for isolation.
 *
 * Prerequisites:
 *   cd /Users/kushals/personal/dist1/config
 *   go build -o config-server .
 *
 * Run:
 *   npm test
 */

'use strict';

const { test, expect, beforeEach, afterEach } = require("vitest");
const { Config } = require("../client/config.js");
const { existsSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createServer: netCreate } = require("node:net");
const { spawn } = require("node:child_process");

const BINARY = join(__dirname, "../config-server");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = netCreate();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitReady(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Go server did not start on port ${port} within ${timeoutMs}ms`);
}

async function startGoServer() {
  if (!existsSync(BINARY)) {
    throw new Error(
      `Go binary not found at ${BINARY}. Run: cd ${join(__dirname, "..")} && go build -o config-server .`
    );
  }
  const port = await getFreePort();
  const dbPath = join(tmpdir(), `config-go-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const proc = spawn(BINARY, [], {
    env: { ...process.env, CONFIG_PORT: String(port), CONFIG_DB_PATH: dbPath },
    stdio: "ignore",
  });
  proc.on("error", err => { throw new Error(`Failed to start Go server: ${err.message}`); });
  await waitReady(port);
  return { port, proc, dbPath };
}

let app;
let client;

beforeEach(async () => {
  Config.resetInstance();
  app = await startGoServer();
  client = await new Config(`http://127.0.0.1:${app.port}`).init(0);
});

afterEach(() => {
  client.close();
  app.proc.kill("SIGTERM");
  if (existsSync(app.dbPath)) unlinkSync(app.dbPath);
  Config.resetInstance();
});

test("set and get a single key", async () => {
  await client.set("appName", "my-app");
  expect(await client.get("appName")).toBe("my-app");
});

test("getAll returns all entries ordered by key", async () => {
  await client.set("b", "2");
  await client.set("a", "1");
  expect(await client.getAll()).toEqual([
    { key: "a", value: "1" },
    { key: "b", value: "2" },
  ]);
});

test("delete removes a key", async () => {
  await client.set("toDelete", "val");
  await client.delete("toDelete");
  expect(await client.get("toDelete")).toBeUndefined();
});

test("get returns undefined for missing key", async () => {
  expect(await client.get("missing")).toBeUndefined();
});

test("get lazily fetches a key not in local cache", async () => {
  await fetch(`http://127.0.0.1:${app.port}/api/put`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "lazy", value: "loaded" }),
  });
  expect(await client.get("lazy")).toBe("loaded");
});

test("set throws on invalid value type", async () => {
  await expect(client.set("x", 123)).rejects.toThrow("value must be a string");
});

test("get returns value from cache without hitting server", async () => {
  await client.set("cached", "yes");
  expect(await client.get("cached")).toBe("yes");
});

test("getInstance returns the same instance", async () => {
  const a = Config.getInstance(`http://127.0.0.1:${app.port}`);
  const b = Config.getInstance(`http://127.0.0.1:${app.port}`);
  expect(a).toBe(b);
});

test("throws when server is unreachable", async () => {
  await expect(new Config("http://127.0.0.1:1").init(0)).rejects.toThrow();
});

test("GET /health returns 200 ok", async () => {
  const r = await fetch(`http://127.0.0.1:${app.port}/health`);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ status: "ok" });
});

test("onChange fires callback when a key is updated", async () => {
  await client.set("token", "old");

  let called = false;
  let gotNew, gotOld;
  client.onChange("token", (newVal, oldVal) => { called = true; gotNew = newVal; gotOld = oldVal; });

  await fetch(`http://127.0.0.1:${app.port}/api/put`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "token", value: "new" }),
  });
  await client.reload();

  expect(called).toBe(true);
  expect(gotNew).toBe("new");
  expect(gotOld).toBe("old");
});

test("onChange fires callback when a key is deleted", async () => {
  await client.set("token", "val");

  let gotNew, gotOld;
  client.onChange("token", (newVal, oldVal) => { gotNew = newVal; gotOld = oldVal; });

  await fetch(`http://127.0.0.1:${app.port}/api/delete?key=token`, { method: "DELETE" });
  await client.reload();

  expect(gotNew).toBeUndefined();
  expect(gotOld).toBe("val");
});

test("onChange does not fire when value is unchanged", async () => {
  await client.set("stable", "same");

  let called = false;
  client.onChange("stable", () => { called = true; });

  await client.reload();

  expect(called).toBe(false);
});

test("all onChange callbacks fire for the same key", async () => {
  await client.set("key", "before");

  const calls = [];
  client.onChange("key", (n, o) => calls.push(["a", n, o]));
  client.onChange("key", (n, o) => calls.push(["b", n, o]));

  await fetch(`http://127.0.0.1:${app.port}/api/put`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "key", value: "after" }),
  });
  await client.reload();

  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(["a", "after", "before"]);
  expect(calls[1]).toEqual(["b", "after", "before"]);
});

test("onChange does not fire for keys that did not change", async () => {
  await client.set("watched", "val");
  await client.set("other", "x");

  let called = false;
  client.onChange("watched", () => { called = true; });

  await fetch(`http://127.0.0.1:${app.port}/api/put`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "other", value: "y" }),
  });
  await client.reload();

  expect(called).toBe(false);
});
