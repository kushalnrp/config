#!/usr/bin/env node
/**
 * Integration test runner for the Go config server.
 * Builds the binary if absent, spawns a fresh server per test for isolation,
 * then reports results.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createServer as netCreate } from "node:net";
import { Config } from "../client/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(__dirname);
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
  // Write a key directly to the server, bypassing the client's cache
  await fetch(`http://127.0.0.1:${client._port}/api/put`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: "lazy", value: "loaded" }),
  });

  // Client hasn't cached this key — get() should lazy-fetch it from the server
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

  // Seed file used by the last two tests
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
        client._port = server.port; // expose port for the lazy-fetch test
      }

      await t.fn(client);
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
