// SCIRE's service worker: keeps the page itself on the device, so it opens with no connection.
//
// It caches the SHELL (the page, the scripts it runs, the icons), each by its content-hashed address, so a new deploy is a
// new cache and an old one is dropped. It NEVER touches what is private or live: every account, admin, tutor, health and
// mode address goes straight to the network, and an offline answer is the page's own on-device engine's job, not this file's.
//
// The server fills in %%VERSION%% and %%SHELL%% when it serves this file.
const VERSION = "%%VERSION%%";
const SHELL = %%SHELL%%;
const SHELL_CACHE = `scire-shell-${VERSION}`;
const RUNTIME_CACHE = "scire-runtime-v1";   // Pyodide (the "Try it in Python" box), kept after its first use
const NEVER = /^\/(auth|admin|tutor|health|mode|metrics|docs|openapi\.json)(\/|$)/;
const PAGE_WAIT_MS = 4000;                  // a connection that hangs is treated like none: show the page we already have

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith("scire-shell-") && name !== SHELL_CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function pageFromNetworkOrCache(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_WAIT_MS);
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) cache.put("/", response.clone());
    return response;
  } catch (_) {
    return (await cache.match("/", { ignoreSearch: true })) || Response.error();
  }
}

async function cacheFirst(request, cacheName = SHELL_CACHE) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = await cache.match(request);
  const fresh = fetch(request).then((response) => { if (response.ok || response.type === "opaque") cache.put(request, response.clone()); return response; });
  if (hit) { fresh.catch(() => {}); return hit; }
  return fresh;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (NEVER.test(url.pathname)) return;                                        // private and live: the network, always
    if (request.mode === "navigate") return event.respondWith(pageFromNetworkOrCache(request));
    // The on-device model's code (about 6 MB, fetched only when a learner asks for the model) is kept like the weights: across
    // deploys, under its content-hashed address, so a device that has the model can load it with no connection.
    if (url.pathname === "/assets/offline-model.js") return event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    if (url.pathname.startsWith("/assets/") || url.pathname === "/manifest.webmanifest") return event.respondWith(cacheFirst(request));
    return;
  }
  if (url.origin === "https://cdn.jsdelivr.net" && url.pathname.startsWith("/pyodide/")) event.respondWith(staleWhileRevalidate(request));
});

// --- The on-device AI, downloaded by the device's own download service ---
// A page cannot keep downloading once the screen is off: the phone pauses it. Background Fetch hands the download to the browser,
// which carries on with the screen off or the app closed, shows its progress in the device's notifications and wakes this worker
// when it ends. Here each file is put in the cache the AI library reads it from, under the address it would have been fetched from
// (offline/modelplan.js says which cache; the rule below is the same, by address alone), so the library then finds the model already
// on the device. The page may be closed by then, so the learner is told with a notification as well as in the page.
const MODEL_FETCH_PREFIX = "scire-model:";

function scopeFor(url) {
  if (/\/mlc-chat-config\.json$/.test(url)) return "webllm/config";
  if (/^https:\/\/raw\.githubusercontent\.com\//.test(url) || /\.wasm$/.test(url)) return "webllm/wasm";
  return "webllm/model";
}

async function tellPages(message) {
  for (const client of await self.clients.matchAll({ includeUncontrolled: true, type: "window" })) client.postMessage(message);
}

async function notify(title, body) {
  try {
    if (self.Notification && Notification.permission === "granted") {
      await self.registration.showNotification(title, { body, tag: "scire-model", icon: "/assets/icons/icon-192.png", badge: "/assets/icons/icon-192.png" });
    }
  } catch (_) { /* a notification is a courtesy: the page says it too */ }
}

async function openApp() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (windows.length) return windows[0].focus();
  return self.clients.openWindow("/");
}

self.addEventListener("backgroundfetchsuccess", (event) => {
  if (!event.registration.id.startsWith(MODEL_FETCH_PREFIX)) return;
  event.waitUntil((async () => {
    try {
      for (const record of await event.registration.matchAll()) {
        const response = await record.responseReady;
        if (!response || !response.ok) throw new Error(`HTTP ${response ? response.status : "none"} for ${record.request.url}`);
        await (await caches.open(scopeFor(record.request.url))).put(record.request.url, response);
      }
      event.updateUI({ title: "The AI is ready" });
      await tellPages({ type: "scire-model", state: "success", id: event.registration.id });
      await notify("The AI is ready", "You can work offline now.");
    } catch (error) {
      event.updateUI({ title: "The AI could not be saved" });
      await tellPages({ type: "scire-model", state: "failed", id: event.registration.id, error: String(error && error.message || error) });
      await notify("The AI download failed", "Open SCIRE to try again.");
    }
  })());
});

self.addEventListener("backgroundfetchfail", (event) => {
  if (!event.registration.id.startsWith(MODEL_FETCH_PREFIX)) return;
  event.waitUntil((async () => {
    // Keep what did arrive: the next attempt fetches only what is missing, so a stop near the end does not cost the whole download.
    try {
      for (const record of await event.registration.matchAll()) {
        try { const response = await record.responseReady; if (response && response.ok) await (await caches.open(scopeFor(record.request.url))).put(record.request.url, response); } catch (_) { /* this one did not finish */ }
      }
    } catch (_) { /* nothing to keep */ }
    await tellPages({ type: "scire-model", state: "failed", id: event.registration.id, error: event.registration.failureReason || "the download failed" });
    await notify("The AI download failed", "Open SCIRE to try again.");
  })());
});

self.addEventListener("backgroundfetchabort", (event) => {
  if (!event.registration.id.startsWith(MODEL_FETCH_PREFIX)) return;
  event.waitUntil(tellPages({ type: "scire-model", state: "aborted", id: event.registration.id }));
});

self.addEventListener("backgroundfetchclick", (event) => {
  if (event.registration.id.startsWith(MODEL_FETCH_PREFIX)) event.waitUntil(openApp());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openApp());
});
