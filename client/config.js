let instance = null;

export class Config {
  #url;
  #cache = new Map();

  constructor(url) {
    if (!url) throw new Error("url is required");
    this.#url = url.replace(/\/$/, "");
  }

  static getInstance(url) {
    if (!instance) instance = new Config(url);
    return instance;
  }

  static resetInstance() {
    instance = null;
  }

  async init() {
    await this.#syncCache();
    return this;
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

  async get(key, fetch = false) {
    if (fetch) {
      const body = await this.#request(`/api/get?key=${encodeURIComponent(key)}`).catch((err) => {
        if (err.message === "Key not found") return null;
        throw err;
      });
      return body ? body.value : undefined;
    }
    const val = this.#cache.get(key);
    return val !== undefined ? val : undefined;
  }

  async getAll() {
    return await this.#request("/api/getall");
  }

  async getByPrefix(prefix) {
    return await this.#request(`/api/prefix?prefix=${encodeURIComponent(prefix)}`);
  }

  // ── write ──────────────────────────────────────────────────────────────────

  async set(key, value) {
    await this.#request("/api/put", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    await this.#syncCache();
  }

  async setMany(entries) {
    await this.#request("/api/putmany", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entries),
    });
    await this.#syncCache();
  }

  async delete(key) {
    await this.#request(`/api/delete?key=${encodeURIComponent(key)}`, { method: "DELETE" });
    await this.#syncCache();
  }

  async deleteByPrefix(prefix) {
    await this.#request(`/api/deleteprefix?prefix=${encodeURIComponent(prefix)}`, { method: "DELETE" });
    await this.#syncCache();
  }

  async deleteAll() {
    await this.#request("/api/deleteall", { method: "DELETE" });
    await this.#syncCache();
  }
}
