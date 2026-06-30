// Run receipts — REUSE the canonical openagent receipt scheme so the bytes match
// card provenance, A2A handshakes, and zerohuman edges (one verifier ranks the
// whole directory: "proof, not popularity"). We import lib/receipts.js verbatim
// from the published @5dive/openagent and reimplement only the tiny keystore
// loader on lib/provenance.js (keystore.js isn't published) — SAME
// ~/.openagent/agent.key path + SAME keygen, so the did:key is byte-identical.
//
// v0.1 = SINGLE-SIGNER run receipt: the loop owner's did signs one body over the
// whole run (hashed outputs, never the raw text). An honest attestation that the
// run happened with these outputs. v0.2 = per-handoff co-signed EDGES on the
// 5dive backend where each role is a distinct keyed agent (receipts.cosign()).
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
// receipts.js is vendored verbatim (newer than the last openagent npm release);
// provenance.js comes straight from the published package. Both produce
// byte-identical signatures to card provenance / zerohuman edges.
const receipts = require("./vendor/receipts.cjs");
const provenance = require("@5dive/openagent/lib/provenance.js");

function agentHome() {
  const env = process.env.OPENAGENT_HOME;
  if (env && env.trim()) {
    const e = env.trim();
    return e.startsWith("~") ? path.join(os.homedir(), e.slice(1)) : path.resolve(e);
  }
  return path.join(os.homedir(), ".openagent");
}

// Load the agent's keystore key (~/.openagent/agent.key), minting one on first
// use — identical layout + keygen to openagent/lib/keystore.js so the identity
// is the same one the agent's card/handshakes use.
export function loadOrCreateKey() {
  const home = agentHome();
  const keyPath = path.join(home, "agent.key");
  let privateKey;
  try {
    privateKey = fs.readFileSync(keyPath, "utf8").trim();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    const kp = provenance.generateKeypair();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(keyPath, kp.privateKey + "\n", { mode: 0o600 });
    try {
      fs.writeFileSync(path.join(home, "agent.pub"), kp.publicKey + "\n", { mode: 0o644 });
    } catch {
      /* pub is a convenience */
    }
    privateKey = kp.privateKey;
  }
  const publicKey = provenance.publicPemFromPrivate(privateKey);
  return { privateKey, publicKey, did: provenance.didKeyFromPublicKey(publicKey) };
}

// Sign a single-signer run receipt over the chain. `steps` = [{role, persona,
// output}]. Outputs are sha256-hashed (size/privacy) — never embedded.
export function signRunReceipt({ loop, spec = "0.1", steps, at }) {
  const key = loadOrCreateKey();
  const body = {
    v: 1,
    loop,
    spec,
    roles: steps.map((s) => ({
      role: s.role,
      persona: s.persona || null,
      output_hash: receipts.hash(s.output || ""),
    })),
    final: steps.length ? receipts.hash(steps[steps.length - 1].output || "") : null,
    at,
  };
  return { receipt: body, sigs: [receipts.sign(body, key.privateKey)], signer: key.did };
}

// Verify a single-signer run receipt: the signature verifies over the body and
// its `by` did matches its embedded key. (requireBoth=false — this is an
// attestation, not a two-party edge.)
export function verifyRunReceipt(signed) {
  return receipts.verify(signed, { requireBoth: false });
}

export { receipts };
