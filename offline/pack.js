// SCIRE offline: the pack, downloaded in the background. `GET /tutor/offline/manifest` says what is
// there; the passages and questions come in pages that remember where they stopped, so a lost connection costs a page, not the
// whole download; the progress snapshot is fetched again every time, because it is the part that changes. A new version is
// built next to the old pack, which keeps serving until the new one is complete.

const PARTS = ["passages", "questions"];

export async function syncPack({ fetchJson, store, onProgress = () => {}, now = () => Date.now() }) {
  let manifest;
  try { manifest = await fetchJson("/tutor/offline/manifest"); } catch (error) { return { status: "unavailable", error }; }
  const have = await store.get("meta", "pack");
  const current = !!(have && have.complete && have.version === manifest.version);
  let progress = await store.get("meta", "progress");
  if (!current && !(progress && progress.version === manifest.version)) {
    progress = { version: manifest.version, parts: { passages: { next: 0, done: false }, questions: { next: 0, done: false } } };
    await store.set("meta", "progress", progress);
  }
  const total = { passages: manifest.passages || 1, questions: manifest.topics || 1 };
  const weight = { passages: 0.7, questions: 0.25, state: 0.05 };
  const report = (part, fraction) => {
    let done = 0;
    for (const p of PARTS) done += weight[p] * (progress.parts[p].done ? 1 : p === part ? fraction : Math.min(1, progress.parts[p].next / total[p]));
    onProgress({ part, fraction: Math.min(1, done), version: manifest.version, bytes: manifest.bytes });
  };
  try {
    if (!current) {
      for (const part of PARTS) {
        const p = progress.parts[part];
        while (!p.done) {
          report(part, Math.min(1, p.next / total[part]));
          const page = await fetchJson(`/tutor/offline/pack/${part}?offset=${p.next}`);
          await store.set("parts", `${manifest.version}:${part}:${String(p.next).padStart(8, "0")}`, page.items);
          p.next = page.next; p.done = !!page.done;
          await store.set("meta", "progress", progress);
        }
      }
    }
    const state = (await fetchJson("/tutor/offline/pack/state")).items[0];
    await store.set("meta", "state", state);
    const pack = { version: manifest.version, complete: true, built_at: manifest.built_at, bytes: manifest.bytes, passages: manifest.passages, topics: manifest.topics, at: new Date(now()).toISOString(), state_at: state.built_at };
    await store.set("meta", "pack", pack);
    if (!current) {                                              // the new pack is whole: forget the old one's pages
      for (const key of await store.keys("parts")) if (!key.startsWith(`${manifest.version}:`)) await store.del("parts", key);
      await store.del("meta", "progress");
    }
    onProgress({ part: "state", fraction: 1, version: manifest.version, bytes: manifest.bytes });
    return { status: current ? "current" : "downloaded", pack };
  } catch (error) {
    return { status: "interrupted", error };
  }
}

// What the device holds, ready for the engine; null before the first complete download.
export async function loadPack(store) {
  const pack = await store.get("meta", "pack");
  const state = await store.get("meta", "state");
  if (!pack || !pack.complete || !state) return null;
  const pages = async (part) => {
    const out = [];
    for (const key of await store.keys("parts")) if (key.startsWith(`${pack.version}:${part}:`)) out.push(...(await store.get("parts", key)));
    return out;
  };
  return { pack, state, passages: await pages("passages"), questions: await pages("questions") };
}
