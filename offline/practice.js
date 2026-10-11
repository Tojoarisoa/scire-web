// SCIRE offline: grading and hints on the device. The same heuristics the server uses:
// token overlap, text similarity (difflib.SequenceMatcher's ratio), the pass mark and the hint ladder. Questions that need
// Python to grade (spot the bug, run it) are not in the pack, so nothing here pretends to grade them.
import { TOPIC_SEP, pyRound } from "./mastery.js";

export const PASS_THRESHOLD = 0.6;
export const HINT_CREDIT = [1.0, 0.9, 0.7, 0.4];   // the most credit left after 0, 1, 2, 3 hints

const normalize = (text) => String(text).toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();

export function tokenOverlapScore(expected, submitted) {
  const words = (t) => new Set(normalize(t).split(/\s+/).filter((w) => w.length > 2));
  const e = words(expected), s = words(submitted);
  if (!e.size) return 1.0;
  if (!s.size) return 0.0;
  let hit = 0;
  for (const w of e) if (s.has(w)) hit++;
  return hit / e.size;
}

// difflib.SequenceMatcher(None, a, b).ratio(), including its "popular character" rule for long strings (autojunk), so the
// score is the one the server computes.
export function ratio(a, b) {
  const la = a.length, lb = b.length;
  if (la + lb === 0) return 1.0;
  const b2j = new Map();
  for (let j = 0; j < lb; j++) { const c = b[j]; if (!b2j.has(c)) b2j.set(c, []); b2j.get(c).push(j); }
  if (lb >= 200) {
    const ntest = Math.floor(lb / 100) + 1;
    for (const [c, idx] of [...b2j]) if (idx.length > ntest) b2j.delete(c);
  }
  const longest = (alo, ahi, blo, bhi) => {
    let besti = alo, bestj = blo, bestsize = 0, j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const next = new Map();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        next.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = next;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  };
  let matched = 0;
  const queue = [[0, la, 0, lb]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k) {
      matched += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return (2.0 * matched) / (la + lb);
}

export const similarityScore = (expected, submitted) => ratio(normalize(expected), normalize(submitted));

// grade_heuristic for the two question kinds a device can grade.
export function gradeHeuristic(question, submitted) {
  const score = question.template === "fill_in_blank"
    ? similarityScore(question.answer_key, submitted)
    : Math.max(tokenOverlapScore(question.answer_key, submitted), similarityScore(question.answer_key, submitted));
  const passed = score >= PASS_THRESHOLD;
  const feedback = passed ? (score > 0.85 ? "Looks right." : "Close enough — mostly on target.") : `Not quite. Expected something like: ${question.answer_key}`;
  return { score, passed, feedback, backend: "heuristic" };
}

// make_hint: 1 where to look, 2 the shape of the answer, 3 the answer itself.
export function makeHint(question, level) {
  const title = question.topic.includes(TOPIC_SEP) ? question.topic.slice(question.topic.indexOf(TOPIC_SEP) + TOPIC_SEP.length) : question.topic;
  level = Math.max(1, Math.min(Math.trunc(level), 3));
  if (level === 1) return { level: 1, kind: "where", text: `Look at "${title}" in ${question.source_path}.` };
  const key = (question.answer_key || "").trim();
  if (level === 3 || !key) return { level: 3, kind: "answer", text: key || "(no model answer for this one)", reveals: true };
  const words = key.split(/\s+/);
  if (words.length <= 3) {
    const shape = words.map((w) => (w.length > 1 ? w[0] + "_".repeat(w.length - 1) : w)).join(" ");
    return { level: 2, kind: "nudge", text: `${shape}  (${key.length} characters)` };
  }
  const keep = Math.max(2, pyRound(words.length * 0.35));
  return { level: 2, kind: "nudge", text: `${words.slice(0, keep).join(" ")} ...  (${words.length - keep} more words)` };
}
