// The install flow (SPEC §3): fetch+validate LOOP.md -> install skills ->
// pre-flight `requires` (prompt-or-refuse, never auto-install) -> register the
// scheduled job -> (on success) anonymous telemetry ping.
import { fetchLoopMd, parseLoopMd, validateManifest, triggerOf } from "./loop.mjs";
import { detectHarness, getHarness, hostSkillsFor } from "./harness.mjs";
import { planSkills, installSkill } from "./skills.mjs";
import { preflight } from "./preflight.mjs";
import { parseSchedule, registerTrigger, saveRecord } from "./schedule.mjs";
import { pingInstall, telemetryDisabled } from "./telemetry.mjs";
import { loadRegistry, resolveSlug } from "./registry.mjs";
import { c, sym, info, ok, warn, fail, step, confirm, ask, CliError } from "./util.mjs";

export async function install(ref, opts = {}) {
  const assumeYes = !!opts.yes;
  const dryRun = !!opts.dryRun;

  // 0. Resolve a bare slug to owner/repo via the registry, if needed.
  let loopRef = ref;
  if (!ref.includes("/")) {
    const { loops } = await loadRegistry();
    const resolved = resolveSlug(loops, ref);
    if (!resolved)
      throw new CliError(
        `"${ref}" is a bare slug I can't resolve to a repo. Use owner/repo, or find it: agenticloops find ${ref}`,
        4,
      );
    info(`resolved ${c.bold(ref)} -> ${c.bold(resolved)}`);
    loopRef = resolved;
  }

  // 1. Fetch + validate the LOOP.md.
  step("Fetching loop");
  const fetched = await fetchLoopMd(loopRef);
  const { manifest, prompt } = parseLoopMd(fetched.raw);
  const errs = validateManifest(manifest);
  if (errs.length) {
    errs.forEach((e) => fail(e));
    throw new CliError("LOOP.md failed validation against spec v0.1", 3);
  }
  const slug = manifest.name;
  const trig = triggerOf(manifest);
  ok(`${c.bold(manifest.name)} — ${manifest.description?.split("\n")[0] ?? ""}`);
  info(`trigger: ${trig.kind === "event" ? `on ${trig.value}` : trig.value}`);

  // 2. Pick the harness (auto-detect unless --harness given) + warn if it can't schedule.
  step("Target harness");
  let harness;
  if (opts.harness) {
    harness = getHarness(opts.harness);
    if (!harness) throw new CliError(`unknown harness "${opts.harness}"`, 2);
    info(`harness: ${c.bold(harness.label)}`);
  } else {
    const det = detectHarness();
    harness = det.harness;
    if (!harness)
      throw new CliError(
        "no harness detected here. Pass --harness=<5dive|github-actions|claude-code|cron|cursor>",
        4,
      );
    info(`auto-detected: ${c.bold(harness.label)}${det.all.length > 1 ? c.dim(` (of ${det.all.map((h) => h.id).join(", ")})`) : ""}`);
  }
  if (trig.needsScheduler && !harness.canSchedule) {
    warn(
      `${harness.label} can run the agent but cannot honor a recurring schedule. ` +
        `The loop will be installed but won't fire on its own — target a scheduling harness ` +
        `(--harness=5dive | github-actions | cron) to schedule it.`,
    );
    if (!(await confirm("Install anyway (unscheduled)?", { fallback: false, assumeYes }))) {
      throw new CliError("aborted — no scheduling harness", 1);
    }
  }

  // 3. Install skills (§3.1) — host-satisfied skipped, paths fetched, bare resolved.
  // Host-satisfied = verifiably present in the harness's skills dir (not asserted).
  const hostSkills = [...new Set([...(opts.hostSkills || []), ...hostSkillsFor(harness.id)])];
  const skillPlan = await planSkills(manifest.skills || [], hostSkills);
  if (skillPlan.length) {
    step("Skills");
    for (const s of skillPlan) {
      if (s.action === "host") info(`${s.id} ${c.dim("(provided by harness — skipped)")}`);
      else if (s.action === "unresolved")
        warn(`${s.id} — skipped (loop will degrade)${s.reason ? c.dim(" — " + s.reason) : ""}`);
      else {
        const r = installSkill(s, { dryRun });
        if (r.ok) ok(`${s.id} ${c.dim("<- " + s.owner + "/" + s.repo)}`);
        else warn(`${s.id} — install failed (exit ${r.status}); skipped`);
      }
    }
  }

  // 4. Pre-flight `requires` — declare-and-check, prompt-or-refuse, never auto-install.
  const pf = preflight(manifest.requires, { harness });
  const needsCheck =
    (manifest.requires &&
      (manifest.requires.cli || manifest.requires.secrets || manifest.requires.mcp || manifest.requires.network)) ||
    false;
  if (needsCheck) {
    step("Pre-flight (requires)");
    pf.cli.forEach((x) => (x.present ? ok(`cli ${x.bin}`) : fail(`cli ${x.bin} — not on PATH`)));
    pf.secrets.forEach((x) =>
      x.present ? ok(`secret ${x.name}`) : fail(`secret ${x.name} — not set`),
    );
    pf.mcp.forEach((x) => info(`mcp ${x.name} ${c.dim("(must be configured + consented — not auto-launched)")}`));
    pf.network.forEach((x) => info(`network ${x.host} ${c.dim("(egress the loop will use)")}`));

    if (pf.hasBlockers) {
      if (pf.missing.cli.length)
        warn(`missing binaries: ${pf.missing.cli.join(", ")} — install them yourself (never auto-installed)`);
      if (pf.missing.secrets.length) {
        warn(`missing secrets: ${pf.missing.secrets.join(", ")}`);
        // Offer to capture values interactively; they are stored host-side only,
        // never written into LOOP.md or sent anywhere.
        for (const name of pf.missing.secrets) {
          if (process.stdin.isTTY && !assumeYes) {
            const v = await ask(`  set ${name} now? (leave blank to skip)`);
            if (v) process.env[name] = v;
          }
        }
      }
      const stillMissing =
        pf.missing.cli.length > 0 ||
        pf.missing.secrets.some((n) => !process.env[n]);
      if (stillMissing && !(await confirm("Some requirements are unmet. Install anyway?", { fallback: false, assumeYes }))) {
        throw new CliError("aborted — unmet requirements (nothing was auto-installed)", 1);
      }
    }
  }

  // 5. Register the trigger on the harness + persist the local record.
  step("Register");
  const sched = trig.needsScheduler ? parseSchedule(manifest.schedule) : { cron: null };
  if (trig.needsScheduler && !sched.cron) {
    warn(`could not parse schedule "${manifest.schedule}" to cron — registering as-is`);
  }
  const record = {
    slug,
    ref: loopRef,
    source: fetched.url,
    harness: harness.id,
    trigger: trig,
    cron: sched.cron || null,
    description: manifest.description,
    installedAt: new Date().toISOString(),
  };
  if (!dryRun) saveRecord(slug, record, fetched.raw);
  const reg = registerTrigger(harness.id, {
    slug,
    name: manifest.name,
    prompt,
    cron: sched.cron || manifest.schedule || "",
    dryRun,
  });
  if (reg.ok) ok(reg.detail || `registered on ${harness.label}`);
  else warn(`trigger registration reported a problem: ${reg.detail || reg.status}`);

  // 6. Anonymous telemetry (opt-out) — only on a successful install.
  const optedOut = telemetryDisabled({ flag: opts.noTelemetry });
  if (!dryRun) {
    const t = await pingInstall(slug, { disabled: optedOut });
    if (optedOut) info(c.dim("telemetry: opted out"));
    else if (t.sent) info(c.dim("telemetry: counted (anonymous: slug + ts only)"));
  }

  step(`${sym.ok} Installed ${c.bold(slug)} on ${harness.label}${dryRun ? c.dim(" (dry-run)") : ""}`);
  if (reg.scheduled === false && trig.needsScheduler)
    info(`it won't fire until you wire a scheduler — see ${c.cyan("agenticloops list")}`);
  return record;
}
