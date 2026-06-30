// The public directory — used by `find` and to resolve a bare slug to an
// installable owner/repo. We read the site's bundled loops.json (richest: core
// + imported with source attribution) and fall back to the spec index.json.
import { fetchJson } from "./util.mjs";
import { SITE_REGISTRY_URL, SPEC_REGISTRY_URL } from "./config.mjs";

export async function loadRegistry() {
  for (const url of [SITE_REGISTRY_URL, SPEC_REGISTRY_URL]) {
    const r = await fetchJson(url);
    if (r.ok && r.json) {
      const loops = Array.isArray(r.json) ? r.json : r.json.loops || [];
      if (loops.length) return { loops, url };
    }
  }
  return { loops: [], url: null };
}

const hay = (l) =>
  [l.slug, l.jobTitle, l.tagline, l.description, ...(l.tags || [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

export function search(loops, query) {
  if (!query) return loops;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return loops
    .map((l) => {
      const h = hay(l);
      const score = terms.reduce((s, t) => s + (h.includes(t) ? 1 : 0), 0);
      return { l, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.l);
}

// Resolve a registry slug to an installable owner/repo[/path], when the entry
// records its source. Core 5dive loops live under the canonical loops repo.
export function resolveSlug(loops, slug) {
  const l = loops.find((x) => x.slug === slug);
  if (!l) return null;
  if (l.source && l.source.repo) return l.source.repo; // "owner/repo" or "owner/repo/path"
  if (l.repo) return l.repo;
  if (l.imported) return null; // imported but no resolvable source
  return `5dive-ai/loops/${slug}`; // core loop convention
}
