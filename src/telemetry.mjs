// Anonymous install telemetry. On a SUCCESSFUL install the CLI fires a single
// fire-and-forget ping: { slug, ts } and nothing else. No PII, no IP logging
// intent, no machine id. Opt out with --no-telemetry, AGENTICLOOPS_NO_TELEMETRY=1,
// or the cross-tool DO_NOT_TRACK=1 standard. Failure is silent — telemetry must
// never block or break an install.
import { TELEMETRY_URL, UA } from "./config.mjs";

export function telemetryDisabled({ flag = false } = {}) {
  return (
    flag ||
    process.env.AGENTICLOOPS_NO_TELEMETRY === "1" ||
    process.env.DO_NOT_TRACK === "1"
  );
}

export async function pingInstall(slug, { disabled = false, timeout = 4000 } = {}) {
  if (disabled || telemetryDisabled()) return { sent: false, reason: "opted-out" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(TELEMETRY_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", "user-agent": UA },
      // ts is the client's send time; the server stamps its own authoritative
      // time. slug is the only identifying field, and it's a public loop id.
      body: JSON.stringify({ slug, ts: new Date().toISOString() }),
    });
    return { sent: r.ok, status: r.status };
  } catch (e) {
    return { sent: false, reason: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(t);
  }
}

// GET the per-slug tallies (used by `list` to annotate, and by the site UI).
export async function fetchInstalls({ timeout = 6000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(TELEMETRY_URL, { signal: ctrl.signal, headers: { "user-agent": UA } });
    if (!r.ok) return {};
    const j = await r.json();
    return j.installs || j.counts || j || {};
  } catch {
    return {};
  } finally {
    clearTimeout(t);
  }
}
