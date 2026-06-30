// agenticloops.dev install counter — anonymous, slug-only.
//
//   POST /api/install  { slug }   -> increments the global + current-week tally
//   GET  /api/install             -> { installs: {slug:count}, weekly: {...}, weeks: [...] }
//
// We store ONLY public loop slugs and integer counts. No IP, no UA, no body
// beyond the slug is persisted — the privacy promise the CLI documents.
import { kv, kvConfigured } from "../kv.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOTAL_KEY = "installs";
const weekKey = (iso) => `installs:week:${iso}`;

// ISO-8601 week id like "2026-W26" — the bucket for the 8-week activity ranking.
export function isoWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - day); // nearest Thursday
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Last N ISO-week ids ending at `from` (inclusive), oldest first.
export function recentWeeks(n, from = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(isoWeek(new Date(from.getTime() - i * 7 * 86400000)));
  }
  return out;
}

// Pure core, KV injected for testability. Returns { status, json }.
export async function core({ method, body, query }, store = kv, now = new Date()) {
  if (method === "POST") {
    const slug = body && typeof body.slug === "string" ? body.slug.trim() : "";
    if (!SLUG_RE.test(slug)) return { status: 400, json: { ok: false, error: "invalid slug" } };
    const week = isoWeek(now);
    const total = await store.hincrby(TOTAL_KEY, slug, 1);
    await store.hincrby(weekKey(week), slug, 1);
    return { status: 200, json: { ok: true, slug, count: total } };
  }

  if (method === "GET") {
    const installs = await store.hgetall(TOTAL_KEY);
    const n = Math.min(Math.max(Number(query?.weeks) || 8, 1), 26);
    const weeks = recentWeeks(n, now);
    const weekly = {};
    for (const w of weeks) weekly[w] = await store.hgetall(weekKey(w));
    return { status: 200, json: { ok: true, installs, weekly, weeks } };
  }

  return { status: 405, json: { ok: false, error: "method not allowed" } };
}

export default async function handler(req, res) {
  // GET is read-only public data; allow cross-origin reads (the CLI `find` uses it).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!kvConfigured()) {
    return res.status(503).json({ ok: false, error: "counter store not configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  try {
    const { status, json } = await core({ method: req.method, body, query: req.query });
    // Tallies are cache-friendly for the UI; counts can be a little stale.
    if (req.method === "GET") res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.status(status).json(json);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
