import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest, isMultiAgent, rolesOf, allSkills } from "../src/loop.mjs";
import { resolvePrompt, runChain } from "../src/chain.mjs";

const good = {
  name: "intel-brief",
  description: "research -> write",
  schedule: "every 4h",
  skills: ["shared-skill"],
  agents: [
    { role: "researcher", persona: "dude", skills: ["deep-research"], prompt: "find what changed" },
    { role: "writer", persona: "theo", prompt: "write it:\n{{previous_output}}" },
  ],
};

test("validateManifest accepts a valid multi-agent loop", () => {
  assert.deepEqual(validateManifest(good), []);
});

test("validateManifest catches bad agents blocks", () => {
  assert.ok(validateManifest({ ...good, agents: [] }).some((e) => /non-empty/.test(e)));
  assert.ok(
    validateManifest({ ...good, agents: [{ role: "a", prompt: "x" }, { role: "a", prompt: "y" }] }).some((e) =>
      /duplicate role/.test(e),
    ),
  );
  assert.ok(validateManifest({ ...good, agents: [{ role: "Bad Role", prompt: "x" }] }).some((e) => /kebab/.test(e)));
  assert.ok(validateManifest({ ...good, agents: [{ role: "ok" }] }).some((e) => /missing a prompt/.test(e)));
});

test("isMultiAgent / rolesOf / allSkills", () => {
  assert.equal(isMultiAgent(good), true);
  assert.equal(isMultiAgent({ name: "x", schedule: "daily" }), false);
  const roles = rolesOf(good);
  assert.equal(roles.length, 2);
  assert.equal(roles[0].persona, "dude");
  // top-level ∪ per-role, deduped
  assert.deepEqual(allSkills(good).sort(), ["deep-research", "shared-skill"]);
});

test("runChain threads outputs through a mock backend", async () => {
  const dispatched = [];
  const backend = {
    label: "mock",
    async runRole({ role, prompt }) {
      dispatched.push({ role, prompt });
      return { status: "done", output: role === "researcher" ? "F1; F2" : "briefing", ref: role };
    },
  };
  const res = await runChain("intel-brief", rolesOf(good), backend);
  assert.equal(res.ok, true);
  // writer's {{previous_output}} got the researcher's structured output
  assert.match(dispatched[1].prompt, /write it:\nF1; F2/);
  assert.equal(res.receipt.finalRole, "writer");
});

test("resolvePrompt token + prepend modes", () => {
  assert.equal(resolvePrompt("x:\n{{previous_output}}", "DATA"), "x:\nDATA");
  assert.match(resolvePrompt("no token", "DATA"), /context from the previous role/);
  assert.equal(resolvePrompt("role1\n{{previous_output}}", null), "role1");
});
