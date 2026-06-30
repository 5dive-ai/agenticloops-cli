// Pre-flight the loop's `requires` (§3.2). This is DECLARE-AND-CHECK: we verify
// the environment and prompt-or-refuse for what's missing. We NEVER auto-install
// a binary, mint a secret, or launch an MCP server — that consent is the user's.
import { execSync } from "node:child_process";

function onPath(bin) {
  try {
    execSync(`command -v ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Returns a structured report. `missing` lists what blocks a clean install.
export function preflight(requires = {}, { harness } = {}) {
  const r = requires || {};
  const cli = (r.cli || []).map((bin) => ({ bin, present: onPath(bin) }));
  const secrets = (r.secrets || []).map((name) => ({
    name,
    present: typeof process.env[name] === "string" && process.env[name] !== "",
  }));
  // MCP + network are environment expectations we can't fully verify from here:
  // we surface them for consent rather than asserting pass/fail.
  const mcp = (r.mcp || []).map((name) => ({ name }));
  const network = (r.network || []).map((host) => ({ host }));

  const missing = {
    cli: cli.filter((x) => !x.present).map((x) => x.bin),
    secrets: secrets.filter((x) => !x.present).map((x) => x.name),
  };
  const hasBlockers = missing.cli.length > 0 || missing.secrets.length > 0;

  return { cli, secrets, mcp, network, missing, hasBlockers, harness };
}
