let instance = null;

export class Config {
  #url;
  #cache = new Map();
  #reloadTimer = null;

  constructor(url) {
    if (!url) throw new Error("url is required");
    this.#url = url.replace(/\/$/, "");
  }

  static getInstance(url) {
    if (!instance) instance = new Config(url);
    return instance;
  }

  static resetInstance() {
    instance?.close();
    instance = null;
  }

  /**
   * Connect to the server, seed the local cache, and start periodic reload.
   * Pass reloadIntervalMs = 0 to disable the background reload (useful in tests).
   */
  async init(reloadIntervalMs = 10_000) {
    await this.#syncCache();
    if (reloadIntervalMs > 0) {
      this.#reloadTimer = setInterval(() => this.#syncCache(), reloadIntervalMs);
    }
    return this;
  }

  /** Stop the periodic reload. Call when the client is no longer needed. */
  close() {
    clearInterval(this.#reloadTimer);
    this.#reloadTimer = null;
  }

  // ── private ────────────────────────────────────────────────────────────────

  async #request(path, options = {}) {
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
   * Checks the local cache first; if the key is absent, fetches it from the
   * server once and stores it so future reads stay local.
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
