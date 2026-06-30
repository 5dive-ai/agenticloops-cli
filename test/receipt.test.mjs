import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the keystore so the test mints its own key, not the host agent's.
process.env.OPENAGENT_HOME = mkdtempSync(join(tmpdir(), "agenticloops-key-"));

const { signRunReceipt, verifyRunReceipt } = await import("../src/receipt.mjs");

const steps = [
  { role: "researcher", persona: "dude", output: "- A: x\n- B: y" },
  { role: "writer", persona: "theo", output: "A did x, B did y." },
];

test("run receipt signs + verifies (single signer)", () => {
  const signed = signRunReceipt({ loop: "intel-brief", steps, at: "2026-06-30T12:00:00Z" });
  assert.equal(signed.receipt.v, 1);
  assert.equal(signed.receipt.loop, "intel-brief");
  assert.equal(signed.receipt.spec, "0.1");
  assert.equal(signed.receipt.roles.length, 2);
  // outputs are hashed, never embedded
  assert.match(signed.receipt.roles[0].output_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(signed.receipt).includes("did x"));
  assert.equal(signed.receipt.final, signed.receipt.roles[1].output_hash);
  assert.equal(signed.sigs.length, 1);
  assert.equal(signed.sigs[0].by, signed.signer);

  const v = verifyRunReceipt(signed);
  assert.equal(v.ok, true, v.reason);
});

test("tampering with the body fails verification", () => {
  const signed = signRunReceipt({ loop: "intel-brief", steps, at: "2026-06-30T12:00:00Z" });
  signed.receipt.loop = "evil-loop"; // mutate after signing
  const v = verifyRunReceipt(signed);
  assert.equal(v.ok, false);
});

test("same outputs hash identically (deterministic, byte-stable)", () => {
  const a = signRunReceipt({ loop: "l", steps, at: "2026-06-30T12:00:00Z" });
  const b = signRunReceipt({ loop: "l", steps, at: "2026-06-30T12:00:00Z" });
  assert.equal(a.receipt.roles[0].output_hash, b.receipt.roles[0].output_hash);
  assert.equal(a.signer, b.signer); // same keystore key
});
