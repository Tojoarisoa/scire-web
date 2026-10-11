// SCIRE offline: the entry the page loads. It keeps the page itself on the device (the service worker), downloads
// the learner's pack in the background after sign-in, watches the connection and switches mode by itself, answers from the
// device while offline, and sends what was done when the connection is back. The page talks to it through one object,
// `window.ScireOffline`; everything else here is private.
import { openStore } from "./store.js";
import { syncPack, loadPack } from "./pack.js";
import { Outbox, syncOutbox } from "./outbox.js";
import { Engine } from "./engine.js";
import { ConnectionMode, healthProbe } from "./mode.js";
import { friendlyFailure, progressFraction } from "./modelplan.js";

export async function registerShell() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return null;
  try { return await navigator.serviceWorker.register("/sw.js", { scope: "/" }); } catch (_) { return null; }
}

const PACK_RETRY_MS = 60000, REFRESH_EVERY_MS = 10 * 60000;
const state = {
  user: null, mode: "online", reason: "", manual: false, reachable: true, persistent: false,
  pack: { status: "none", fraction: 0, bytes: 0, at: null, passages: 0, topics: 0, error: "" },
  pending: 0, syncing: false, lastSync: null, lastResult: null, autoSync: true,
  model: { status: "none", fraction: 0, text: "", choice: "small", supported: null, error: "", background: null, pendingOffline: false, lost: false, canBackground: null, ios: false, paused: false },
};
const listeners = new Set();
const emit = () => { const snapshot = status(); for (const fn of listeners) { try { fn(snapshot); } catch (_) {} } };
export const status = () => structuredClone(state);

let config = { base: () => "", headers: () => ({}) };
let device = null, store = null, outbox = null, engine = null, conn = null, packTimer = null, refreshTimer = null, packRunning = null;
let modeInfoCache = null, modelProvider = null;

const base = () => config.base();
async function api(path, init = {}) {
  const res = await fetch(`${base()}${path}`, { ...init, headers: { ...(init.headers || {}), ...config.headers() } });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}

async function loadPrefs() {
  const prefs = (await device.get("meta", "prefs")) || {};
  state.autoSync = prefs.autoSync !== false;
  state.manual = !!prefs.manual;
}
const savePrefs = () => device.set("meta", "prefs", { autoSync: state.autoSync, manual: state.manual });

async function refreshCounts() {
  state.pending = outbox ? await outbox.count() : 0;
  emit();
}

async function buildEngine() {
  const pack = await loadPack(store);
  if (!pack) { engine = null; return false; }
  engine = await new Engine({ pack, outbox, identity: { username: state.user }, modeInfo: () => modeInfoCache }).init();
  if (modelProvider) engine.setModel(modelProvider());
  state.pack = { ...state.pack, status: "ready", fraction: 1, bytes: pack.pack.bytes, at: pack.pack.at, passages: pack.pack.passages, topics: pack.pack.topics, error: "" };
  return true;
}

// Download (or top up) the pack. Safe to call often: one run at a time, and a run with nothing new only fetches the snapshot.
async function ensurePack() {
  if (!state.user || !state.reachable) return;
  if (packRunning) return packRunning;
  packRunning = (async () => {
    if (state.pack.status !== "ready") state.pack = { ...state.pack, status: "downloading", fraction: 0, error: "" };
    emit();
    const result = await syncPack({
      fetchJson: (path) => api(path), store,
      onProgress: (p) => { if (state.pack.status !== "ready") { state.pack = { ...state.pack, fraction: p.fraction, bytes: p.bytes }; emit(); } },
    });
    if (result.status === "downloaded" || result.status === "current") {
      await buildEngine();
      clearTimeout(packTimer); packTimer = null;
    } else {
      const forbidden = result.error && (result.error.status === 401 || result.error.status === 403);
      state.pack = { ...state.pack, status: state.pack.status === "ready" ? "ready" : forbidden ? "none" : "waiting", error: forbidden ? "" : String(result.error || "") };
      if (!forbidden) packTimer = setTimeout(ensurePack, PACK_RETRY_MS);   // a lost connection: carry on where it stopped
    }
    emit();
  })().finally(() => { packRunning = null; });
  return packRunning;
}

async function syncNow() {
  if (!outbox || state.syncing || !state.reachable) return state.lastResult;
  state.syncing = true; emit();
  const result = await syncOutbox({ outbox, post: (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), device: navigator.userAgent.includes("Mobile") ? "phone" : "computer" });
  state.syncing = false;
  state.lastResult = { ok: result.ok, applied: result.applied, duplicates: result.duplicates, at: new Date().toISOString() };
  if (result.ok) state.lastSync = state.lastResult.at;
  await refreshCounts();
  if (result.ok && result.applied + result.duplicates > 0) { await ensurePack(); await buildEngine(); }   // the server's fresh progress replaces the local overlay
  emit();
  return state.lastResult;
}

function onModeChange(next) {
  const was = state.mode;
  Object.assign(state, { mode: next.mode, reason: next.reason, manual: next.manual, reachable: next.reachable });
  emit();
  if (next.reachable) {
    ensurePack();
    if (state.autoSync && state.pending > 0 && (was === "offline" || next.mode === "online")) syncNow();
  }
  for (const fn of modeHooks) { try { fn(status(), was); } catch (_) {} }
}
const modeHooks = new Set();

// --- The optional on-device language model: a separate file, fetched only when a learner asks for it ---
const MODEL_URL = () => { const m = document.querySelector('meta[name="scire-model"]'); return m ? m.content : ""; };
let modelModule = null;
async function loadModelModule() {
  if (!modelModule) { const url = MODEL_URL(); if (!url) throw new Error("This deployment has no on-device model."); modelModule = await import(url); modelModule.configure({ workerUrl: url }); }
  return modelModule;
}
async function webgpu() { try { return !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch (_) { return false; } }
// What the engine streams answers from: loads the model into memory on first use, then streams.
const makeProvider = () => ({
  ready: true,
  async *stream(system, user, opts) { const mod = await loadModelModule(); yield* mod.provider(() => state.model.choice).stream(system, user, opts); },
});
// Background Fetch (Chrome and Edge): the device's own download service, which carries on with the screen off or the app closed.
// Elsewhere (iPhone Safari, Firefox) the page downloads itself, so it keeps the screen awake and says to keep it open.
const MODEL_FETCH_PREFIX = "scire-model:";
const newFetchId = (choice) => `${MODEL_FETCH_PREFIX}${choice}:${Date.now()}`;      // one per attempt: a finished one cannot be started again under its name
async function activeFetch(reg) {                                                  // the newest background download of this AI, if any is on record
  try {
    const ids = (await reg.backgroundFetch.getIds()).filter((id) => id.startsWith(MODEL_FETCH_PREFIX)).sort();
    for (const id of ids.reverse()) { const bg = await reg.backgroundFetch.get(id); if (bg) return bg; }
  } catch (_) {}
  return null;
}
const missingFiles = async (items) => {                                            // what is not in the library's caches yet
  const out = [];
  for (const item of items) { try { if (!(await (await caches.open(item.scope)).match(item.url))) out.push(item); } catch (_) { out.push(item); } }
  return out;
};
async function backgroundFetchReady() {
  try {
    if (!("serviceWorker" in navigator) || !("BackgroundFetchManager" in self)) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.backgroundFetch ? reg : null;
  } catch (_) { return null; }
}
let wakeLock = null;
async function holdScreen() { try { if (navigator.wakeLock && !wakeLock) wakeLock = await navigator.wakeLock.request("screen"); } catch (_) { wakeLock = null; } }
function releaseScreen() { try { if (wakeLock) wakeLock.release(); } catch (_) {} wakeLock = null; }
const isIos = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);   // every iPhone browser runs Apple's engine
let hiddenDuringDownload = false;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { if (state.model.status === "downloading" && state.model.background === false) hiddenDuringDownload = true; return; }
  if (state.model.status === "downloading" && state.model.background === false) holdScreen();
  // Back in front after the screen turned off: what was saved is kept, so carry on by itself instead of waiting for a tap.
  if (state.model.status === "error" && state.model.paused) api_.model.install(state.model.choice, { thenOffline: state.model.pendingOffline, resume: true });
});

async function savedModel() { return (await device.get("meta", "model")) || {}; }
async function saveModel(patch) { await device.set("meta", "model", { ...(await savedModel()), ...patch }); }

async function askNotifications() {   // so the learner is told when the download ends, even with the app closed
  try { if ("Notification" in self && Notification.permission === "default") await Notification.requestPermission(); } catch (_) {}
}
async function notifyFromPage(title, body) {   // the worker does this itself for a background download; the page does it for its own
  try {
    if ("Notification" in self && Notification.permission === "granted" && "serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, { body, tag: "scire-model", icon: "/assets/icons/icon-192.png", badge: "/assets/icons/icon-192.png" });
    }
  } catch (_) {}
}

// The AI is downloaded once for this device and kept (the browser's own storage, asked to keep it): signing out, a new session, going
// offline again or another learner on the same device never download it again. These two read how much of it is there.
async function modelFileCount() {
  try { return "caches" in self ? (await (await caches.open("webllm/model")).keys()).length : 0; } catch (_) { return 0; }
}
async function keepStorage() { try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) {} }

// The AI is on the device: remember it, offer it to the engine, and start working offline if that is what the learner asked for.
async function modelArrived(choice, { notify = false } = {}) {
  const saved = await savedModel();
  await saveModel({ choice, installed: true, pendingOffline: false, files: await modelFileCount() });
  await keepStorage();
  modelProvider = makeProvider;
  if (engine) engine.setModel(modelProvider());
  state.model = { ...state.model, status: "ready", fraction: 1, error: "", background: null, choice, pendingOffline: false, lost: false };
  if (notify) await notifyFromPage("The AI is ready", saved.pendingOffline ? "You are now working offline." : "You can work offline now.");
  if (saved.pendingOffline) { state.manual = true; await savePrefs(); if (conn) conn.setManual(true); }
  emit();
}

// Wait until the files the worker is filing in the cache are all there (it may finish after this page was closed and reopened).
async function waitForFiles(mod, choice, ms = 180000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await mod.installed(choice)) return true; await new Promise((r) => setTimeout(r, 1000)); }
  return false;
}

function followBackground(bg, mod, choice, listedBytes) {
  return new Promise((resolve, reject) => {
    let done = false;
    const progress = () => {
      state.model = { ...state.model, fraction: progressFraction(bg.downloaded, listedBytes), text: "" };
      emit();
      if (bg.result && !done) { done = true; bg.result === "success" ? resolve() : reject(new Error(bg.failureReason || "the download stopped")); }
    };
    bg.addEventListener("progress", progress);
    progress();
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (!e.data || e.data.type !== "scire-model" || done) return;
      if (e.data.state === "failed") { done = true; reject(new Error(e.data.error || "the download failed")); }
      if (e.data.state === "aborted") { done = true; reject(new Error("the download was cancelled")); }
    });
  }).then(async () => { if (!(await waitForFiles(mod, choice))) throw new Error("the files could not be saved"); });
}

async function initModel() {
  const supported = await webgpu();
  const saved = await savedModel();
  state.model = { ...state.model, supported, choice: saved.choice || "small", pendingOffline: !!saved.pendingOffline, canBackground: !!(await backgroundFetchReady()), ios: isIos() };
  if (supported && saved.installed) {
    if ((await modelFileCount()) >= (saved.files || 1)) { state.model.status = "ready"; modelProvider = makeProvider; return; }
    await saveModel({ installed: false, files: 0 });          // the browser cleared its storage: say so, and offer the download again
    state.model.lost = true;
  }
  state.model.status = supported ? "none" : "unsupported";
  if (!supported) return;
  // A download that went on while the app was closed: pick it up again, or finish what it left.
  const reg = await backgroundFetchReady();
  if (!reg) return;
  const bg = await activeFetch(reg);
  if (!bg) return;
  const choice = String(bg.id).split(":")[1] || saved.choice || "small";
  state.model = { ...state.model, status: "downloading", choice, background: true, fraction: 0 };
  (async () => {
    try {
      const mod = await loadModelModule();
      await followBackground(bg, mod, choice, saved.listedBytes || 0);
      await modelArrived(choice, { notify: false });
    } catch (error) {
      state.model = { ...state.model, status: "error", error: friendlyFailure(error && error.message), background: null };
      emit();
    }
  })();
}

async function start(user) {
  if (state.user === user && conn) return;
  await stop(false);
  state.user = user;
  await device.set("meta", "identity", { username: user, saved_at: new Date().toISOString() });
  store = await openStore(user);
  state.persistent = !!store.persistent;
  outbox = new Outbox(store);
  outbox.onChange = () => { refreshCounts(); };          // the chip and Settings follow the queue as answers are given and sent
  await refreshCounts();
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) {}
  await buildEngine();
  conn = new ConnectionMode({ probe: healthProbe(base()), onChange: onModeChange, startOnline: navigator.onLine !== false });
  conn.setManual(state.manual);
  Object.assign(state, { mode: conn.mode, reachable: conn.reachable });
  conn.start();
  if (navigator.onLine !== false) conn.check();
  refreshTimer = setInterval(() => { if (state.reachable) ensurePack(); }, REFRESH_EVERY_MS);
  ensurePack();
  emit();
}

async function stop(forget) {
  if (conn) conn.stop();
  clearInterval(refreshTimer); clearTimeout(packTimer);
  conn = null; engine = null;
  if (forget && store) {
    const keep = outbox ? await outbox.pending() : [];       // what was done offline is kept to be sent; the private material is not
    await store.clear("parts");
    for (const key of ["pack", "progress", "state"]) await store.del("meta", key);
    await device.del("meta", "identity");
    if (keep.length) store.close(); else await store.destroy();
  } else if (store) store.close();
  store = outbox = null;
  Object.assign(state, { user: null, mode: "online", reason: "", reachable: true, pack: { status: "none", fraction: 0, bytes: 0, at: null, passages: 0, topics: 0, error: "" }, pending: 0 });
  emit();
}

// What the page uses.
const api_ = {
  configure(next) { config = { ...config, ...next }; },
  subscribe(fn) { listeners.add(fn); fn(status()); return () => listeners.delete(fn); },
  onModeChange(fn) { modeHooks.add(fn); },
  status,
  async signedIn(username) { try { await start(username); } catch (_) { /* the page works without it */ } },
  async signedOut() { try { await stop(true); } catch (_) {} },
  refresh() { if (state.user) ensurePack(); },
  rememberMode(info) { modeInfoCache = info; if (device) device.set("meta", "mode", info).catch(() => {}); },   // what the page shows while offline
  async setManual(on) { state.manual = !!on; await savePrefs(); if (conn) conn.setManual(on); emit(); },
  async setAutoSync(on) { state.autoSync = !!on; await savePrefs(); emit(); if (on && state.pending > 0) syncNow(); },
  syncNow,
  async removeData() { const user = state.user; await stop(true); if (user) { const s = await openStore(user); await s.destroy(); } },
  model: {
    // `thenOffline`: the learner chose "Work offline" and asked for the AI first: go offline when it is ready.
    async install(choice, { thenOffline = false } = {}) {
      if (state.model.status === "downloading" || !state.model.supported) return;
      await askNotifications();
      await saveModel({ choice, pendingOffline: !!thenOffline });
      state.model = { ...state.model, status: "downloading", fraction: 0, text: "", choice, error: "", background: null, pendingOffline: !!thenOffline }; emit();
      try {
        const mod = await loadModelModule();
        if (await mod.installed(choice)) { await modelArrived(choice, { notify: false }); return; }   // already on the device: never again
        await keepStorage();
        const reg = await backgroundFetchReady();
        const inPage = async (why) => {                                  // the page downloads itself: it needs the screen on
          state.model = { ...state.model, background: false, error: why || "", paused: false }; emit();
          hiddenDuringDownload = document.hidden;
          await holdScreen();
          try { await mod.install(choice, (p) => { state.model = { ...state.model, fraction: Math.max(0, Math.min(1, p.fraction || 0)), text: p.text || "" }; emit(); }); }
          catch (error) {
            // The phone froze the page when the screen turned off: not a failure of the download, and what arrived is kept.
            if (hiddenDuringDownload || document.hidden) { const e = new Error("paused while the app was in the background"); e.paused = true; throw e; }
            throw error;
          }
          finally { releaseScreen(); }
          await modelArrived(choice, { notify: true });
        };
        if (reg) {
          try {
            const plan = await mod.plan(choice);
            const todo = await missingFiles(plan.items);                 // a stopped attempt kept what it finished: fetch only the rest
            if (!todo.length) { await modelArrived(choice, { notify: false }); return; }
            const listed = todo.reduce((sum, i) => sum + i.bytes, 0);
            await saveModel({ listedBytes: listed });
            const bg = await reg.backgroundFetch.fetch(newFetchId(choice), todo.map((i) => new Request(i.url, { mode: "cors" })), {
              title: "Downloading the SCIRE AI", icons: [{ src: "/assets/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
              downloadTotal: 0,    // unknown on purpose: a total that is too small makes the browser stall (the tokenizer and compiled code are not in the listing)
            });
            state.model = { ...state.model, background: true }; emit();
            await followBackground(bg, mod, choice, listed);
            await modelArrived(choice, { notify: false });       // the worker already told the learner
          } catch (error) {
            // The browser refused (it asks permission for a second background download) or the download stopped. With the page open and
            // visible it carries on by itself, from what is already saved; with the app closed the worker has kept what arrived.
            if (document.hidden) throw error;
            await inPage(friendlyFailure(error && error.message));
          }
        } else {
          await inPage("");
        }
      } catch (error) {
        const paused = !!(error && error.paused);
        state.model = { ...state.model, status: "error", error: paused ? "" : friendlyFailure(error && error.message), background: null, paused, pendingOffline: paused ? state.model.pendingOffline : false };
        if (!paused) await saveModel({ pendingOffline: false });
      }
      emit();
    },
    // The AI is on its way and the learner wants to go offline as soon as it arrives.
    async offlineWhenReady() { await saveModel({ pendingOffline: true }); state.model = { ...state.model, pendingOffline: true }; emit(); },
    async remove() {
      try { const reg = await backgroundFetchReady(); const bg = reg && await activeFetch(reg); if (bg && !bg.result) await bg.abort(); } catch (_) {}
      try { const mod = await loadModelModule(); await mod.remove(state.model.choice); } catch (_) {}
      await device.del("meta", "model");
      modelProvider = null; if (engine) engine.setModel(null);
      state.model = { ...state.model, status: state.model.supported ? "none" : "unsupported", fraction: 0, error: "" };
      emit();
    },
    choose(choice) { state.model = { ...state.model, choice }; device.get("meta", "model").then((m) => device.set("meta", "model", { ...(m || {}), choice })); emit(); },
  },
  // A request from the page: the device answers while offline, the network otherwise (and the device if the network just failed).
  async fetch(url, init) {
    if (state.mode === "offline" && engine) return engine.fetch(url, init);
    try { return await fetch(url, init); } catch (error) {
      if (engine && state.user && !(init && init.signal && init.signal.aborted)) { if (conn) conn.check(); return engine.fetch(url, init); }
      throw error;
    }
  },
};

async function init() {
  registerShell();
  device = await openStore(null);
  await loadPrefs();
  modeInfoCache = await device.get("meta", "mode");
  await initModel();
  window.ScireOffline = api_;
  const last = await device.get("meta", "identity");
  // Opened with no connection: take up where this device left off, so the page can open as that learner before it can ask anyone.
  if (last && last.username && navigator.onLine === false) await start(last.username);
  window.addEventListener("online", () => conn && conn.browser(true));
  window.addEventListener("offline", () => conn && conn.browser(false));
  document.addEventListener("visibilitychange", () => { if (!document.hidden && conn) conn.check(); });
}

init().catch(() => {}).finally(() => { if (window.__offlineResolve) window.__offlineResolve(); });
