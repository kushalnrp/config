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

import { test, expect, beforeEach, afterEach } from "vitest";
import { Config } from "../client/config.js";
import { existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createServer as netCreate } from "node:net";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
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
