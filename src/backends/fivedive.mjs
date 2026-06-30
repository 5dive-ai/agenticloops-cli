// 5dive-native backend — the host-optimized path. Each role is a linked 5dive
// task assigned to a role agent; the agent is woken via HEARTBEAT (deterministic
// — not tmux/agent-send keystroke injection, which is racy to a busy agent and
// needs sudo), does the work, and finishes with `task done --result=…`. The
// driver polls task STATUS (cold-safe) and the engine threads the structured
// result into the next role's {{previous_output}}.
//
// Role→agent: opts.roleAgents maps role id -> agent name; falls back to
// opts.agent (one agent runs the roles in sequence). v0.2 provisions a distinct
// keyed agent per role so each handoff becomes a co-signed edge.
import { spawnSync } from "node:child_process";

const sh = (args) => spawnSync("5dive", args, { encoding: "utf8" });

function taskAdd({ title, body, assignee }) {
  // NOTE: 5dive flags are =form — `--body=x`, not `--body x` (caught in spike).
  const r = sh(["task", "add", title, `--body=${body}`, `--assignee=${assignee}`, "--priority=high", "--json"]);
  if (r.status !== 0) throw new Error(`task add failed: ${(r.stderr || r.stdout || "").trim()}`);
  const m = (r.stdout || "").match(/([A-Z]+-\d+)/);
  if (!m) throw new Error(`could not parse task id from: ${r.stdout}`);
  return m[1];
}

function ensureHeartbeat(agent) {
  // Idempotent: enroll the role agent so a queued task wakes it. Best-effort —
  // if heartbeat enroll fails we still created the task (an operator/other tick
  // can pick it up); we just won't auto-drive.
  sh(["heartbeat", "on", agent]);
}

function nudgeTick() {
  // Wake due agents NOW instead of waiting for the heartbeat cron, so a
  // run-now chain doesn't stall up to the tick interval. Best-effort; needs root.
  spawnSync("sudo", ["5dive", "heartbeat", "tick"], { encoding: "utf8" });
}

// The handoff instruction the heartbeat-woken agent needs: it sees ONLY the task
// body (no agent-send), so the body must tell it to finish by completing the
// task with its full output as --result (that result IS the next role's input).
function withHandoffInstruction(prompt) {
  return (
    `${prompt}\n\n` +
    `--- how to finish (required) ---\n` +
    `Complete THIS task with your full, self-contained output as the result:\n` +
    `  5dive task done <this-task-id> --result="<your output>"\n` +
    `Your result is the ONLY thing passed to the next role — make it complete.`
  );
}

function pollTask(taskId) {
  const r = sh(["task", "show", taskId, "--json"]);
  if (r.status !== 0) return { status: "unknown" };
  try {
    const j = JSON.parse(r.stdout);
    const d = j.data?.task || j.data || j; // task show nests under data.task
    return { status: d.status, result: d.result };
  } catch {
    return { status: "unknown" };
  }
}

export function fivediveBackend(opts = {}) {
  const roleAgents = opts.roleAgents || {};
  const fallback = opts.agent || null;
  const pollEveryMs = opts.pollEveryMs || 10000;
  const timeoutMs = opts.timeoutMs || 30 * 60 * 1000;

  return {
    label: "5dive (linked tasks · heartbeat wake · structured result)",
    async runRole({ role, prompt, onLog }) {
      const agent = roleAgents[role] || fallback;
      if (!agent) {
        return { status: "error", output: "", error: `no agent mapped for role "${role}" (set roleAgents or --agent)` };
      }
      const taskId = taskAdd({ title: `${opts.loop || "loop"}:${role}`, body: withHandoffInstruction(prompt), assignee: agent });
      ensureHeartbeat(agent);
      if (opts.nudge !== false) nudgeTick();
      onLog?.(`task ${taskId} → ${agent} (heartbeat wake)`);

      const deadline = Date.now() + timeoutMs;
      // NOTE: Date.now() is fine — live runtime path, not a resumable workflow.
      for (;;) {
        const p = pollTask(taskId);
        if (p.status === "done") return { status: "done", output: p.result || "", ref: taskId };
        if (p.status === "cancelled") return { status: "cancelled", output: p.result || "", ref: taskId };
        if (Date.now() > deadline) return { status: "timeout", output: "", ref: taskId };
        spawnSync("sleep", [String(Math.ceil(pollEveryMs / 1000))]);
      }
    },
  };
}
