// One file for both sides, so it ships once: the page imports it for the API below, and the same file, started as a worker,
// runs the model.
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";
import { cleanModelUrl, planDownload } from "../../offline/modelplan.js";

export * from "./index.js";

// As a worker this file runs the model, and also works out a download plan on request: the worker is the one place the model's
// listing may be fetched from (the page's own policy does not allow those addresses).
async function planFor(record) {
  const base = cleanModelUrl(record.model);
  const json = async (file) => { const r = await fetch(new URL(file, base).href); if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`); return r.json(); };
  return planDownload(record, await json("mlc-chat-config.json"), await json("tensor-cache.json"));
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  const handler = new WebWorkerMLCEngineHandler();
  self.onmessage = async (message) => {
    const asked = message.data;
    if (asked && asked.scire === "plan") {
      try { self.postMessage({ scire: "plan", ok: true, plan: await planFor(asked.record) }); }
      catch (error) { self.postMessage({ scire: "plan", ok: false, error: String((error && error.message) || error) }); }
      return;
    }
    handler.onmessage(message);
  };
}
