let instance = null;

export class Config {
  #url;
  #apiKey;
  #cache = new Map();
  #reloadTimer = null;
  #natsSub = null;

  constructor(url, apiKey = "") {
    if (!url) throw new Error("url is required");
    this.#url = url.replace(/\/$/, "");
    this.#apiKey = apiKey;
  }

  static getInstance(url, apiKey = "") {
    if (!instance) instance = new Config(url, apiKey);
    return instance;
  }

  static resetInstance() {
    instance?.close();
    instance = null;
  }

  /**
   * Seed the local cache and start keeping it fresh.
   *
   * @param {object} [opts]
   * @param {number}  [opts.reloadIntervalMs=300_000] Fallback poll interval (0 = disabled).
   * @param {object}  [opts.nats] Connected nats.js connection. When provided, subscribes to
   *                              config.updated for immediate cache refresh on writes.
   */
  async init({ reloadIntervalMs = 300_000, nats } = {}) {
    await this.#syncCache();

    if (nats) {
      // Log connection lifecycle events.
      (async () => {
        for await (const s of nats.status()) {
          console.log(`[config] NATS status: ${s.type}${s.data ? ` — ${JSON.stringify(s.data)}` : ""}`);
        }
      })();
      nats.closed().then(() => console.log("[config] NATS connection closed"));

      const sub = nats.subscribe("config.updated");
      this.#natsSub = sub;
      // consume messages in the background — each triggers a full reload
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

  /** Stop the periodic reload and unsubscribe from NATS. */
  close() {
    clearInterval(this.#reloadTimer);
    this.#reloadTimer = null;
    this.#natsSub?.unsubscribe();
    this.#natsSub = null;
  }

  // ── private ────────────────────────────────────────────────────────────────

  async #request(path, options = {}) {
    if (this.#apiKey) {
      options = { ...options, headers: { ...options.headers, "X-API-Key": this.#apiKey } };
    }
    let res;
    try {
      res = await fetch(`${this.#url}${path}`, options);
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
    const entries = await this.#request("/api/getall");
    this.#cache.clear();
    for (const { key, value } of entries) this.#cache.set(key, value);
  }

  // ── read ───────────────────────────────────────────────────────────────────

  /**
   * Return the value for key.
   * Checks the local cache first; if absent, fetches from the server once and caches it.
   */
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

  // ── write ──────────────────────────────────────────────────────────────────

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
