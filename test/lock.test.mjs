import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { acquireRunLock, DEFAULT_CONCURRENCY } from "../src/lock.mjs";
import { recordPath, removeRecord } from "../src/schedule.mjs";

const KEY = "test-lock-loop";
const lockFile = () => join(recordPath(KEY), "run.lock");

function seedForeignLock({ pid = 999999, host = "some-other-host" } = {}) {
  mkdirSync(recordPath(KEY), { recursive: true });
  writeFileSync(lockFile(), JSON.stringify({ pid, host, startedAt: "2026-01-01T00:00:00Z" }));
}

test.afterEach(() => removeRecord(KEY));

test("default policy is skip", () => {
  assert.equal(DEFAULT_CONCURRENCY, "skip");
});

test("allow never writes a lock and always acquires", async () => {
  const h = await acquireRunLock(KEY, "allow");
  assert.equal(h.acquired, true);
  assert.equal(existsSync(lockFile()), false);
  h.release();
});

test("skip acquires when free, then release removes the lock", async () => {
  const h = await acquireRunLock(KEY, "skip");
  assert.equal(h.acquired, true);
  assert.equal(existsSync(lockFile()), true);
  const held = JSON.parse(readFileSync(lockFile(), "utf8"));
  assert.equal(held.pid, process.pid);
  h.release();
  assert.equal(existsSync(lockFile()), false);
});

test("skip refuses when a live run holds the lock", async () => {
  seedForeignLock(); // foreign host = trusted-live, can't be reaped
  const h = await acquireRunLock(KEY, "skip");
  assert.equal(h.acquired, false);
  assert.match(h.reason, /already in progress/);
});

test("a stale (dead-pid) lock on this host is reaped", async () => {
  // A dead local pid must not wedge the loop forever.
  mkdirSync(recordPath(KEY), { recursive: true });
  writeFileSync(lockFile(), JSON.stringify({ pid: 2147483000, host: (await import("node:os")).hostname() }));
  const h = await acquireRunLock(KEY, "skip");
  assert.equal(h.acquired, true);
  h.release();
});

test("replace won't stomp a live run it can't signal (cross-host)", async () => {
  seedForeignLock({ host: "some-other-host" });
  const h = await acquireRunLock(KEY, "replace");
  assert.equal(h.acquired, false);
  assert.match(h.reason, /cannot replace across hosts/);
});

test("force bypasses the lock even when held", async () => {
  seedForeignLock();
  const h = await acquireRunLock(KEY, "skip", { force: true });
  assert.equal(h.acquired, true); // force => allow, no coordination
  h.release();
});
