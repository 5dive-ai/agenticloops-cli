// Skill resolution + install (§3.1). Three tiers, in order:
//   1. host-satisfied  — harness already provides it -> use as-is, fetch nothing
//   2. path-resolved    — owner/repo/skill -> fetch from that public repo
//   3. registry-resolved — a bare name -> the skills.sh index's canonical entry
// An unresolvable skill is skipped with a warning, never a hard failure (§3.1).
import { spawnSync } from "node:child_process";
import { fetchJson } from "./util.mjs";
import { SKILLS_REGISTRY_URL } from "./config.mjs";

// Normalise one `skills:` entry into { id, owner, repo } or { id, bare:true }.
export function parseSkillEntry(entry) {
  if (entry && typeof entry === "object") {
    // { id, source: "owner/repo" }
    const src = entry.source ? String(entry.source).split("/") : [];
    return { id: entry.id, owner: src[0], repo: src[1] };
  }
  const parts = String(entry).split("/");
  if (parts.length >= 3) return { id: parts[2], owner: parts[0], repo: parts[1] };
  if (parts.length === 2) return { id: parts[1], owner: parts[0], repo: parts[1] };
  return { id: parts[0], bare: true };
}

// Does <owner/repo> actually contain a skill named <id>? A skills.sh skill is a
// top-level directory with a SKILL.md. Returns "yes" | "no" | "unknown" — we
// only downgrade to unresolved on a definite "no" (404), so a network blip
// never turns into a false negative.
async function existsInRepo(owner, repo, id, timeout = 8000) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${id}/SKILL.md`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    let r = await fetch(url, { method: "HEAD", signal: ctrl.signal });
    if (r.status !== 200 && r.status !== 404) r = await fetch(url, { signal: ctrl.signal });
    if (r.status === 200) return "yes";
    if (r.status === 404) return "no";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(t);
  }
}

async function resolveBare(id) {
  const r = await fetchJson(SKILLS_REGISTRY_URL);
  if (!r.ok || !r.json) return null;
  // The skills.sh index is a name -> owner/repo map (shape-tolerant lookup).
  const idx = r.json;
  const hit =
    idx[id] ||
    (Array.isArray(idx.skills) && idx.skills.find((s) => s.name === id || s.id === id)) ||
    (Array.isArray(idx) && idx.find((s) => s.name === id || s.id === id));
  if (!hit) return null;
  const src = (hit.source || hit.repo || hit || "").toString().split("/");
  if (src.length >= 2) return { id, owner: src[0], repo: src[1] };
  return null;
}

// Build an install plan without side effects. `hostSkills` = names the harness
// already provides (skipped). Returns [{ id, action, owner?, repo? }].
export async function planSkills(skills = [], hostSkills = []) {
  const host = new Set(hostSkills);
  const plan = [];
  for (const raw of skills) {
    const s = parseSkillEntry(raw);
    if (host.has(s.id)) {
      plan.push({ id: s.id, action: "host" });
      continue;
    }
    if (s.owner && s.repo) {
      plan.push(await verifiedEntry(s.id, s.owner, s.repo));
      continue;
    }
    const resolved = await resolveBare(s.id);
    if (resolved) plan.push(await verifiedEntry(resolved.id, resolved.owner, resolved.repo));
    else
      plan.push({
        id: s.id,
        action: "unresolved",
        reason: "no source given and not in the skills registry (may be a harness built-in)",
      });
  }
  return plan;
}

// Confirm the skill is actually fetchable before promising to install it — this
// is what keeps --dry-run honest (it predicts the real outcome instead of
// claiming a resolve that the real install would skip).
async function verifiedEntry(id, owner, repo) {
  const present = await existsInRepo(owner, repo, id);
  if (present === "no")
    return {
      id,
      action: "unresolved",
      owner,
      repo,
      reason: `not found in ${owner}/${repo} (may be a harness built-in)`,
    };
  return { id, action: "fetch", owner, repo };
}

// Execute one fetch via the skills.sh CLI: `npx skills add <owner/repo> --skill <id>`.
export function installSkill({ owner, repo, id }, { dryRun = false } = {}) {
  const args = ["--yes", "skills", "add", `${owner}/${repo}`, "--skill", id];
  if (dryRun) return { ok: true, cmd: `npx ${args.join(" ")}`, skipped: "dry-run" };
  const res = spawnSync("npx", args, { stdio: "inherit" });
  return { ok: res.status === 0, cmd: `npx ${args.join(" ")}`, status: res.status };
}
