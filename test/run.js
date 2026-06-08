#!/usr/bin/env node
/**
 * Integration test runner for the Go config server.
 * Builds the binary if absent, spawns a fresh server per test for isolation,
 * then reports results.
 */

'use strict';

const { spawn, spawnSync } = require("node:child_process");
const { existsSync, unlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createServer: netCreate } = require("node:net");
const { Config } = require("../client/config.js");

const PROJECT_ROOT = join(__dirname, "..");
const BINARY = join(PROJECT_ROOT, "config-server");

// ── helpers ──────────────────────────────────────────────────────────────────

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
  throw new Error(`Server did not become ready on port ${port}`);
}

async function startServer(extraEnv = {}) {
  const port = await getFreePort();
  const dbPath = join(tmpdir(), `config-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const proc = spawn(BINARY, [], {
    env: { ...process.env, CONFIG_PORT: String(port), CONFIG_DB_PATH: dbPath, ...extraEnv },
    stdio: "pipe",
  });
  await waitReady(port);
  return {
    port,
    close() {
      proc.kill("SIGTERM");
      if (existsSync(dbPath)) unlinkSync(dbPath);
    },
  };
}

// ── test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(a, b, message) {
  if (a !== b) throw new Error(message || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertArrayEqual(a, b) {
  const aStr = JSON.stringify(a);
  const bStr = JSON.stringify(b);
  if (aStr !== bStr) throw new Error(`Arrays not equal:\n  got:      ${aStr}\n  expected: ${bStr}`);
}

// ── tests ────────────────────────────────────────────────────────────────────

test("set and get a single key", async (client) => {
  await client.set("appName", "my-app");
  assertEqual(await client.get("appName"), "my-app");
});

test("getAll returns all entries ordered by key", async (client) => {
  await client.set("b", "2");
  await client.set("a", "1");
  assertArrayEqual(await client.getAll(), [
    { key: "a", value: "1" },
    { key: "b", value: "2" },
  ]);
});

test("delete removes a key", async (client) => {
  await client.set("toDelete", "val");
  await client.delete("toDelete");
  assert((await client.get("toDelete")) === undefined, "Key should be deleted");
});

test("get returns undefined for missing key", async (client) => {
  assert((await client.get("missing")) === undefined, "Should return undefined for missing key");
});

test("get lazily fetches a key not in local cache", async (client) => {
  await fetch(`http://127.0.0.1:${client._port}/api/put`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "lazy", value: "loaded" }),
  });
  assertEqual(await client.get("lazy"), "loaded");
});

test("set throws on invalid value type", async (client) => {
  try {
    await client.set("x", 123);
    throw new Error("Should have thrown");
  } catch (err) {
    assert(err.message.includes("value must be a string"), `Got: ${err.message}`);
  }
});

test("get returns value from cache without hitting server", async (client) => {
  await client.set("cached", "yes");
  assertEqual(await client.get("cached"), "yes");
});

test("throws when server is unreachable", async () => {
  try {
    await new Config("http://127.0.0.1:1").init(0);
    throw new Error("Should have thrown");
  } catch (err) {
    assert(err.message.includes("unreachable"), `Got: ${err.message}`);
  }
});

test("seed: keys from config.json are present at startup", async (client) => {
  assertArrayEqual(await client.getAll(), [
    { key: "seed.key", value: "hello" },
    { key: "seed.other", value: "world" },
  ]);
});

test("seed: seed keys can be overwritten", async (client) => {
  await client.set("seed.key", "updated");
  assertEqual(await client.get("seed.key"), "updated");
});

test("onChange fires callback when a key is updated", async (client) => {
  await client.set("token", "old");
  let called = false;
  let gotNew, gotOld;
  client.onChange("token", (newVal, oldVal) => { called = true; gotNew = newVal; gotOld = oldVal; });
  await fetch(`http://127.0.0.1:${client._port}/api/put`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "token", value: "new" }),
  });
  await client.reload();
  assert(called, "onChange was not called");
  assertEqual(gotNew, "new");
  assertEqual(gotOld, "old");
});

test("onChange fires callback when a key is deleted", async (client) => {
  await client.set("token", "val");
  let gotNew, gotOld;
  client.onChange("token", (newVal, oldVal) => { gotNew = newVal; gotOld = oldVal; });
  await fetch(`http://127.0.0.1:${client._port}/api/delete?key=token`, { method: "DELETE" });
  await client.reload();
  assert(gotNew === undefined, `newVal should be undefined, got ${JSON.stringify(gotNew)}`);
  assertEqual(gotOld, "val");
});

test("onChange does not fire when value is unchanged", async (client) => {
  await client.set("stable", "same");
  let called = false;
  client.onChange("stable", () => { called = true; });
  await client.reload();
  assert(!called, "onChange should not fire when value is unchanged");
});

test("all onChange callbacks fire for the same key", async (client) => {
  await client.set("key", "before");
  const calls = [];
  client.onChange("key", (n, o) => calls.push(["a", n, o]));
  client.onChange("key", (n, o) => calls.push(["b", n, o]));
  await fetch(`http://127.0.0.1:${client._port}/api/put`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "key", value: "after" }),
  });
  await client.reload();
  assertEqual(calls.length, 2, `Expected 2 callbacks, got ${calls.length}`);
  assertArrayEqual(calls[0], ["a", "after", "before"]);
  assertArrayEqual(calls[1], ["b", "after", "before"]);
});

test("onChange does not fire for keys that did not change", async (client) => {
  await client.set("watched", "val");
  await client.set("other", "x");
  let called = false;
  client.onChange("watched", () => { called = true; });
  await fetch(`http://127.0.0.1:${client._port}/api/put`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "other", value: "y" }),
  });
  await client.reload();
  assert(!called, "onChange for 'watched' should not fire when only 'other' changed");
});

test("onChange works without NATS (poll-only fallback)", async (client) => {
  // The default client has no NATS configured — verify onChange still fires via
  // explicit reload, simulating what happens when NATS is unavailable.
  await client.set("key", "v1");
  let fired = false;
  client.onChange("key", () => { fired = true; });
  await fetch(`http://127.0.0.1:${client._port}/api/put`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "key", value: "v2" }),
  });
  await client.reload();
  assert(fired, "onChange did not fire without NATS");
});

test("periodic sync triggers onChange via reload interval", async (_client, server) => {
  // Create a client with a 200ms reload interval to test the timer path.
  Config.resetInstance();
  const client = await new Config(`http://127.0.0.1:${server.port}`).init({ reloadIntervalMs: 200 });
  try {
    await client.set("periodic", "v1");
    let gotNew, gotOld;
    const fired = new Promise((resolve) => {
      client.onChange("periodic", (newVal, oldVal) => { gotNew = newVal; gotOld = oldVal; resolve(); });
    });
    // Change the value on the server, bypassing the client cache.
    await fetch(`http://127.0.0.1:${server.port}/api/put`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "periodic", value: "v2" }),
    });
    // Wait for the periodic sync to pick up the change (timeout 2s).
    await Promise.race([fired, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000))]);
    assertEqual(gotNew, "v2");
    assertEqual(gotOld, "v1");
  } finally {
    client.close();
    Config.resetInstance();
  }
});

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(BINARY)) {
    console.log("Building Go binary...");
    const result = spawnSync("go", ["build", "-o", "config-server", "."], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      console.error("Build failed.");
      process.exit(1);
    }
  } else {
    console.log(`Using existing binary: ${BINARY}`);
  }

  const seedFilePath = join(tmpdir(), `config-seed-${Date.now()}.json`);
  writeFileSync(seedFilePath, JSON.stringify({ "seed.key": "hello", "seed.other": "world" }));

  console.log("\nRunning integration tests...\n");

  for (const t of tests) {
    const isSeedTest = t.name.startsWith("seed:");
    const isUnreachableTest = t.name.includes("unreachable");

    let server;
    let client;

    try {
      if (!isUnreachableTest) {
        server = await startServer(isSeedTest ? { CONFIG_SEED_PATH: seedFilePath } : {});
        Config.resetInstance();
        client = await new Config(`http://127.0.0.1:${server.port}`).init(0);
        client._port = server.port;
      }

      await t.fn(client, server);
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`    ${err.message}`);
      failed++;
    } finally {
      client?.close();
      Config.resetInstance();
      server?.close();
    }
  }

  if (existsSync(seedFilePath)) unlinkSync(seedFilePath);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
