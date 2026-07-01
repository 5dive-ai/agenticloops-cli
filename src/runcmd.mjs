// `agenticloops run <ref>` — execute a loop's chain ONCE, now. This is what a
// schedule fires (a recurring 5dive task / GH Actions job calls it), and it's
// how you test a loop locally. Routes to a backend by harness: 5dive uses the
// native linked-task chain; everything else uses the portable headless runner.
import { fetchLoopMd, parseLoopMd, validateManifest, normalizeBudget, isMultiAgent, rolesOf } from "./loop.mjs";
import { detectHarness, getHarness } from "./harness.mjs";
import { portableBackend } from "./backends/portable.mjs";
import { fivediveBackend } from "./backends/fivedive.mjs";
import { runChain } from "./chain.mjs";
import { signRunReceipt } from "./receipt.mjs";
import { c, info, ok, warn, fail, step, CliError } from "./util.mjs";

function pickBackend(harness, opts) {
  // harness=5dive -> host-optimized linked-task chain (distinct agents, task
  // receipts). Everything else -> portable headless runner. --backend overrides.
  const choice = opts.backend || (harness.id === "5dive" ? "5dive" : "portable");
  if (choice === "5dive") return fivediveBackend(opts);
  if (!harness.headlessCmd)
    throw new CliError(`harness ${harness.id} has no headless run command for the portable backend`, 2);
  return portableBackend(harness.headlessCmd, opts);
}

export async function runLoop(ref, opts = {}) {
  const fetched = await fetchLoopMd(ref);
  const { manifest, prompt } = parseLoopMd(fetched.raw);
  const errs = validateManifest(manifest);
  if (errs.length) {
    errs.forEach((e) => fail(e));
    throw new CliError("LOOP.md failed validation", 3);
  }

  // Single-prompt loops run as a one-role chain so one engine handles both.
  const roles = isMultiAgent(manifest)
    ? rolesOf(manifest)
    : [{ role: "main", persona: manifest.persona || null, skills: manifest.skills || [], prompt }];

  const harness = opts.harness
    ? getHarness(opts.harness) || (() => { throw new CliError(`unknown harness "${opts.harness}"`, 2); })()
    : detectHarness().harness;
  if (!harness) throw new CliError("no harness detected — pass --harness=<id>", 4);

  // A CLI --budget overrides the manifest; both are normalized (token floor +
  // shape). Threaded into the backend so it can enforce the per-run spend cap.
  // An explicit but malformed --budget is an error (the manifest form was already
  // caught by validateManifest above).
  const budgetIn = opts.budget !== undefined ? opts.budget : manifest.budget;
  const budget = normalizeBudget(budgetIn);
  if (opts.budget !== undefined && budget === null)
    throw new CliError(`--budget must be a token count (e.g. 200k, 1.5m) or a cost (e.g. $2.00)`, 2);
  const backend = pickBackend(harness, { ...opts, budget, loop: manifest.name });
  step(`Running ${c.bold(manifest.name)} — ${roles.length} role${roles.length > 1 ? "s" : ""} · ${backend.label}`);

  // Never let a budget read as enforced when it isn't: a hard cap gets a plain
  // note; a soft/advisory budget gets a warn so the user knows to use $ for a cap.
  if (budget) {
    if (backend.budgetStatus === "enforced")
      info(c.dim(`budget: hard $${budget.cost} ceiling (${backend.budgetNotice || "--max-budget-usd"})`));
    else if (backend.budgetNotice) warn(backend.budgetNotice);
  }

  const result = await runChain(manifest.name, roles, backend, {
    onStep: (s) => {
      if (s.phase === "start")
        info(`role ${s.index}/${s.total}: ${c.bold(s.role)}${s.handoffChars ? c.dim(` ← ${s.handoffChars} chars`) : ""}`);
      else if (s.phase === "done")
        s.status === "done"
          ? ok(`${s.role} ${c.dim(s.ref ? "(" + s.ref + ")" : "")}`)
          : fail(`${s.role} → ${s.status}${s.error ? ": " + s.error : ""}`);
      else if (s.phase === "log") info(c.dim(`  ${s.message}`));
    },
  });

  const at = new Date().toISOString();
  result.receipt.ranAt = at;

  // Sign a single-signer run receipt with the owner's openagent did:key — same
  // scheme as card provenance / zerohuman edges, so one verifier ranks them all.
  if (opts.sign !== false) {
    try {
      result.signed = signRunReceipt({ loop: manifest.name, steps: result.steps, at });
      info(c.dim(`receipt signed by ${result.signed.signer}`));
    } catch (e) {
      warn(`receipt signing skipped: ${e.message}`);
    }
  }

  if (result.ok) step(`${c.green("✓")} chain complete — final output by ${c.bold(result.receipt.finalRole)}`);
  else warn(`chain stopped at ${result.failedAt}`);
  return result;
}
