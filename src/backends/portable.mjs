// Portable backend — the harness-agnostic reference path (a JS port of the
// reference run-loop.py). Runs each role as ONE headless invocation of the
// harness's own model command (`claude -p`, `codex exec`, …) and threads the
// structured output forward. Nothing host-specific beyond `headlessCmd`; the
// loop file is identical across harnesses. Used for every non-5dive harness.
import { spawn } from "node:child_process";

function runOnce(cmd, prompt, { timeout = 180000 } = {}) {
  return new Promise((resolve) => {
    const [bin, ...args] = cmd;
    const child = spawn(bin, [...args, prompt], { stdio: ["ignore", "pipe", "pipe"] });
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
  return {
    label: `portable (${headlessCmd.join(" ")})`,
    async runRole({ prompt }) {
      const r = await runOnce(headlessCmd, prompt, opts);
      return {
        status: r.ok ? "done" : "error",
        output: r.output,
        ref: headlessCmd[0],
        error: r.error,
      };
    },
  };
}
