// SCIRE offline: which way the page is working right now. It watches two things, the browser's own
// online/offline signal and a small check of /health, and changes mode by itself, with a little patience so a flaky
// connection does not make it flap: going offline takes the browser saying so (at once) or two failed checks; coming back needs
// two good checks in a row. The learner can also choose offline by hand, which holds until they say otherwise.

export class ConnectionMode {
  constructor({ probe, onChange = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
                offlineAfter = 2, onlineAfter = 2, onlineEvery = 30000, offlineEvery = 5000, startOnline = true } = {}) {
    Object.assign(this, { probe, onChange, setTimer, clearTimer, offlineAfter, onlineAfter, onlineEvery, offlineEvery });
    this.auto = startOnline ? "online" : "offline";
    this.reason = startOnline ? "" : "browser";
    this.manual = false;
    this.fails = 0; this.oks = 0; this.timer = null; this.running = false; this.checking = null;
    this._last = this.mode;
    this._lastReason = this.manual ? "chosen" : this.reason;   // what was last announced: nothing changed yet
  }

  get mode() { return this.manual ? "offline" : this.auto; }
  get reachable() { return this.auto === "online"; }   // whether the server could be reached, whatever the learner chose

  _emit() {
    const state = { mode: this.mode, reason: this.manual ? "chosen" : this.reason, manual: this.manual, reachable: this.reachable };
    if (state.mode !== this._last || this._lastReason !== state.reason) { this._last = state.mode; this._lastReason = state.reason; this.onChange(state); }
  }

  start() { this.running = true; this._schedule(); }
  stop() { this.running = false; if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }
  _schedule() {
    if (!this.running) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; this.check(); }, this.auto === "online" ? this.onlineEvery : this.offlineEvery);
  }

  // The browser's own signal (the "online" and "offline" events).
  browser(online) {
    if (!online) { this.auto = "offline"; this.reason = "browser"; this.fails = this.offlineAfter; this.oks = 0; this._emit(); this._schedule(); return Promise.resolve(); }
    return this.check({ burst: true });   // "online" only means a network exists: ask the server
  }

  setManual(offline) { this.manual = !!offline; this._emit(); }

  // One look at the server. `burst` looks again at once after a good answer, so coming back does not wait a whole interval.
  async check({ burst = false } = {}) {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      let ok = false;
      try { ok = !!(await this.probe()); } catch (_) { ok = false; }
      if (ok) {
        this.fails = 0; this.oks++;
        if (this.auto === "offline" && this.oks >= this.onlineAfter) { this.auto = "online"; this.reason = ""; }
      } else {
        this.oks = 0; this.fails++;
        if (this.auto === "online" && this.fails >= this.offlineAfter) { this.auto = "offline"; this.reason = "unreachable"; }
      }
      this._emit();
    })();
    try { await this.checking; } finally { this.checking = null; }
    if (burst && this.auto === "offline" && this.oks > 0 && this.oks < this.onlineAfter) return this.check({ burst: true });
    this._schedule();
  }
}

// The probe the page uses: a plain GET of /health that skips every cache and gives up after a few seconds, so a connection
// that hangs counts as no connection.
export function healthProbe(base = "", { timeoutMs = 4000, fetchFn = (...a) => fetch(...a) } = {}) {
  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return (await fetchFn(`${base}/health`, { cache: "no-store", signal: controller.signal })).ok; }
    catch (_) { return false; }
    finally { clearTimeout(timer); }
  };
}
