// Small shared helpers — TTY-aware colour, prompts, fetch-with-timeout.
import { createInterface } from "node:readline";

const useColor =
  process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";

const wrap = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
};

export const sym = {
  ok: c.green("✓"),
  warn: c.yellow("⚠"),
  err: c.red("✗"),
  info: c.cyan("›"),
  bullet: c.dim("•"),
};

export function info(msg) {
  process.stderr.write(`${sym.info} ${msg}\n`);
}
export function ok(msg) {
  process.stderr.write(`${sym.ok} ${msg}\n`);
}
export function warn(msg) {
  process.stderr.write(`${sym.warn} ${c.yellow(msg)}\n`);
}
export function fail(msg) {
  process.stderr.write(`${sym.err} ${c.red(msg)}\n`);
}
export function step(msg) {
  process.stderr.write(`\n${c.bold(msg)}\n`);
}

export class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

// Yes/no prompt. Non-interactive (no TTY) returns `fallback` so CI doesn't hang.
export async function confirm(question, { fallback = false, assumeYes = false } = {}) {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const ans = (await new Promise((res) => rl.question(`${question} ${c.dim("[y/N]")} `, res)))
      .trim()
      .toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

// Free-text prompt (used for missing secrets). Returns "" non-interactively.
export async function ask(question) {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await new Promise((res) => rl.question(`${question} `, res))).trim();
  } finally {
    rl.close();
  }
}

export async function fetchText(url, { timeout = 15000 } = {}) {
  const { UA } = await import("./config.mjs");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": UA } });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, status: r.status, text: await r.text() };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson(url, opts) {
  const r = await fetchText(url, opts);
  if (!r.ok) return r;
  try {
    return { ok: true, status: r.status, json: JSON.parse(r.text) };
  } catch (e) {
    return { ok: false, status: r.status, error: `bad JSON: ${e.message}` };
  }
}
