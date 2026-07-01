// Portable backend — the harness-agnostic reference path (a JS port of the
// reference run-loop.py). Runs each role as ONE headless invocation of the
// harness's own model command (`claude -p`, `codex exec`, …) and threads the
// structured output forward. Nothing host-specific beyond `headlessCmd`; the
// loop file is identical across harnesses. Used for every non-5dive harness.
import { spawn } from "node:child_process";

// Map a normalized budget (from normalizeBudget) to the harness CLI's native
// budget flags. Today only the claude headless CLI exposes one: --max-budget-usd,
// a HARD dollar ceiling. The cost form maps to it directly. The token form's soft
// task_budget countdown has NO headless flag, so we emit nothing rather than
// fabricate a cap — that mapping belongs to the native runner (task_budget /
// server-side token accounting). Unknown harnesses (codex, …): no flags.
export function budgetCliArgs(cmd, budget) {
  if (!budget || cmd[0] !== "claude") return [];
  if (budget.kind === "cost") return ["--max-budget-usd", String(budget.cost)];
  return [];
}

function runOnce(cmd, prompt, { timeout = 180000 } = {}, budgetArgs = []) {
  return new Promise((resolve) => {
    const [bin, ...args] = cmd;
    const child = spawn(bin, [...args, ...budgetArgs, prompt], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: "", error: `${bin} not runnable: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, output: out.trim() });
      else resolve({ ok: false, output: out.trim(), error: err.trim() || `exit ${code}` });
    });
  });
}

// backend factory. headlessCmd e.g. ["claude","-p"].
export function portableBackend(headlessCmd, opts = {}) {
  if (!Array.isArray(headlessCmd) || !headlessCmd.length)
    throw new Error("portable backend needs a headlessCmd, e.g. [\"claude\",\"-p\"]");
  const budgetArgs = budgetCliArgs(headlessCmd, opts.budget);
  return {
    label: `portable (${headlessCmd.join(" ")})${budgetArgs.length ? " · " + budgetArgs.join(" ") : ""}`,
    async runRole({ prompt }) {
      const r = await runOnce(headlessCmd, prompt, opts, budgetArgs);
      return {
        status: r.ok ? "done" : "error",
        output: r.output,
        ref: headlessCmd[0],
        error: r.error,
      };
    },
  };
}
