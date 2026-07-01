import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLoopMd, validateManifest, parseBudget, normalizeBudget, TASK_BUDGET_MIN_TOKENS, parseRef, triggerOf } from "../src/loop.mjs";
import { budgetCliArgs, portableBackend } from "../src/backends/portable.mjs";
import { fivediveBackend } from "../src/backends/fivedive.mjs";
import { budgetNote } from "../src/backends/fivedive.mjs";
import { parseSchedule } from "../src/schedule.mjs";
import { parseSkillEntry } from "../src/skills.mjs";
import { preflight } from "../src/preflight.mjs";
import { telemetryDisabled } from "../src/telemetry.mjs";
import { search, resolveSlug } from "../src/registry.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "fixtures", "ci-analyst", "LOOP.md"), "utf8");

test("parseLoopMd splits frontmatter + prompt", () => {
  const { manifest, prompt } = parseLoopMd(fixture);
  assert.equal(manifest.name, "ci-analyst");
  assert.equal(manifest.schedule, "every 4h");
  assert.ok(prompt.startsWith("Scan our competitor set"));
});

test("validateManifest passes a valid loop", () => {
  const { manifest } = parseLoopMd(fixture);
  assert.deepEqual(validateManifest(manifest), []);
});

test("validateManifest catches missing required fields", () => {
  assert.ok(validateManifest({}).length >= 3);
  assert.ok(validateManifest({ name: "x", description: "y" }).some((e) => /trigger/.test(e)));
  assert.ok(validateManifest({ name: "BAD NAME", description: "d", schedule: "daily" }).some((e) => /kebab/.test(e)));
  assert.ok(validateManifest({ name: "x", description: "d", schedule: "daily", tier: "opus" }).some((e) => /tier/.test(e)));
});

test("parseBudget accepts token and cost forms", () => {
  assert.deepEqual(parseBudget(200000), { kind: "tokens", tokens: 200000 });
  assert.deepEqual(parseBudget("200k"), { kind: "tokens", tokens: 200000 });
  assert.deepEqual(parseBudget("1.5m"), { kind: "tokens", tokens: 1.5e6 });
  assert.deepEqual(parseBudget("2M"), { kind: "tokens", tokens: 2e6 });
  assert.deepEqual(parseBudget("$2.00"), { kind: "cost", cost: 2 });
  assert.deepEqual(parseBudget("$0.5"), { kind: "cost", cost: 0.5 });
});

test("parseBudget rejects junk and non-positive values", () => {
  for (const bad of ["", "abc", "200kb", "$", "$-1", "-5", "0", "0k", "$0", "1.5x", "k", true, null, {}])
    assert.equal(parseBudget(bad), null, `expected null for ${JSON.stringify(bad)}`);
});

test("validateManifest checks budget", () => {
  const base = { name: "x", description: "d", schedule: "daily" };
  assert.deepEqual(validateManifest({ ...base, budget: "200k" }), []);
  assert.deepEqual(validateManifest({ ...base, budget: "$2.00" }), []);
  assert.deepEqual(validateManifest({ ...base, budget: 500000 }), []);
  assert.ok(validateManifest({ ...base, budget: "lots" }).some((e) => /budget/.test(e)));
  assert.ok(validateManifest({ ...base, budget: "$abc" }).some((e) => /budget/.test(e)));
});

test("normalizeBudget clamps token budget up to the task_budget floor", () => {
  assert.deepEqual(normalizeBudget("5k"), { kind: "tokens", tokens: TASK_BUDGET_MIN_TOKENS });
  assert.deepEqual(normalizeBudget("200k"), { kind: "tokens", tokens: 200000 });
  assert.deepEqual(normalizeBudget("$2.00"), { kind: "cost", cost: 2 }); // cost not clamped
  assert.equal(normalizeBudget(undefined), null);
  assert.equal(normalizeBudget("junk"), null);
});

test("budgetCliArgs maps cost form to --max-budget-usd for claude only", () => {
  assert.deepEqual(budgetCliArgs(["claude", "-p"], { kind: "cost", cost: 2 }), ["--max-budget-usd", "2"]);
  assert.deepEqual(budgetCliArgs(["claude", "-p"], { kind: "tokens", tokens: 200000 }), []); // no headless task_budget flag
  assert.deepEqual(budgetCliArgs(["codex", "exec"], { kind: "cost", cost: 2 }), []); // unknown harness
  assert.deepEqual(budgetCliArgs(["claude", "-p"], null), []);
});

test("budgetNote surfaces the ceiling to the 5dive-woken agent", () => {
  assert.equal(budgetNote(null), "");
  assert.match(budgetNote({ kind: "tokens", tokens: 200000 }), /advisory/);
  assert.match(budgetNote({ kind: "tokens", tokens: 200000 }), /200000 tokens.*[Ss]elf-moderate/s);
  assert.match(budgetNote({ kind: "cost", cost: 2 }), /\$2.*[Ss]top/s);
});

test("backends label budget enforced vs advisory honestly", () => {
  // cost + claude portable → hard cap, no advisory notice
  const cost = portableBackend(["claude", "-p"], { budget: { kind: "cost", cost: 2 } });
  assert.equal(cost.budgetStatus, "enforced");
  assert.equal(cost.budgetNotice, null);
  // token + claude portable → advisory, notice steers to $ budget
  const tok = portableBackend(["claude", "-p"], { budget: { kind: "tokens", tokens: 200000 } });
  assert.equal(tok.budgetStatus, "advisory");
  assert.match(tok.budgetNotice, /advisory.*\$ budget/s);
  // codex → even cost is advisory (no flag)
  const codex = portableBackend(["codex", "exec"], { budget: { kind: "cost", cost: 2 } });
  assert.equal(codex.budgetStatus, "advisory");
  // 5dive backend → always advisory when a budget is set
  const fd = fivediveBackend({ budget: { kind: "cost", cost: 2 }, agent: "x" });
  assert.equal(fd.budgetStatus, "advisory");
  assert.match(fd.budgetNotice, /advisory/);
  // no budget → null
  assert.equal(portableBackend(["claude", "-p"], {}).budgetStatus, null);
});

test("parseRef handles owner/repo and subpaths", () => {
  assert.deepEqual(parseRef("acme/loops"), { owner: "acme", repo: "loops", subpath: "", slug: "loops" });
  const r = parseRef("acme/loops/sub/ci-analyst");
  assert.equal(r.subpath, "sub/ci-analyst");
  assert.equal(r.slug, "ci-analyst");
  assert.throws(() => parseRef("nope"));
});

test("triggerOf distinguishes schedule vs event", () => {
  assert.equal(triggerOf({ schedule: "daily" }).needsScheduler, true);
  assert.equal(triggerOf({ event: "task-done" }).needsScheduler, false);
});

test("parseSchedule maps human grammar to cron", () => {
  assert.equal(parseSchedule("every 4h").cron, "0 */4 * * *");
  assert.equal(parseSchedule("every 30m").cron, "*/30 * * * *");
  assert.equal(parseSchedule("hourly").cron, "0 * * * *");
  assert.equal(parseSchedule("daily @ 07:00").cron, "0 7 * * *");
  assert.equal(parseSchedule("weekdays @ 09:00").cron, "0 9 * * 1-5");
  assert.equal(parseSchedule("0 */6 * * *").cron, "0 */6 * * *"); // passthrough
  assert.equal(parseSchedule("every blue moon").cron, null);
});

test("parseSkillEntry resolves the three forms", () => {
  assert.deepEqual(parseSkillEntry("5dive-ai/skills/deep-research"), { id: "deep-research", owner: "5dive-ai", repo: "skills" });
  assert.deepEqual(parseSkillEntry("deep-research"), { id: "deep-research", bare: true });
  assert.deepEqual(parseSkillEntry({ id: "x", source: "a/b" }), { id: "x", owner: "a", repo: "b" });
});

test("preflight flags missing cli + secret blockers", () => {
  const { manifest } = parseLoopMd(fixture);
  const pf = preflight(manifest.requires);
  assert.ok(pf.hasBlockers);
  assert.ok(pf.missing.cli.includes("definitely-not-a-real-binary-xyz"));
  assert.ok(pf.missing.secrets.includes("CI_ANALYST_FAKE_TOKEN"));
});

test("telemetryDisabled honors flag + env standards", () => {
  assert.equal(telemetryDisabled({ flag: true }), true);
  process.env.DO_NOT_TRACK = "1";
  assert.equal(telemetryDisabled(), true);
  delete process.env.DO_NOT_TRACK;
  assert.equal(telemetryDisabled(), false);
});

test("registry search ranks by term hits", () => {
  const loops = [
    { slug: "a", jobTitle: "Research Analyst", tagline: "research", tags: ["research"] },
    { slug: "b", jobTitle: "Social", tagline: "posts", tags: ["social"] },
  ];
  const hits = search(loops, "research");
  assert.equal(hits[0].slug, "a");
  assert.equal(hits.length, 1);
});

test("resolveSlug prefers source.repo, else core convention", () => {
  const loops = [
    { slug: "imported-x", imported: true, source: { repo: "acme/loops" } },
    { slug: "ci-analyst" },
    { slug: "orphan", imported: true },
  ];
  assert.equal(resolveSlug(loops, "imported-x"), "acme/loops");
  assert.equal(resolveSlug(loops, "ci-analyst"), "5dive-ai/loops/ci-analyst");
  assert.equal(resolveSlug(loops, "orphan"), null);
});
