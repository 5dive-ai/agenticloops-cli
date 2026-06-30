// The harness-agnostic run engine. A multi-agent loop is ONE run executed as an
// ordered chain of role-prompts; each role's structured output is threaded into
// the next via {{previous_output}}. HOW a role is run (a local headless process,
// a linked 5dive task, …) is the BACKEND's business — the engine only sequences
// and threads. Backend contract:
//   async runRole({ role, persona, prompt, index, total, onLog }) -> { output, ref, status }
//   status === "done" continues; anything else stops the chain.

// Thread the prior role's structured output into a role's prompt: substitute the
// {{previous_output}} token if present, else prepend a context block. Role 1
// (no prior output) just strips a dangling token.
export function resolvePrompt(prompt, previous) {
  const TOKEN = /\{\{\s*previous_output\s*\}\}/g;
  if (!previous) return prompt.replace(TOKEN, "").trimEnd();
  if (TOKEN.test(prompt)) return prompt.replace(TOKEN, previous);
  return `--- context from the previous role ---\n${previous}\n--- end context ---\n\n${prompt}`;
}

export async function runChain(loopName, roles, backend, opts = {}) {
  const onStep = opts.onStep || (() => {});
  const steps = [];
  let previous = opts.initialContext || null;

  for (let i = 0; i < roles.length; i++) {
    const role = roles[i];
    const prompt = resolvePrompt(role.prompt, previous);
    onStep({ phase: "start", role: role.role, index: i + 1, total: roles.length, handoffChars: previous?.length || 0 });

    let res;
    try {
      res = await backend.runRole({
        role: role.role,
        persona: role.persona,
        prompt,
        index: i + 1,
        total: roles.length,
        onLog: (m) => onStep({ phase: "log", role: role.role, message: m }),
      });
    } catch (e) {
      res = { status: "error", output: "", ref: null, error: e.message };
    }

    const status = res.status || "done";
    steps.push({ role: role.role, persona: role.persona, ref: res.ref || null, status, output: res.output || "" });
    onStep({ phase: "done", role: role.role, index: i + 1, status, ref: res.ref, error: res.error });

    if (status !== "done") {
      return { ok: false, loop: loopName, failedAt: role.role, steps, receipt: receiptBody(loopName, steps, false) };
    }
    previous = res.output || "";
  }

  return { ok: true, loop: loopName, steps, receipt: receiptBody(loopName, steps, true) };
}

// The unsigned receipt body. The signer (openagent did:key) wraps this.
export function receiptBody(loopName, steps, ok) {
  return {
    loop: loopName,
    ok,
    ranAt: null, // stamped by the caller (engine stays time-pure for testability)
    roles: steps.map((s) => ({
      role: s.role,
      persona: s.persona,
      ref: s.ref,
      status: s.status,
      outputChars: (s.output || "").length,
    })),
    finalRole: steps.length ? steps[steps.length - 1].role : null,
    outputs: Object.fromEntries(steps.map((s) => [s.role, s.output || null])),
  };
}
