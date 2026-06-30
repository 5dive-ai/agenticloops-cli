import { test } from "node:test";
import assert from "node:assert/strict";
import { core, isoWeek, recentWeeks } from "../server/api/install.js";

// In-memory stand-in for the Upstash hash store.
function memKv() {
  const h = new Map();
  return {
    _h: h,
    async hincrby(key, field, by = 1) {
      const m = h.get(key) || {};
      m[field] = (m[field] || 0) + by;
      h.set(key, m);
      return m[field];
    },
    async hgetall(key) {
      return { ...(h.get(key) || {}) };
    },
  };
}

test("POST increments global + weekly, GET returns both", async () => {
  const kv = memKv();
  const now = new Date("2026-06-30T12:00:00Z");
  let r = await core({ method: "POST", body: { slug: "ci-analyst" } }, kv, now);
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 1);
  await core({ method: "POST", body: { slug: "ci-analyst" } }, kv, now);
  await core({ method: "POST", body: { slug: "content-marketer" } }, kv, now);

  const get = await core({ method: "GET", query: { weeks: 8 } }, kv, now);
  assert.equal(get.json.installs["ci-analyst"], 2);
  assert.equal(get.json.installs["content-marketer"], 1);
  assert.equal(get.json.weeks.length, 8);
  const thisWeek = isoWeek(now);
  assert.equal(get.json.weekly[thisWeek]["ci-analyst"], 2);
});

test("rejects invalid slugs (no PII smuggling via slug)", async () => {
  const kv = memKv();
  for (const bad of ["", "Has Space", "UPPER", "../etc", "a".repeat(100), 42]) {
    const r = await core({ method: "POST", body: { slug: bad } }, kv);
    assert.equal(r.status, 400, `should reject ${JSON.stringify(bad)}`);
  }
});

test("method guard", async () => {
  const r = await core({ method: "DELETE", body: {} }, memKv());
  assert.equal(r.status, 405);
});

test("isoWeek + recentWeeks shape", () => {
  assert.match(isoWeek(new Date("2026-06-30T00:00:00Z")), /^2026-W\d{2}$/);
  const w = recentWeeks(8, new Date("2026-06-30T00:00:00Z"));
  assert.equal(w.length, 8);
  assert.equal(w[7], isoWeek(new Date("2026-06-30T00:00:00Z"))); // last = current
  assert.notEqual(w[0], w[7]);
});
