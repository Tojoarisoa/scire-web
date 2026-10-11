// SCIRE offline: the tutor on the device. It answers the same addresses the page asks the server, from
// the pack: `fetch(url, init)` returns a real Response, so the page's own code (callApi, the chat stream) needs no second path.
// A question is answered from the learner's passages (keyword search), and by the small model on the device when there is one;
// practice and review use SM-2 and the same grading rule as the server, and every answer given is queued for the next sync.
import { PassageIndex } from "./search.js";
import * as M from "./mastery.js";
import * as P from "./practice.js";
import { PROMPTS, MAX_TOKENS } from "./prompts.js";
import { truncateExcerpt, focusExcerpt, wantsDirectAnswer } from "./text.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const needsConnection = (what) => json(503, { detail: `${what} needs a connection.` });
const r3 = (x) => M.pyRound(x * 1000) / 1000;
const NOT_FOUND = "I couldn't find that in the material yet. Try rephrasing, or ask about a specific file, function or heading.";
const FILE = String.raw`\[?[\w./\-]+\.(?:md|py|sql|ipynb|ya?ml|tf|txt)\]?`;
const CITATION = new RegExp(String.raw`\s*\(\s*(?:sources?\s*:\s*)?${FILE}(?:\s*,\s*${FILE})*\s*\)`, "gi");
export const stripCitations = (text) => text.replace(CITATION, "");
const OUTPUT_GUARD_MAX_CHARS = 4000, ANSWER_SAFETY_MARGIN = 50;

export class Engine {
  constructor({ pack, outbox, identity, now = () => Date.now(), modeInfo = () => null, random = Math.random }) {
    this.state = pack.state;
    this.index = new PassageIndex(pack.passages);
    this.questions = new Map(pack.questions.map((q) => [q.id, q]));
    this.outbox = outbox;
    this.identity = identity;
    this.now = now;
    this.modeInfo = modeInfo;
    this.random = random;
    this.model = null;               // { ready: bool, stream(system, user, { maxTokens, signal }) -> async iterable of text }
    this.served = new Map();         // topic -> the id of the question given last, so the next one is a different one
    this.revealed = new Set();
    this.records = {};
    this.attempts = [];
  }

  // The server's snapshot, then what was done since it was taken and has not been sent yet.
  async init() {
    this.records = {}; this.attempts = this.state.attempts.map((a) => ({ ...a }));
    const lastAt = {};
    for (const a of this.attempts) lastAt[a.topic] = a.at;
    for (const r of this.state.mastery) this.records[r.topic] = { ...r, last_reviewed_at: lastAt[r.topic] || null };
    for (const e of await this.outbox.pending()) M.recordAttempt(this.records, this.attempts, e);
    return this;
  }

  setModel(model) { this.model = model || null; }
  get hasModel() { return !!(this.model && this.model.ready); }

  scopeOf(source) { return source && source !== "course" ? source : "course"; }
  trackOf(source) { const s = this.state.scopes.find((x) => x.id === this.scopeOf(source)); return s ? s.track : null; }
  recordDict(r) { return { user_id: this.state.user, topic: r.topic, ease_factor: r3(r.ease_factor), interval_days: r.interval_days, repetitions: r.repetitions, last_quality: r.last_quality, next_review_at: r.next_review_at }; }
  topicDict(r) { return { ...this.recordDict(r), title: M.splitTopic(r.topic)[1] }; }
  scoped(track) { return Object.values(this.records).filter((r) => M.inScope(r.topic, track)); }

  async fetch(url, init = {}) {
    const u = new URL(url, "http://device.invalid");
    const method = (init.method || "GET").toUpperCase();
    const path = u.pathname;
    const q = u.searchParams;
    let body = {};
    if (init.body && typeof init.body === "string") { try { body = JSON.parse(init.body); } catch (_) { body = {}; } }
    try {
      if (method === "GET") {
        if (path === "/auth/status") return json(200, { auth_enabled: true, setup_needed: false, signup_open: false, email_enabled: false, recovery_enabled: false, recovery_codes_enabled: false, recovery: null, user: { username: this.identity.username, role: "learner" } });
        if (path === "/mode") return json(200, this.modeInfo() || { mode: "online", ai: { provider: "device", services: [], configured: this.hasModel, ready: this.hasModel ? 1 : 0, resting: false }, embeddings: "keyword", limits: false, privacy: { third_party_ai: false, services: [], notice: null }, offline_guide: "" });
        if (path === "/health") return json(200, { status: "ok", model_state: this.hasModel ? "ready" : "no model" });
        if (path === "/tutor/sources") return json(200, { enabled: false, per_user: 0, documents: {}, sources: this.state.sources });
        if (path === "/tutor/me/limits") return json(200, { mode: "offline", ai: { limited: false, per_user_day: 0, used: 0, left: null, resting: false, resets_in_s: 0 }, sources: { limit: 0, used: this.state.sources.length, max_upload_mb: 0 } });
        if (path === "/tutor/me/summary") return json(200, { ...M.summaryFor(this.records, this.attempts, this.trackOf(q.get("source")), this.now()), plan: null });
        if (path === "/tutor/me/ladder") return json(200, this.ladder(q.get("source")));
        if (path === "/tutor/review/due") return json(200, this.reviewDue(q.get("source"), Number(q.get("limit") || 10)));
        if (path === "/tutor/next") return json(200, this.next(q.get("source")));
        if (path === "/tutor/practice/suggest") return json(200, this.suggest(q.get("source"), Number(q.get("limit") || 5)));
        if (path === "/tutor/me/map") return needsConnection("The knowledge map");
        if (path.startsWith("/tutor/progress/")) return needsConnection("The study plan");
        if (path.startsWith("/tutor/sources/")) return needsConnection("Your source's details");
      } else if (method === "POST") {
        if (path === "/tutor/chat") return await this.chat(body, false, init.signal);
        if (path === "/tutor/chat/stream") return await this.chat(body, true, init.signal);
        if (path === "/tutor/practice/generate") return this.generate(body);
        if (path === "/tutor/practice/grade") return await this.grade(body, "practice");
        if (path === "/tutor/review/submit") return await this.grade(body, "review");
        if (path === "/tutor/practice/hint") return await this.hint(body);
        if (path === "/tutor/practice/tryit-check") return json(200, { runnable: false, reason: "Running code needs a connection." });
      }
    } catch (error) {
      return json(500, { detail: String((error && error.message) || error) });
    }
    return needsConnection("That");
  }

  // --- the learner's measures ---
  ladder(source) {
    const scope = this.state.scopes.find((s) => s.id === this.scopeOf(source)) || { order: [] };
    const summary = M.summaryFor(this.records, this.attempts, scope.track || null, this.now());
    return M.buildLadder(scope.order.map((o) => [o.key, o.title]), summary.topics);
  }
  reviewDue(source, limit) {
    const track = this.trackOf(source);
    const due = M.dueRecords(Object.fromEntries(this.scoped(track).map((r) => [r.topic, r])), this.now(), 500).slice(0, limit);
    const out = { user_id: this.state.user, due: due.map((r) => this.topicDict(r)) };
    if (!due.length) {
      const all = this.scoped(track);
      out.next_upcoming = all.length ? this.topicDict(all.reduce((m, r) => (r.next_review_at < m.next_review_at ? r : m))) : null;
    }
    return out;
  }
  next(source) {
    const due = this.reviewDue(source, 1).due[0];
    if (due) return { type: "review", topic: due.topic, title: due.title, reason: "spaced-repetition due (SM-2)", source: source || null };
    return { type: "done", reason: "Nothing to review. Practice any topic; your study plan returns when you are online." };
  }
  suggest(source, limit) {
    const track = this.trackOf(source);
    const weak = [...this.scoped(track)].sort((a, b) => a.ease_factor - b.ease_factor).slice(0, limit).map((r) => this.topicDict(r));
    const ladder = this.ladder(source);
    const path = ladder.rungs.filter((r) => r.stage === ladder.current && !r.climbed).slice(0, limit);
    return { user_id: this.state.user, suggestions: weak, path, stage: ladder.stages.length ? (ladder.stages[ladder.current] || {}).name : null };
  }

  // --- practice and review ---
  generate(body) {
    const scope = this.scopeOf(body.source);
    const want = String(body.topic || "").trim().toLowerCase();
    if (body.template && !["definition_recall", "fill_in_blank"].includes(body.template)) return needsConnection("That kind of question");
    const pool = [...this.questions.values()].filter((q) => !body.template || q.template === body.template);
    let candidates = pool.filter((q) => q.topic.toLowerCase() === want || (q.scope === scope && q.title.toLowerCase() === want));
    if (!candidates.length) {
      const wanted = new Set(want.split(/\W+/).filter((w) => w.length > 2));
      const scored = pool.filter((q) => q.scope === scope).map((q) => ({ q, hit: [...wanted].filter((w) => `${q.title} ${q.prompt}`.toLowerCase().includes(w)).length })).filter((x) => x.hit > 0);
      const best = Math.max(0, ...scored.map((x) => x.hit));
      candidates = scored.filter((x) => x.hit === best).map((x) => x.q);
    }
    if (!candidates.length) return json(404, { detail: `no content found for topic '${body.topic}'` });
    const last = this.served.get(candidates[0].topic);
    const fresh = candidates.filter((q) => q.id !== last);
    const pick = (fresh.length ? fresh : candidates)[Math.floor(this.random() * (fresh.length ? fresh : candidates).length)];
    this.served.set(pick.topic, pick.id);
    const { answer_key, scope: _scope, ...shown } = pick;
    return json(200, { ...shown, run_context: null });
  }

  async grade(body, kind) {
    const q = this.questions.get(body.question_id);
    if (!q) return json(404, { detail: "unknown question_id (this question is not in your offline pack)" });
    const hints = Math.max(0, Math.min(3, Number(body.hints_used || 0)));
    const confidence = [1, 2, 3].includes(body.confidence) ? body.confidence : null;
    const result = P.gradeHeuristic(q, String(body.submitted || ""));
    const score = Math.min(result.score, P.HINT_CREDIT[hints]);
    const event = await this.outbox.add({ kind, topic: q.topic, score, confidence, hints_used: hints, at: this.now() });
    const record = M.recordAttempt(this.records, this.attempts, event);
    let reflection = null;
    if (confidence === 3 && !result.passed) reflection = "You were sure, and it was off. These are the most useful mistakes: they show where it only feels familiar.";
    else if (confidence === 1 && result.passed) reflection = "You knew more than you thought.";
    return json(200, {
      score: r3(score), passed: result.passed, feedback: result.feedback, backend: result.backend, hints_used: hints,
      credit_cap: P.HINT_CREDIT[hints] < 1 ? P.HINT_CREDIT[hints] : null, confidence, reflection, topic: q.topic, mastery: this.recordDict(record),
    });
  }

  async hint(body) {
    const q = this.questions.get(body.question_id);
    if (!q) return json(404, { detail: "unknown question_id (this question is not in your offline pack)" });
    const hint = P.makeHint(q, body.level);
    if (hint.reveals && !this.revealed.has(q.id)) {      // seeing the answer counts as a miss, once
      this.revealed.add(q.id);
      const event = await this.outbox.add({ kind: "practice", topic: q.topic, score: 0.0, at: this.now() });
      M.recordAttempt(this.records, this.attempts, event);
      hint.recorded = true;
    }
    return json(200, hint);
  }

  // --- asking ---
  extractive(top, full, direct) {
    const prefix = `From ${top.source_path} (${top.heading}):\n\n`;
    if (direct) return `${prefix}${truncateExcerpt(full, 400)}`;
    const suffix = "\n\nSocratic question: what part of this trips you up, or can you try explaining it back in your own words first?";
    return `${prefix}${truncateExcerpt(full, Math.max(0, OUTPUT_GUARD_MAX_CHARS - prefix.length - suffix.length - ANSWER_SAFETY_MARGIN))}${suffix}`;
  }

  async *ask(query, source, signal) {
    const direct = wantsDirectAnswer(query), mode = direct ? "direct" : "socratic";
    const done = (answer, sources, extra = {}) => ({ type: "done", answer, sources, mode, input_tokens: 0, output_tokens: 0, fallback: false, cached: false, ...extra });
    const chunks = this.index.search(query, { scope: this.scopeOf(source), limit: 5 });
    if (!chunks.length) { yield done(NOT_FOUND, []); return; }
    const top = chunks[0];
    const full = this.index.section(top.source_path, top.heading) || top.content;
    if (!this.hasModel) { yield done(this.extractive(top, full, direct), [top.source_path]); return; }
    const used = chunks.length > 1 && chunks[1].distance - chunks[0].distance <= 0.08 ? chunks.slice(0, 2) : chunks.slice(0, 1);
    const sources = [...new Set(used.map((c) => c.source_path))];
    yield { type: "context", excerpt: `From ${top.source_path} (${top.heading}):\n\n${truncateExcerpt(full, 700)}`, sources, mode };
    const name = direct ? "tutor.respond.direct" : "tutor.respond.socratic";
    const docs = used.map((c, i) => `[${c.source_path}] ${c.heading}\n${focusExcerpt(c.content, query, [500, 250][i])}`).join("\n\n");
    let text = "";
    try {
      for await (const piece of this.model.stream(PROMPTS[name], `Question: ${query}\n\nCurriculum excerpts:\n${docs}`, { maxTokens: MAX_TOKENS[name], signal })) {
        if (signal && signal.aborted) return;
        text += piece;
        yield { type: "delta", text: piece };
      }
    } catch (error) {
      if (signal && signal.aborted) return;
      if (!text.trim()) { yield done(`(The on-device AI didn't answer, so here is the passage.)\n\n${this.extractive(top, full, direct)}`, [top.source_path], { fallback: true }); return; }
      text += " …";
    }
    if (!text.trim()) { yield done(`(The on-device AI didn't answer, so here is the passage.)\n\n${this.extractive(top, full, direct)}`, [top.source_path], { fallback: true }); return; }
    yield done(stripCitations(text).trim(), sources);
  }

  async chat(body, stream, signal) {
    const query = String(body.query || "").trim();
    if (!query) return json(422, { detail: "query: a question is needed" });
    if (!stream) {
      let last = null;
      for await (const ev of this.ask(query, body.source, signal)) if (ev.type === "done") last = ev;
      return json(200, { answer: last.answer, mode: last.mode, sources: last.sources, input_tokens: 0, output_tokens: 0 });
    }
    const encoder = new TextEncoder();
    const events = this.ask(query, body.source, signal);
    return new Response(new ReadableStream({
      async start(controller) {
        const stop = () => { try { controller.error(new DOMException("The operation was aborted.", "AbortError")); } catch (_) {} };
        if (signal) { if (signal.aborted) return stop(); signal.addEventListener("abort", stop, { once: true }); }
        try {
          for await (const ev of events) controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
        } catch (error) {
          controller.enqueue(encoder.encode(JSON.stringify({ type: "error", detail: String((error && error.message) || error) }) + "\n"));
        }
        try { controller.close(); } catch (_) {}
      },
    }), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }
}
