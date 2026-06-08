'use strict';

let instance = null;

class Config {
  #url;
  #apiKey;
  #cache = new Map();
  #reloadTimer = null;
  #natsSub = null;
  #listeners = new Map();
  #initialized = false;

  constructor(url, apiKey = "") {
    if (!url) throw new Error("url is required");
    this.#url = url.replace(/\/$/, "");
    this.#apiKey = process.env.CONFIG_API_KEY || apiKey;
  }

  static getInstance(url, apiKey = "") {
    if (!instance) instance = new Config(url, apiKey);
    return instance;
  }

  static resetInstance() {
    instance?.close();
    instance = null;
  }

  async init({ reloadIntervalMs = 300_000 } = {}) {
    await this.#syncCache();

    let nats;
    const natsUrl = this.#cache.get('nats.config.url');
    if (natsUrl) {
      try {
        const NATS = require('nats');
        const natsOpts = { servers: natsUrl, reconnect: true, maxReconnectAttempts: -1 };
        const natsUser = this.#cache.get('nats.config.user');
        const natsPass = this.#cache.get('nats.config.password');
        if (natsUser) { natsOpts.user = natsUser; natsOpts.pass = natsPass; }
        nats = await NATS.connect(natsOpts);
        console.log('[config] NATS connected');
      } catch (err) {
        console.error(`[config] NATS connect failed, using poll-only mode: ${err.message}`);
      }
    }

    if (nats) {
      (async () => {
        for await (const s of nats.status()) {
          console.log(`[config] NATS status: ${s.type}${s.data ? ` — ${JSON.stringify(s.data)}` : ""}`);
        }
      })();
      nats.closed().then(() => console.log("[config] NATS connection closed"));

      const sub = nats.subscribe("config.updated");
      this.#natsSub = sub;
      (async () => {
        for await (const msg of sub) {
          const key = msg.string();
          console.log(`[config] NATS: config.updated received (key=${key}), reloading cache`);
          await this.#syncCache().catch((err) =>
            console.error("[config] NATS-triggered reload failed:", err)
          );
        }
      })();
    }

    if (reloadIntervalMs > 0) {
      this.#reloadTimer = setInterval(async () => {
        console.log("[config] poll: reloading cache");
        await this.#syncCache().catch((err) =>
          console.error("[config] poll: reload failed:", err)
        );
      }, reloadIntervalMs);
    }

    return this;
  }

  onChange(key, callback) {
    if (!this.#listeners.has(key)) this.#listeners.set(key, new Set());
    this.#listeners.get(key).add(callback);
  }

  async reload() {
    await this.#syncCache();
  }

  close() {
    clearInterval(this.#reloadTimer);
    this.#reloadTimer = null;
    this.#natsSub?.unsubscribe();
    this.#natsSub = null;
  }

  async #request(path, options = {}) {
    let res;
    try {
      const headers = {
        ...(this.#apiKey ? { 'X-API-Key': this.#apiKey } : {}),
        ...options.headers,
      };
      res = await fetch(`${this.#url}${path}`, { ...options, headers });
    } catch (err) {
      throw new Error(`Config server unreachable: ${err.message}`);
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new Error(`Config server returned non-JSON response (status ${res.status})`);
    }
    if (!res.ok) throw new Error(body?.error ?? `Request failed with status ${res.status}`);
    return body;
  }

  async #syncCache() {
    const prev = new Map();
    for (const key of this.#listeners.keys()) prev.set(key, this.#cache.get(key));

    const entries = await this.#request("/api/getall");
    this.#cache.clear();
    for (const { key, value } of entries) this.#cache.set(key, value);

    if (this.#initialized) {
      for (const [key, callbacks] of this.#listeners) {
        const newVal = this.#cache.get(key);
        if (prev.get(key) !== newVal) {
          for (const cb of callbacks) {
            Promise.resolve(cb(newVal, prev.get(key))).catch((err) =>
              console.error(`[config] onChange handler error for key=${key}:`, err)
            );
          }
        }
      }
    } else {
      this.#initialized = true;
    }
  }

  async get(key) {
    if (this.#cache.has(key)) return this.#cache.get(key);
    const body = await this.#request(`/api/get?key=${encodeURIComponent(key)}`).catch((err) => {
      if (err.message === "Key not found") return null;
      throw err;
    });
    if (body) this.#cache.set(key, body.value);
    return body?.value;
  }

  async getAll() {
    return this.#request("/api/getall");
  }

  async set(key, value) {
    if (typeof value !== "string") throw new Error("value must be a string");
    await this.#request("/api/put", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    this.#cache.set(key, value);
  }

  async delete(key) {
    await this.#request(`/api/delete?key=${encodeURIComponent(key)}`, { method: "DELETE" });
    this.#cache.delete(key);
  }
}

module.exports = { Config };
