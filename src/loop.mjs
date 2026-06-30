// Fetch, parse, and validate a LOOP.md against the spec (v0.1).
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";
import { fetchText, CliError } from "./util.mjs";

const BRANCHES = ["main", "master", "HEAD"];

// A ref points at the local filesystem if it's a path to a LOOP.md or a dir
// containing one. Lets you install/validate a loop you're authoring locally.
function localLoopPath(ref) {
  if (!(ref.startsWith(".") || isAbsolute(ref) || ref.endsWith("LOOP.md"))) return null;
  const p = isAbsolute(ref) ? ref : join(process.cwd(), ref);
  if (!existsSync(p)) return null;
  const file = statSync(p).isDirectory() ? join(p, "LOOP.md") : p;
  return existsSync(file) ? file : null;
}

// A loop ref is a GitHub shorthand:
//   owner/repo                -> LOOP.md at repo root
//   owner/repo/sub/dir        -> LOOP.md inside that subdirectory
// (A bare registry slug is resolved upstream in install.mjs before we get here.)
export function parseRef(ref) {
  const parts = String(ref).trim().replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) {
    throw new CliError(
      `"${ref}" is not a valid loop reference — expected owner/repo or owner/repo/path`,
      2,
    );
  }
  const [owner, repo, ...rest] = parts;
  const subpath = rest.join("/");
  return { owner, repo, subpath, slug: rest.length ? rest[rest.length - 1] : repo };
}

function rawUrl(owner, repo, branch, subpath) {
  const dir = subpath ? `${subpath}/` : "";
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${dir}LOOP.md`;
}

// Try each branch in turn; return the first LOOP.md found.
export async function fetchLoopMd(ref) {
  const local = localLoopPath(ref);
  if (local) {
    const slug = ref.replace(/\/?LOOP\.md$/, "").split("/").filter(Boolean).pop() || "local-loop";
    return { raw: readFileSync(local, "utf8"), url: local, owner: null, repo: null, subpath: null, slug, branch: null, local: true };
  }
  const { owner, repo, subpath, slug } = parseRef(ref);
  for (const branch of BRANCHES) {
    const url = rawUrl(owner, repo, branch, subpath);
    const r = await fetchText(url);
    if (r.ok) return { raw: r.text, url, owner, repo, subpath, slug, branch };
  }
  throw new CliError(
    `No LOOP.md found for ${owner}/${repo}${subpath ? "/" + subpath : ""} ` +
      `(tried ${BRANCHES.join(", ")}). Is the repo public and does it contain a LOOP.md?`,
    4,
  );
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

// Split a LOOP.md into { manifest, prompt }. Manifest is YAML frontmatter; the
// body is the starter prompt (markdown).
export function parseLoopMd(raw) {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    throw new CliError("LOOP.md has no YAML frontmatter (expected a leading --- block)", 3);
  }
  let manifest;
  try {
    manifest = parseYaml(m[1]) || {};
  } catch (e) {
    throw new CliError(`LOOP.md frontmatter is not valid YAML: ${e.message}`, 3);
  }
  return { manifest, prompt: (m[2] || "").trim() };
}

// Validate the manifest against the required-field rules in §2. Returns a list
// of human-readable error strings (empty = valid). Unknown fields are ignored
// per §5 (forward-compatible).
export function validateManifest(manifest) {
  const errs = [];
  const m = manifest || {};
  if (!m.name || typeof m.name !== "string") errs.push("missing required `name`");
  else if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(m.name))
    errs.push("`name` must be kebab-case, ≤ 64 chars");
  if (!m.description || typeof m.description !== "string")
    errs.push("missing required `description`");
  if (!m.schedule && !m.event)
    errs.push("missing a trigger — set `schedule` (or `event`)");

  if (m.tier && !["frontier", "standard", "fast"].includes(m.tier))
    errs.push("`tier` must be one of frontier | standard | fast (never a vendor model)");
  if (m.effort && !["low", "medium", "high"].includes(m.effort))
    errs.push("`effort` must be low | medium | high");
  if (m.concurrency && !["skip", "queue", "replace", "allow"].includes(m.concurrency))
    errs.push("`concurrency` must be skip | queue | replace | allow");
  if (m.skills && !Array.isArray(m.skills)) errs.push("`skills` must be a list");
  if (m.requires && typeof m.requires !== "object") errs.push("`requires` must be a mapping");

  return errs;
}

// A trigger that a harness must be able to honor. `schedule` accepts human
// grammar or raw cron; we don't expand it here — adapters do — but we surface a
// label and whether scheduling (vs event) is needed.
export function triggerOf(manifest) {
  if (manifest.event) {
    return { kind: "event", value: String(manifest.event), needsScheduler: false };
  }
  return { kind: "schedule", value: String(manifest.schedule), needsScheduler: true };
}
