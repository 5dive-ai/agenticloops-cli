import { test } from "node:test";
import assert from "node:assert/strict";
import { runChain, resolvePrompt } from "./chain-driver.mjs";

test("resolvePrompt substitutes {{previous_output}} when present", () => {
  assert.equal(resolvePrompt("Findings:\n{{previous_output}}", "A,B,C"), "Findings:\nA,B,C");
});

test("resolvePrompt prepends context when no token", () => {
  const out = resolvePrompt("Write it up.", "raw findings");
  assert.match(out, /context from the previous role/);
  assert.match(out, /raw findings/);
  assert.match(out, /Write it up\.$/);
});

test("resolvePrompt strips a dangling token for role 1 (no context)", () => {
  assert.equal(resolvePrompt("Do x.\n{{previous_output}}", ""), "Do x.");
});

// Mock executor: records dispatched prompts, returns canned results — lets us
// assert role N's result actually reaches role N+1 as context.
function mockExec(results) {
  const dispatched = [];
  let i = 0;
  return {
    dispatched,
    createTask: () => `TEST-${++i}`,
    dispatch: ({ taskId, prompt }) => dispatched.push({ taskId, prompt }),
    poll: (taskId) => ({ status: "done", result: results[taskId] }),
    sleep: () => {},
  };
}

test("runChain threads role1's structured result into role2", async () => {
  const exec = mockExec({ "TEST-1": "finding-1; finding-2", "TEST-2": "the briefing" });
  const chain = {
    slug: "intel-brief",
    agents: [
      { role: "researcher", agent: "spike-researcher", prompt: "Find what changed." },
      { role: "writer", agent: "spike-writer", prompt: "Write up:\n{{previous_output}}" },
    ],
  };
  const res = await runChain(chain, exec);
  assert.equal(res.ok, true);
  assert.equal(res.steps.length, 2);
  // role 1 got no context; role 2's dispatched prompt contains role 1's result
  assert.ok(!exec.dispatched[0].prompt.includes("finding-1"));
  assert.match(exec.dispatched[1].prompt, /Write up:\nfinding-1; finding-2/);
  assert.equal(res.receipt.outputs.writer, "the briefing");
  assert.equal(res.receipt.ok, true);
});

test("runChain stops + reports the failing role on non-done", async () => {
  const exec = {
    createTask: () => "TEST-X",
    dispatch: () => {},
    poll: () => ({ status: "cancelled", result: null }),
    sleep: () => {},
  };
  const res = await runChain(
    { slug: "x", agents: [{ role: "a", agent: "z", prompt: "go" }, { role: "b", agent: "y", prompt: "{{previous_output}}" }] },
    exec,
  );
  assert.equal(res.ok, false);
  assert.equal(res.failedAt, "a");
  assert.equal(res.steps.length, 1); // stopped before role b
});
