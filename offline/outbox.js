// SCIRE offline: what was done with no connection, kept until it is sent. Each answer is a dated
// event with its own id; the server applies each id once, in time order, so sending twice is harmless and a lost reply only
// means "send again".

export class Outbox {
  constructor(store, { now = () => Date.now(), uuid = () => crypto.randomUUID() } = {}) { this.store = store; this.now = now; this.uuid = uuid; this.onChange = null; }
  _changed() { if (this.onChange) { try { this.onChange(); } catch (_) {} } }

  async add({ kind, topic, score, confidence = null, hints_used = 0, at = this.now() }) {
    const event = { id: this.uuid(), kind, topic, score, confidence, hints_used, at: new Date(at).toISOString() };
    await this.store.set("outbox", event.id, event);
    this._changed();
    return event;
  }
  async pending() { return (await this.store.all("outbox")).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)); }
  async count() { return (await this.store.keys("outbox")).length; }
  async remove(ids) { for (const id of ids) await this.store.del("outbox", id); this._changed(); }
}

const BATCH = 500;

// Send everything waiting, a batch at a time. `post(path, body)` resolves with the parsed answer or throws. An event the server
// refused for good (bad data) is dropped so it cannot block the rest; one it merely could not record yet is kept for next time.
export async function syncOutbox({ outbox, post, device = "browser" }) {
  const total = { applied: 0, duplicates: 0, rejected: [], state: null };
  for (;;) {
    const events = (await outbox.pending()).slice(0, BATCH);
    if (!events.length) return { ok: true, ...total };
    let answer;
    try { answer = await post("/tutor/sync", { device, events }); } catch (error) { return { ok: false, error, ...total }; }
    const keep = new Set(answer.rejected.filter((r) => r.why === "could not be recorded").map((r) => r.id));
    await outbox.remove(events.map((e) => e.id).filter((id) => !keep.has(id)));
    total.applied += answer.applied; total.duplicates += answer.duplicates; total.rejected.push(...answer.rejected); total.state = answer.state;
    if (keep.size && keep.size === events.length) return { ok: false, error: new Error("the server could not record them yet"), ...total };
  }
}
