// Live cold-run of a 2-role chain on the 5dive runtime — the DIVE-809
// multi-agent go/no-go data point. Uses trivial, dependency-free prompts so the
// test isolates the MECHANISM (structured handoff + context-passing), not
// research quality. Run: node spike/run-live.mjs
import { runChain } from "./chain-driver.mjs";

const chain = {
  slug: "intel-brief-spike",
  agents: [
    {
      role: "researcher",
      agent: "spike-researcher",
      prompt:
        "Invent 3 plausible competitor moves from this week as a short structured list " +
        "(format: `- <Company>: <move>`). No prose, just the 3 lines.",
    },
    {
      role: "writer",
      agent: "spike-writer",
      prompt:
        "Write a 2-sentence competitive briefing from the researcher's findings below. " +
        "Be specific to the findings.\n\nFindings:\n{{previous_output}}",
    },
  ],
};

const started = Date.now();
const res = await runChain(chain, undefined, {
  pollEveryMs: 8000,
  timeoutMs: 12 * 60 * 1000,
  onStep: (s) =>
    process.stderr.write(
      `[${Math.round((Date.now() - started) / 1000)}s] ${s.phase} ${s.role} ${s.taskId || ""} ${s.status || ""}\n`,
    ),
});

console.log("\n===== COLD-RUN RESULT =====");
console.log("ok:", res.ok, res.failedAt ? `(failed at ${res.failedAt})` : "");
for (const st of res.steps) {
  console.log(`\n--- ${st.role} (${st.agent}, ${st.taskId}) -> ${st.status} ---`);
  console.log((st.result || "(no result)").slice(0, 600));
}
console.log("\n===== RECEIPT =====");
console.log(JSON.stringify(res.receipt, null, 2));
process.exit(res.ok ? 0 : 1);
