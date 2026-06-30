import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLoopMd, validateManifest, parseRef, triggerOf } from "../src/loop.mjs";
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
