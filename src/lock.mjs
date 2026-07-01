// Concurrency enforcement for the run path. SPEC.md §2 defines
// `concurrency: skip | queue | replace | allow` — the overlap policy when a
// loop's schedule fires while a previous run is still going. This is where it's
// honored: `run` acquires a per-loop lock before executing the chain, and the
// policy decides what happens when the lock is already held by a live run.
//
//   skip    (default) — a run is already going; don't start another. Exit clean.
//   queue             — wait for the current run to finish, then take over.
//   replace           — signal the current run to stop, then take over.
//   allow             — no coordination; run concurrently (the old behavior).
//
// The lock is a file holding the owner pid + host. Liveness is checked so a
// crashed run never wedges the loop: a lock whose pid is dead (same host) is
// treated as free. Cross-host locks are trusted (can't probe another box).
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { recordPath } from "./schedule.mjs";

export const DEFAULT_CONCURRENCY = "skip";
const QUEUE_POLL_MS = 1000;
const QUEUE_MAX_MS = 6 * 60 * 60 * 1000; // don't wait forever — 6h ceiling
const REPLACE_GRACE_MS = 5000;

const lockPath = (key) => join(recordPath(key), "run.lock");

function readLock(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Is the lock held by a still-running process? A dead pid on this host, or an
// unparseable/empty lock, counts as free. A pid on a different host is trusted
// as live (we can't signal it) so we never stomp a run on another box.
function isLive(lock) {
  if (!lock || typeof lock.pid !== "number") return false;
  if (lock.host && lock.host !== hostname()) return true;
  try {
    process.kill(lock.pid, 0); // signal 0 = liveness probe, no-op if alive
    return lock.pid !== process.pid; // our own pid isn't a competing run
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours — alive
  }
}

function writeLock(file) {
  mkdirSync(join(file, ".."), { recursive: true });
  // Exclusive create so two racing runs can't both believe they won.
  const fd = openSync(file, "wx");
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
  } finally {
    closeSync(fd);
  }
}

// Try to take the lock, clearing a dead one first. Returns true on success,
// false if a live run currently holds it (lost the exclusive-create race).
function tryAcquire(file) {
  const cur = readLock(file);
  if (cur && !isLive(cur)) rmSync(file, { force: true }); // reap a stale lock
  try {
    writeLock(file);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Acquire the run lock per the concurrency policy. Returns a handle:
//   { acquired: true, release() }  — proceed; call release() when done.
//   { acquired: false, reason }    — skipped; do not run.
// `allow` returns an acquired handle with a no-op release (no file written).
export async function acquireRunLock(key, concurrency = DEFAULT_CONCURRENCY, { force = false, log } = {}) {
  const policy = force ? "allow" : concurrency || DEFAULT_CONCURRENCY;
  if (policy === "allow") return { acquired: true, release() {} };

  const file = lockPath(key);
  const release = () => {
    const cur = readLock(file);
    if (cur && cur.pid === process.pid) rmSync(file, { force: true });
  };

  if (tryAcquire(file)) return { acquired: true, release };

  const held = readLock(file);
  const who = held?.pid ? `pid ${held.pid}${held.host && held.host !== hostname() ? ` on ${held.host}` : ""}` : "another run";

  if (policy === "skip") {
    return { acquired: false, reason: `a run is already in progress (${who}); concurrency=skip` };
  }

  if (policy === "replace") {
    // Can only replace a run we can signal — i.e. on this host. A live run on
    // another box is out of reach; don't delete its lock and pretend we did.
    if (held?.host && held.host !== hostname()) {
      return { acquired: false, reason: `running instance is on ${held.host}; cannot replace across hosts` };
    }
    if (held?.pid) {
      log?.(`concurrency=replace — signaling ${who} to stop`);
      try {
        process.kill(held.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      const until = Date.now() + REPLACE_GRACE_MS;
      while (isLive(readLock(file)) && Date.now() < until) await sleep(200);
    }
    rmSync(file, { force: true });
    if (tryAcquire(file)) return { acquired: true, release };
    return { acquired: false, reason: `could not replace the running instance (${who})` };
  }

  if (policy === "queue") {
    log?.(`concurrency=queue — waiting for ${who} to finish`);
    const until = Date.now() + QUEUE_MAX_MS;
    while (Date.now() < until) {
      await sleep(QUEUE_POLL_MS);
      if (tryAcquire(file)) return { acquired: true, release };
    }
    return { acquired: false, reason: `timed out waiting for the running instance to finish (${who})` };
  }

  // Unknown policy (validation should have caught it) — fail safe to skip.
  return { acquired: false, reason: `unknown concurrency policy "${policy}"; not starting a second run` };
}
