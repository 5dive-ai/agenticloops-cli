// SPIKE (DIVE-809 multi-agent v0.1 go/no-go) — the run engine for a sequential
// multi-agent loop on the 5dive runtime. NOT shipped in the npm package.
//
// Mechanism (the de-risked path): each role is a linked 5dive TASK assigned to a
// role agent. The agent does the work and finishes with `task done --result=…`
// — a STRUCTURED handoff (the same clean mechanism prod maker→reviewer uses).
// The driver polls task status (NOT tmux/agent-ask idle-capture, which is flaky
// cold) and feeds role N's result into role N+1's prompt as context. Cold-safe:
// polling task state is deterministic and survives an unattended scheduled run.
//
// The executor is injected so the sequencing/context-passing logic is unit-
// testable offline; the live executor shells out to the real `5dive` CLI.
import { spawnSync } from "node:child_process";

// --- live executor: real 5dive task primitives ------------------------------
export const fivediveExecutor = {
  // Create a task assigned to the role agent; return its id (PREFIX-N).
  createTask({ title, body, assignee }) {
    const r = spawnSync(
      "5dive",
      ["task", "add", title, `--body=${body}`, `--assignee=${assignee}`, "--priority=high", "--json"],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`task add failed: ${r.stderr || r.stdout}`);
    const m = (r.stdout || "").match(/([A-Z]+-\d+)/);
    if (!m) throw new Error(`could not parse task id from: ${r.stdout}`);
    return m[1];
  },
  // Wake the agent: tell it the task id + that it MUST finish with task done --result.
  dispatch({ agent, taskId, role, prompt }) {
    const msg =
      `[agenticloops chain] You are the "${role}" role. Task ${taskId}.\n` +
      `\nDo this:\n${prompt}\n\n` +
      `When finished you MUST run exactly:\n  5dive task done ${taskId} --result="<your full output, self-contained>"\n` +
      `Your result is the ONLY thing passed to the next role — make it complete.`;
    spawnSync("5dive", ["agent", "send", agent, msg, "--raw"], { encoding: "utf8" });
  },
  // Poll task status; return { status, result } once terminal or on timeout.
  poll(taskId) {
    const r = spawnSync("5dive", ["task", "show", taskId, "--json"], { encoding: "utf8" });
    if (r.status !== 0) return { status: "unknown" };
    try {
      const j = JSON.parse(r.stdout);
      const d = j.data?.task || j.data || j; // task show nests under data.task
      return { status: d.status, result: d.result };
    } catch {
      // text fallback
      const status = (r.stdout.match(/status\s*=\s*(\w+)/) || [])[1];
      const result = (r.stdout.match(/result\s*=\s*([\s\S]*)$/) || [])[1];
      return { status, result: result?.trim() };
    }
  },
  sleep(ms) {
    spawnSync("sleep", [String(Math.ceil(ms / 1000))]);
  },
};

// Thread the prior role's structured output into a role's prompt. If the prompt
// carries the {{previous_output}} token (Marcus's schema), substitute there;
// otherwise prepend it as a context block. Role 1 (no context) is unchanged.
export function resolvePrompt(prompt, context) {
  if (!context) return prompt.replace(/\{\{\s*previous_output\s*\}\}/g, "").trimEnd();
  if (/\{\{\s*previous_output\s*\}\}/.test(prompt)) {
    return prompt.replace(/\{\{\s*previous_output\s*\}\}/g, context);
  }
  return `--- context from the previous role ---\n${context}\n--- end context ---\n\n${prompt}`;
}

// --- the engine -------------------------------------------------------------
// chain = { slug, agents: [{ role, agent, prompt }] }
// Runs roles in order, threading each result into the next as `context`.
// Returns { ok, steps: [{role, taskId, status, result}], receipt }.
export async function runChain(chain, exec = fivediveExecutor, opts = {}) {
  const { pollEveryMs = 10000, timeoutMs = 30 * 60 * 1000, onStep = () => {} } = opts;
  const steps = [];
  let context = opts.initialContext || "";

  for (const role of chain.agents) {
    const effectivePrompt = resolvePrompt(role.prompt, context);
    const taskId = exec.createTask({
      title: `${chain.slug}:${role.role}`,
      body: effectivePrompt,
      assignee: role.agent,
    });
    exec.dispatch({ agent: role.agent, taskId, role: role.role, prompt: effectivePrompt });
    onStep({ phase: "dispatched", role: role.role, taskId });

    // Poll until the role completes (done) or fails (cancelled) or we time out.
    const deadline = Date.now() + timeoutMs;
    let status, result;
    // NOTE: Date.now() is fine here — this is a live spike script, not a
    // resumable workflow.
    /* eslint-disable no-constant-condition */
    while (true) {
      const p = exec.poll(taskId);
      status = p.status;
      result = p.result;
      if (status === "done" || status === "cancelled") break;
      if (Date.now() > deadline) {
        status = "timeout";
        break;
      }
      exec.sleep(pollEveryMs);
    }

    steps.push({ role: role.role, agent: role.agent, taskId, status, result });
    onStep({ phase: "completed", role: role.role, taskId, status });

    if (status !== "done") {
      return { ok: false, failedAt: role.role, steps, receipt: buildReceipt(chain, steps, false) };
    }
    context = result || ""; // structured handoff: this result IS the next input
  }

  return { ok: true, steps, receipt: buildReceipt(chain, steps, true) };
}

// A minimal run receipt (the co-signed proof card wraps this later).
function buildReceipt(chain, steps, ok) {
  return {
    loop: chain.slug,
    ok,
    roles: steps.map((s) => ({ role: s.role, agent: s.agent, task: s.taskId, status: s.status })),
    // outputs kept separate so the receipt header stays compact
    outputs: Object.fromEntries(steps.map((s) => [s.role, s.result || null])),
  };
}
