// Verified-publisher signing (DIVE-779 pillar 4): optional signal, never a gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { signLoopFile, verifyLoopText, publicKeyFromDidKey } from "../src/signing.mjs";
import { loadOrCreateKey } from "../src/receipt.mjs";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "ci-analyst",
  "LOOP.md",
);

// Keys mint into OPENAGENT_HOME — keep the test hermetic, never touch the real one.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agenticloops-signing-"));
process.env.OPENAGENT_HOME = path.join(scratch, "openagent-home");

function freshCopy(name) {
  const f = path.join(scratch, name);
  fs.copyFileSync(FIXTURE, f);
  return f;
}

test("unsigned LOOP.md reads as signed:false", () => {
  const v = verifyLoopText(fs.readFileSync(FIXTURE, "utf8"));
  assert.equal(v.signed, false);
});

test("sign -> verify round-trips and matches this machine's did", () => {
  const f = freshCopy("roundtrip.LOOP.md");
  const { did } = signLoopFile(f);
  assert.equal(did, loadOrCreateKey().did);
  const v = verifyLoopText(fs.readFileSync(f, "utf8"));
  assert.deepEqual({ signed: v.signed, ok: v.ok, did: v.did }, { signed: true, ok: true, did });
});

test("re-signing replaces (not stacks) publisher + signature", () => {
  const f = freshCopy("resign.LOOP.md");
  signLoopFile(f);
  signLoopFile(f);
  const raw = fs.readFileSync(f, "utf8");
  assert.equal(raw.match(/^publisher:/gm).length, 1);
  assert.equal(raw.match(/^signature:/gm).length, 1);
  assert.equal(verifyLoopText(raw).ok, true);
});

test("editing signed content invalidates the signature", () => {
  const f = freshCopy("tamper.LOOP.md");
  signLoopFile(f);
  const raw = fs.readFileSync(f, "utf8").replace("every 4h", "every 5m");
  const v = verifyLoopText(raw);
  assert.equal(v.signed, true);
  assert.equal(v.ok, false);
});

test("swapping the publisher did invalidates the signature", () => {
  const f = freshCopy("swap.LOOP.md");
  const { did } = signLoopFile(f);
  // A real, well-formed did:key that simply isn't the signer.
  const other = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
  assert.notEqual(other, did);
  const raw = fs.readFileSync(f, "utf8").replace(did, other);
  const v = verifyLoopText(raw);
  assert.equal(v.signed, true);
  assert.equal(v.ok, false);
});

test("signature without publisher (or vice versa) is invalid, not unsigned", () => {
  const raw = fs.readFileSync(FIXTURE, "utf8").replace("---\n\nScan", "signature: abc\n---\n\nScan");
  const v = verifyLoopText(raw);
  assert.equal(v.signed, true);
  assert.equal(v.ok, false);
});

test("publicKeyFromDidKey decodes the encoder's did back to the same key", () => {
  const key = loadOrCreateKey();
  const decoded = publicKeyFromDidKey(key.did);
  const pem = decoded.export({ format: "pem", type: "spki" }).toString().trim();
  assert.equal(pem, key.publicKey.trim());
});
