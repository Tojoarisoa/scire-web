// SCIRE's optional on-device language model: WebLLM running a small Llama in the browser on the device's
// own GPU (WebGPU), in a worker so the page stays responsive. Nothing here is loaded until a learner asks for it, and once it is
// on the device nothing a learner asks leaves the device while it answers. The page uses it through four calls: `support`,
// `options`, `install`, and the `provider` the offline engine streams answers from.
import { CreateWebWorkerMLCEngine, hasModelInCache, deleteModelAllInfoInCache, prebuiltAppConfig } from "@mlc-ai/web-llm";

// Two Llama 3.2 sizes. f16 shaders make the download and the memory smaller and are on most GPUs; the f32 build is for the rest.
const CHOICES = {
  small: { label: "Llama 3.2 1B", f16: "Llama-3.2-1B-Instruct-q4f16_1-MLC", f32: "Llama-3.2-1B-Instruct-q4f32_1-MLC", note: "Fast, fits most phones and laptops." },
  better: { label: "Llama 3.2 3B", f16: "Llama-3.2-3B-Instruct-q4f16_1-MLC", f32: "Llama-3.2-3B-Instruct-q4f32_1-MLC", note: "Clearer answers; needs a recent laptop or phone." },
};

let engine = null, loadedId = null, workerUrl = "/assets/offline-model.js";   // the same file runs the model when started as a worker
export const configure = (opts) => { if (opts && opts.workerUrl) workerUrl = opts.workerUrl; };

// Can this device run a model at all? WebGPU is needed (Chrome and Edge, recent Safari); f16 decides which build.
export async function support() {
  try {
    if (!("gpu" in navigator)) return { ok: false, reason: "This browser cannot run an AI model on the device (no WebGPU).", f16: false };
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: "This device's graphics cannot run an AI model (no WebGPU adapter).", f16: false };
    return { ok: true, reason: "", f16: adapter.features.has("shader-f16") };
  } catch (error) {
    return { ok: false, reason: "This device cannot run an AI model.", f16: false };
  }
}

const record = (id) => prebuiltAppConfig.model_list.find((m) => m.model_id === id);
export const modelId = (choice, f16) => CHOICES[choice][f16 ? "f16" : "f32"];

// What a learner can pick, with the real download and memory sizes of the build this device would use.
export async function options() {
  const { f16 } = await support();
  return Object.entries(CHOICES).map(([key, c]) => {
    const id = modelId(key, f16), r = record(id);
    return { key, id, label: c.label, note: c.note, memory_mb: r ? Math.round(r.vram_required_MB) : null, download_mb: r ? Math.round(r.vram_required_MB * 0.8) : null };
  });
}

// The files this model needs, worked out in a throwaway worker (see entry.js). {id, items: [{url, scope, bytes}], bytes}
export async function plan(choice) {
  const { f16 } = await support();
  const id = modelId(choice, f16), r = record(id);
  const worker = new Worker(workerUrl, { type: "module" });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = (m) => { if (m.data && m.data.scire === "plan") (m.data.ok ? resolve({ id, ...m.data.plan }) : reject(new Error(m.data.error))); };
      worker.onerror = (e) => reject(new Error(e.message || "the planning worker failed"));
      worker.postMessage({ scire: "plan", record: { model: r.model, model_lib: r.model_lib } });
    });
  } finally { worker.terminate(); }
}

export async function installed(choice) {
  const { f16 } = await support();
  try { return await hasModelInCache(modelId(choice, f16)); } catch (_) { return false; }
}

// Download (the first time) and start the model. `onProgress({fraction, text})` follows the download.
export async function install(choice, onProgress = () => {}) {
  const sup = await support();
  if (!sup.ok) throw new Error(sup.reason);
  const id = modelId(choice, sup.f16);
  if (engine && loadedId === id) return id;
  await unload();
  const worker = new Worker(workerUrl, { type: "module" });
  engine = await CreateWebWorkerMLCEngine(worker, id, { initProgressCallback: (p) => onProgress({ fraction: p.progress, text: p.text }) });
  loadedId = id;
  return id;
}

export async function unload() {
  if (engine) { try { await engine.unload(); } catch (_) {} }
  engine = null; loadedId = null;
}

export async function remove(choice) {
  await unload();
  const { f16 } = await support();
  for (const flag of [f16, !f16]) { try { await deleteModelAllInfoInCache(modelId(choice, flag)); } catch (_) {} }
}

// The offline engine's model: streams the text of an answer. `choice` is which build to load if it is not in memory yet.
export function provider(getChoice) {
  return {
    ready: true,
    async *stream(system, user, { maxTokens = 120, signal } = {}) {
      if (!engine) await install(getChoice());
      const stop = () => { try { engine.interruptGenerate(); } catch (_) {} };
      if (signal) { if (signal.aborted) return; signal.addEventListener("abort", stop, { once: true }); }
      const chunks = await engine.chat.completions.create({
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        stream: true, max_tokens: maxTokens, temperature: 0.3, top_p: 0.9,
      });
      for await (const chunk of chunks) {
        const piece = chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
        if (piece) yield piece;
        if (signal && signal.aborted) return;
      }
    },
  };
}
