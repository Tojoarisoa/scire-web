// SCIRE offline: the learning schedule and what the learner can check, on the device. SM-2, the level and mastery of a topic, the
// measures of the Progress view and the ladder: the same rules in the same order as the server's, so what a learner sees offline
// is what the server would show for the same answers.

export const TOPIC_SEP = "::";
export const MASTERED_INTERVAL_DAYS = 21;
export const REVIEWING_INTERVAL_DAYS = 3;
export const PASS_QUALITY = 3;
const DAY_MS = 86400000;

// Python's round() takes a half to the even neighbour (round(2.5) == 2); Math.round does not. Scores and schedules use it.
export function pyRound(x) {
  const f = Math.floor(x), diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

export const scoreToQuality = (score) => Math.max(0, Math.min(5, pyRound(score * 5)));

export function sm2Update(state, quality) {
  if (quality < 3) return { ease_factor: state.ease_factor, interval_days: 1, repetitions: 0 };
  const interval = state.repetitions === 0 ? 1 : state.repetitions === 1 ? 6 : pyRound(state.interval_days * state.ease_factor);
  let ease = state.ease_factor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  ease = Math.max(1.3, ease);
  return { ease_factor: ease, interval_days: Math.max(1, interval), repetitions: state.repetitions + 1 };
}

export function splitTopic(topic) {
  const at = topic.indexOf(TOPIC_SEP);
  return at < 0 ? [null, topic] : [topic.slice(0, at), topic.slice(at + TOPIC_SEP.length)];
}
export const inScope = (topic, track) => splitTopic(topic)[0] === track;

export function topicLevel(intervalDays, repetitions) {
  if (repetitions === 0 || intervalDays < REVIEWING_INTERVAL_DAYS) return "learning";
  return intervalDays >= MASTERED_INTERVAL_DAYS ? "mastered" : "reviewing";
}
export function topicMasteryPercent(intervalDays, repetitions) {
  if (repetitions === 0) return 0;
  return Math.max(0, Math.min(100, pyRound((100 * intervalDays) / MASTERED_INTERVAL_DAYS)));
}

// One graded answer folded into a learner's records, as the server does. `records` is {topic: record}; `attempts`
// is the log, oldest first. An answer older than the last one counted is logged but leaves the schedule alone (two devices
// merge in time order). Returns the new record of that topic.
export function recordAttempt(records, attempts, { topic, score, confidence = null, at }) {
  const quality = scoreToQuality(score);
  const prior = records[topic] || { ease_factor: 2.5, interval_days: 0, repetitions: 0 };
  const lastAt = records[topic] && records[topic].last_reviewed_at ? Date.parse(records[topic].last_reviewed_at) : null;
  const when = typeof at === "number" ? at : Date.parse(at);
  const stale = lastAt !== null && lastAt > when;
  attempts.push({ topic, score, quality, confidence, at: new Date(when).toISOString() });
  attempts.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (stale) return records[topic];
  const next = sm2Update(prior, quality);
  records[topic] = {
    topic, ease_factor: next.ease_factor, interval_days: next.interval_days, repetitions: next.repetitions, last_quality: quality,
    last_reviewed_at: new Date(when).toISOString(), next_review_at: new Date(when + next.interval_days * DAY_MS).toISOString(),
  };
  return records[topic];
}

export function dueRecords(records, now = Date.now(), limit = 10) {
  return Object.values(records).filter((r) => Date.parse(r.next_review_at) <= now).sort((a, b) => (a.next_review_at < b.next_review_at ? -1 : 1)).slice(0, limit);
}

const sharePassed = (attempts) => (attempts.length ? pyRound((100 * attempts.filter((a) => a.quality >= PASS_QUALITY).length) / attempts.length) : null);

export function calibration(attempts) {
  const rated = attempts.filter((a) => a.confidence);
  const sure = rated.filter((a) => a.confidence === 3), unsure = rated.filter((a) => a.confidence === 1);
  const sureRight = sure.filter((a) => a.quality >= PASS_QUALITY).length, unsureRight = unsure.filter((a) => a.quality >= PASS_QUALITY).length;
  let verdict = null;
  if (rated.length >= 5) {
    if (sure.length >= 3 && (sure.length - sureRight) / sure.length >= 0.4) verdict = "overconfident";
    else if (unsure.length >= 3 && unsureRight / unsure.length >= 0.7) verdict = "underconfident";
    else verdict = "calibrated";
  }
  return { rated: rated.length, sure: sure.length, sure_right: sureRight, unsure: unsure.length, unsure_right: unsureRight, sure_but_wrong: sure.length - sureRight, verdict };
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// Everything the Progress view shows, from the records and the attempt log (see build_learning_summary).
export function buildLearningSummary(records, attempts, now = Date.now()) {
  attempts = [...attempts].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const at = (a) => Date.parse(a.at);
  const byTopic = new Map();
  for (const a of attempts) { if (!byTopic.has(a.topic)) byTopic.set(a.topic, []); byTopic.get(a.topic).push(a); }
  const sorted = [...records].sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));
  const topics = sorted.map((r) => {
    const tried = byTopic.get(r.topic) || [];
    const first = tried.length ? tried[0].score : null, latest = tried.length ? tried[tried.length - 1].score : null;
    return {
      topic: r.topic, level: topicLevel(r.interval_days, r.repetitions), mastery: topicMasteryPercent(r.interval_days, r.repetitions),
      attempts: tried.length, first_score: first === null ? null : pyRound(first * 100), latest_score: latest === null ? null : pyRound(latest * 100),
      gain: tried.length >= 2 ? pyRound((latest - first) * 100) : null, next_review_at: new Date(Date.parse(r.next_review_at)).toISOString(),
      due: Date.parse(r.next_review_at) <= now,
    };
  });
  const gains = topics.map((t) => t.gain).filter((g) => g !== null);
  const days = new Set(attempts.map((a) => utcDay(at(a))));
  const today = utcDay(now);
  let streak = 0, day = days.has(today) ? now : now - DAY_MS;
  while (days.has(utcDay(day))) { streak++; day -= DAY_MS; }
  const within = (startDays, endDays) => attempts.filter((a) => now - startDays * DAY_MS <= at(a) && at(a) < now - endDays * DAY_MS);
  const last7 = within(7, 0);
  const activity = [];
  for (let back = 6; back >= 0; back--) {
    const d = utcDay(now - back * DAY_MS);
    activity.push({ date: d, attempts: attempts.filter((a) => utcDay(at(a)) === d).length });
  }
  const forecast = [0, 0, 0, 0, 0, 0, 0];
  const todayMs = Date.parse(today);
  for (const r of records) {
    const dd = Math.max(0, Math.round((Date.parse(utcDay(Date.parse(r.next_review_at))) - todayMs) / DAY_MS));
    if (dd < 7) forecast[dd]++;
  }
  const upcoming = records.length ? records.reduce((m, r) => (Date.parse(r.next_review_at) < Date.parse(m.next_review_at) ? r : m)) : null;
  return {
    topics,
    totals: {
      topics: topics.length, mastered: topics.filter((t) => t.level === "mastered").length, due_now: topics.filter((t) => t.due).length,
      attempts: attempts.length, mastery_avg: topics.length ? pyRound(topics.reduce((s, t) => s + t.mastery, 0) / topics.length) : null,
    },
    learning_gain: { points: gains.length ? pyRound(gains.reduce((s, g) => s + g, 0) / gains.length) : null, topics: gains.length },
    accuracy: { last_7d: sharePassed(last7), previous_7d: sharePassed(within(14, 7)), last_30d: sharePassed(within(30, 0)) },
    streak_days: streak, calibration: calibration(attempts), attempts_7d: last7.length, activity_7d: activity, reviews_ahead: forecast,
    next_review: upcoming ? { topic: upcoming.topic, at: new Date(Date.parse(upcoming.next_review_at)).toISOString() } : null,
  };
}

// The summary: the measures for one source, topics shown without their "<track>::" prefix (`key` keeps it).
export function summaryFor(records, attempts, track, now = Date.now()) {
  const result = buildLearningSummary(Object.values(records).filter((r) => inScope(r.topic, track)), attempts.filter((a) => inScope(a.topic, track)), now);
  for (const t of result.topics) { t.key = t.topic; t.topic = splitTopic(t.topic)[1]; }
  if (result.next_review) { result.next_review.key = result.next_review.topic; result.next_review.topic = splitTopic(result.next_review.topic)[1]; }
  return result;
}

export const STAGES = ["Fundamentals", "Core", "Advanced", "Mastery"];
const READY_LEVELS = ["reviewing", "mastered"];

export function buildLadder(ordered, summaryTopics) {
  const byKey = new Map(summaryTopics.map((t) => [t.key.toLowerCase(), t]));
  const n = ordered.length, count = Math.min(STAGES.length, n);
  const names = Array.from({ length: count }, (_, j) => (count > 1 ? STAGES[pyRound((j * (STAGES.length - 1)) / (count - 1))] : STAGES[0]));
  const rungs = ordered.map(([key, title], i) => {
    const rec = byKey.get(key.toLowerCase());
    const stage = n ? Math.floor((i * count) / n) : 0;
    return { key, title, stage, stage_name: names[stage], level: rec ? rec.level : "new", mastery: rec ? rec.mastery : 0, due: !!(rec && rec.due), climbed: !!(rec && READY_LEVELS.includes(rec.level)) };
  });
  const firstOpen = rungs.find((r) => !r.climbed);
  const current = firstOpen ? firstOpen.stage : count ? count - 1 : 0;
  for (const r of rungs) r.state = r.level === "mastered" ? "mastered" : r.stage > current ? "ahead" : r.stage === current ? "current" : "done";
  const stages = [];
  for (let st = 0; st < count; st++) {
    const members = rungs.filter((r) => r.stage === st);
    stages.push({ index: st, name: members[0].stage_name, total: members.length, climbed: members.filter((r) => r.climbed).length, current: st === current });
  }
  const dueEarlier = rungs.find((r) => r.due && r.stage <= current);
  const next = dueEarlier || rungs.find((r) => r.stage === current && !r.climbed) || null;
  return { stages, rungs, current, next, climbed: rungs.filter((r) => r.climbed).length, total: n };
}
