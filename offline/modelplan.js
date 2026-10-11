// SCIRE offline: which files the on-device AI needs. The AI library reads its files from the browser's
// cache under the exact web addresses it would have downloaded them from; so to download them some other way (the device's own
// background download service) the same files have to be put in the same caches under the same addresses. This works the list
// out from the model's own listing, and says which cache each file belongs in. Pure, so it is tested without a browser.

export const SCOPES = { config: "webllm/config", model: "webllm/model", wasm: "webllm/wasm" };

// The library's own rule for a model's base address: .../USER/MODEL becomes .../USER/MODEL/resolve/main/
export function cleanModelUrl(modelUrl) {
  modelUrl += modelUrl.endsWith("/") ? "" : "/";
  if (!/.+\/resolve\/.+\//.test(modelUrl)) modelUrl += "resolve/main/";
  return new URL(modelUrl).href;
}

// Which of the library's three caches a file lives in (the service worker uses the same rule, by address alone).
export function scopeFor(url) {
  if (/\/mlc-chat-config\.json$/.test(url)) return SCOPES.config;
  if (/^https:\/\/raw\.githubusercontent\.com\//.test(url) || /\.wasm$/.test(url)) return SCOPES.wasm;
  return SCOPES.model;
}

// What a learner is told when the background download stops: the browser's reason, in plain words.
export function friendlyFailure(reason) {
  const text = String(reason || "").toLowerCase();
  if (/quota|storage|space/.test(text)) return "not enough free space";
  if (/bad-status|status/.test(text)) return "the download server refused a file";
  if (/fetch-error|network|connection|failed to fetch/.test(text)) return "the connection dropped";
  if (/aborted|cancel/.test(text)) return "it was cancelled";
  if (/permission/.test(text)) return "the browser did not allow a background download";
  return "the download was interrupted";
}

// How far along a download is, for a progress bar. The browser is told the total is unknown (a total that is too small makes it
// stall, and the tokenizer and compiled code are not in the model's listing), so the size is estimated: the listed bytes plus room
// for what the listing leaves out. Never shown as finished before it is.
export function progressFraction(downloaded, listedBytes) {
  const expected = Math.max(1, Math.ceil(listedBytes * 1.03) + 30 * 1048576);
  return Math.max(0, Math.min(0.99, downloaded / expected));
}

// record: the model's entry in the library's list ({model, model_lib}); chatConfig: its mlc-chat-config.json;
// tensorCache: its tensor-cache.json (the list of weight files with their sizes).
export function planDownload(record, chatConfig, tensorCache) {
  const base = cleanModelUrl(record.model);
  const at = (file) => new URL(file, base).href;
  const items = [{ url: at("mlc-chat-config.json"), bytes: 0 }, { url: at("tensor-cache.json"), bytes: 0 }];
  for (const file of chatConfig.tokenizer_files || []) items.push({ url: at(file), bytes: 0 });
  const shards = new Map();
  for (const r of tensorCache.records || []) shards.set(r.dataPath, (shards.get(r.dataPath) || 0) + (Number(r.nbytes) || 0));
  for (const [path, bytes] of shards) items.push({ url: at(path), bytes });
  if (record.model_lib) items.push({ url: new URL(record.model_lib, base).href, bytes: 0 });
  const seen = new Set();
  const unique = items.filter((i) => (seen.has(i.url) ? false : (seen.add(i.url), true))).map((i) => ({ ...i, scope: scopeFor(i.url) }));
  return { items: unique, bytes: unique.reduce((sum, i) => sum + i.bytes, 0) };
}
