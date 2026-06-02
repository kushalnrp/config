import { test, expect, beforeEach, afterEach } from "bun:test";
import { createServer } from "../server.js";
import { Config } from "../client/config.js";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let app;
let client;

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

beforeEach(async () => {
  Config.resetInstance();
  app = startServer();
  client = await new Config(`http://127.0.0.1:${app.port}`).init();
});

afterEach(() => {
  app.close();
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

test("getByPrefix returns matching entries", async () => {
  await client.setMany([
    { key: "db.host", value: "localhost" },
    { key: "db.port", value: "5432" },
    { key: "app.name", value: "myapp" },
  ]);
  expect(await client.getByPrefix("db.")).toEqual([
    { key: "db.host", value: "localhost" },
    { key: "db.port", value: "5432" },
  ]);
});

test("setMany inserts multiple entries", async () => {
  await client.setMany([
    { key: "x", value: "1" },
    { key: "y", value: "2" },
  ]);
  expect(await client.get("x")).toBe("1");
  expect(await client.get("y")).toBe("2");
});

test("delete removes a key", async () => {
  await client.set("toDelete", "val");
  await client.delete("toDelete");
  expect(await client.get("toDelete")).toBeUndefined();
});

test("deleteByPrefix removes matching keys", async () => {
  await client.setMany([
    { key: "cache.ttl", value: "60" },
    { key: "cache.max", value: "100" },
    { key: "other", value: "val" },
  ]);
  await client.deleteByPrefix("cache.");
  expect(await client.getAll()).toEqual([{ key: "other", value: "val" }]);
});

test("get returns undefined for missing key", async () => {
  expect(await client.get("missing")).toBeUndefined();
});

test("get with fetch=true returns undefined for missing key", async () => {
  expect(await client.get("missing", true)).toBeUndefined();
});

test("deleteAll removes all keys", async () => {
  await client.setMany([
    { key: "a", value: "1" },
    { key: "b", value: "2" },
    { key: "c", value: "3" },
  ]);
  await client.deleteAll();
  expect(await client.getAll()).toEqual([]);
});

test("deleteAll on empty db does not throw", async () => {
  await expect(client.deleteAll()).resolves.toBeUndefined();
});

test("set throws on invalid value type", async () => {
  await expect(client.set("x", 123)).rejects.toThrow("value must be a string");
});

test("get returns value from cache without hitting server", async () => {
  await client.set("cached", "yes");
  expect(await client.get("cached")).toBe("yes");
});

test("get with fetch=true returns value from server", async () => {
  await client.set("live", "data");
  expect(await client.get("live", true)).toBe("data");
});

test("getInstance returns the same instance", async () => {
  const a = Config.getInstance(`http://127.0.0.1:${app.port}`);
  const b = Config.getInstance(`http://127.0.0.1:${app.port}`);
  expect(a).toBe(b);
});

test("throws when server is unreachable", async () => {
  await expect(new Config("http://127.0.0.1:1").init()).rejects.toThrow();
});
