// Central constants. The telemetry + registry endpoints live on agenticloops.dev.
export const SITE = "https://agenticloops.dev";

// Anonymous install counter (POST {slug, ts}) + tallies (GET). See src/telemetry.mjs.
export const TELEMETRY_URL = process.env.AGENTICLOOPS_TELEMETRY_URL || `${SITE}/api/install`;

// The bundled directory the site builds from + the canonical spec registry.
export const SITE_REGISTRY_URL = `${SITE}/loops.json`;
export const SPEC_REGISTRY_URL =
  "https://raw.githubusercontent.com/5dive-ai/loops/main/index.json";

// skills.sh-style index used to resolve BARE skill names (§3.1 tier 3).
export const SKILLS_REGISTRY_URL = "https://skills.sh/index.json";

export const SPEC_VERSION = "0.1";

// User-Agent so server logs can attribute pings to the CLI (still anonymous).
export const UA = `agenticloops-cli/0.1.1 (+${SITE})`;
