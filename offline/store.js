// SCIRE offline: where the device keeps things. IndexedDB when the browser allows it, plain memory when it does
// not (a private window, blocked site data): the page then still works for this visit, it just cannot keep the pack afterwards.
// One small API either way: named stores of key -> value.

const STORES = ["meta", "parts", "outbox"];

export class MemoryStore {
  constructor() { this.persistent = false; this.data = Object.fromEntries(STORES.map((s) => [s, new Map()])); }
  async get(store, key) { const v = this.data[store].get(key); return v === undefined ? null : structuredClone(v); }
  async set(store, key, value) { this.data[store].set(key, structuredClone(value)); }
  async del(store, key) { this.data[store].delete(key); }
  async keys(store) { return [...this.data[store].keys()].sort(); }
  async all(store) { return [...this.data[store].entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => structuredClone(v)); }
  async clear(store) { this.data[store].clear(); }
  async destroy() { for (const s of STORES) this.data[s].clear(); }
  close() {}
}

export class IdbStore {
  constructor(db, name) { this.db = db; this.name = name; this.persistent = true; }

  static open(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
      req.onsuccess = () => resolve(new IdbStore(req.result, name));
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("database blocked"));
    });
  }

  _run(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const out = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("aborted"));
    });
  }
  async get(store, key) { const v = await this._run(store, "readonly", (s) => s.get(key)); return v === undefined ? null : v; }
  async set(store, key, value) { await this._run(store, "readwrite", (s) => s.put(value, key)); }
  async del(store, key) { await this._run(store, "readwrite", (s) => s.delete(key)); }
  async keys(store) { return (await this._run(store, "readonly", (s) => s.getAllKeys())).map(String).sort(); }
  async all(store) {
    const keys = await this._run(store, "readonly", (s) => s.getAllKeys());
    const values = await this._run(store, "readonly", (s) => s.getAll());
    return keys.map((k, i) => [String(k), values[i]]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
  }
  async clear(store) { await this._run(store, "readwrite", (s) => s.clear()); }
  close() { try { this.db.close(); } catch (_) {} }
  async destroy() {
    this.close();
    await new Promise((resolve) => { const r = indexedDB.deleteDatabase(this.name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  }
}

// What each person on this device keeps is its own database, named by their account, so two people sharing a browser
// never see each other's pack. `user` null opens the device-wide one (who was signed in last, for opening offline).
export async function openStore(user) {
  const name = user ? `scire-offline:${user}` : "scire-offline";
  try {
    if (typeof indexedDB === "undefined") return new MemoryStore();
    return await IdbStore.open(name);
  } catch (_) {
    return new MemoryStore();
  }
}
