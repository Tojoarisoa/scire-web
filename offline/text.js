// SCIRE offline: reading text on the device. The same treatment of words and excerpts, so a question finds the same passages here as on the server's keyword search.

export const STOPWORDS = new Set(
  `a an the is are was were be been being of to in on for and or but as at by from with about into through during before after
   this that these those it its what which who how why when where does do did can could will would should you your yours i me my
   we us our they them their he she his her not no yes if so than then there here have has had having also just very`.split(/\s+/).filter(Boolean),
);

// Crude suffix stripping so "windows" and "window" meet: applied alike to passages and questions, so it only has to be consistent.
export function normalizeToken(token) {
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("ies") && token.length > 5) return token.slice(0, -3) + "y";
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("es") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) return token.slice(0, -1);
  return token;
}

export function tokenize(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => !STOPWORDS.has(t)).map(normalizeToken);
}

const OVERRIDE = /\bjust tell me\b|\bgive me the answer\b|\bdon'?t ask (me )?(a )?question\b|\bskip the hints?\b|\bno hints?\b|\bstop asking\b/i;
export const wantsDirectAnswer = (query) => OVERRIDE.test(query);

// Cut at a whitespace boundary (never mid-word), mark the cut, and re-close a code fence the cut left open. The server also
// asks Python's parser for the longest valid code prefix; a device has no Python, so it keeps to the fence and the word.
export function truncateExcerpt(text, limit = 400) {
  text = String(text).trim();
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);
  let cut = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"));
  if (cut < limit * 0.6) cut = limit;
  let out = text.slice(0, cut).trimEnd();
  if ((out.match(/```/g) || []).length % 2 === 1) out += "\n```";
  return out + " …";
}

// The `limit`-character run of whole lines that mentions the question's words the most, not just the first characters.
export function focusExcerpt(content, query, limit) {
  content = String(content).trim();
  if (content.length <= limit) return content;
  const q = new Set(tokenize(query));
  const lines = content.split("\n");
  const hits = lines.map((ln) => tokenize(ln).filter((t, i, a) => q.has(t) && a.indexOf(t) === i).length);
  let bestScore = -1, bestText = content.slice(0, limit);
  for (let i = 0; i < lines.length; i++) {
    let total = 0, score = 0, j = i;
    while (j < lines.length && total + lines[j].length + 1 <= limit) { total += lines[j].length + 1; score += hits[j]; j++; }
    if (j > i && score > bestScore) { bestScore = score; bestText = lines.slice(i, j).join("\n"); }
  }
  return bestText;
}
