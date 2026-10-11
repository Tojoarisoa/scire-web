// SCIRE offline: finding passages on the device, as the server's keyword search does:
// passages that contain the question's words, ranked by how much of the question they cover, each word weighted by how rare
// it is, a word in the heading counting double. No embedding model runs on the device, so this is its search.
import { tokenize } from "./text.js";

const CHUNK_OVERLAP_CHARS = 100;

export function mergeOverlap(a, b, maxOverlap) {
  for (let n = Math.min(maxOverlap, a.length, b.length); n > 0; n--) if (a.endsWith(b.slice(0, n))) return a + b.slice(n);
  return a + b;
}

export class PassageIndex {
  // passages: [{scope, source_path, heading, chunk_index, content}] in the pack's order
  constructor(passages) {
    this.rows = passages.map((p) => ({ ...p, body: new Set(tokenize(p.content)), head: new Set(tokenize(p.heading)) }));
    for (const r of this.rows) r.all = new Set([...tokenize(`${r.heading} ${r.content}`)]);
    const n = this.rows.length;
    const df = new Map();
    for (const r of this.rows) for (const t of r.all) df.set(t, (df.get(t) || 0) + 1);
    this.weights = new Map([...df].map(([t, c]) => [t, Math.log((n + 1) / (c + 1)) + 1.0]));
    this.unseen = Math.log(n + 1) + 1.0;
  }

  weight(token) { return this.weights.has(token) ? this.weights.get(token) : this.unseen; }

  // Sorted best first; each result carries `distance` (0 = every word covered), like the server's.
  search(query, { scope = null, limit = 5 } = {}) {
    const tokens = [...new Set(tokenize(query))].sort().slice(0, 8);
    if (!tokens.length) return [];
    const total = tokens.reduce((s, t) => s + this.weight(t), 0) || 1.0;
    const out = [];
    for (const r of this.rows) {
      if (scope !== null && r.scope !== scope) continue;
      if (!tokens.some((t) => r.all.has(t))) continue;
      const covered = tokens.reduce((s, t) => s + (r.body.has(t) || r.head.has(t) ? this.weight(t) : 0), 0) / total;
      const headed = tokens.reduce((s, t) => s + (r.head.has(t) ? this.weight(t) : 0), 0) / total;
      out.push({ source_path: r.source_path, heading: r.heading, chunk_index: r.chunk_index, content: r.content, scope: r.scope, distance: 1.0 - Math.min(1.0, covered + headed) });
    }
    out.sort((a, b) => a.distance - b.distance);   // stable: equal distances keep the pack's order, as the server's sort does
    return out.slice(0, limit);
  }

  // A section's whole text: its windows stitched in order, the overlap between neighbours taken out once (as the server does).
  section(sourcePath, heading) {
    const parts = this.rows.filter((r) => r.source_path === sourcePath && r.heading === heading).sort((a, b) => a.chunk_index - b.chunk_index).map((r) => r.content);
    if (!parts.length) return "";
    return parts.slice(1).reduce((whole, part) => mergeOverlap(whole, part, CHUNK_OVERLAP_CHARS), parts[0]);
  }

  findByHeading(heading, scope = null) {
    const h = String(heading).trim().toLowerCase();
    return this.rows.find((r) => (scope === null || r.scope === scope) && r.heading.trim().toLowerCase() === h) || null;
  }
}
