// Verified-publisher signatures for LOOP.md (DIVE-779 pillar 4).
//
// Signing is an OPTIONAL trust SIGNAL, never a gate: an unsigned loop installs
// and runs exactly as before; a signed one gets a "verified publisher" line in
// CLI output and a badge on its directory page. The identity is the same
// ~/.openagent/agent.key did:key the CLI already signs run receipts with, so a
// publisher's loop signature, card provenance, and run receipts all resolve to
// one verifiable identity.
//
// Wire format — two frontmatter fields, both single-line:
//   publisher: did:key:z6Mk...     # who signed (covered by the signature)
//   signature: <base64>            # ed25519 over the canonical body below
//
// Canonical signed body (provenance.canonicalBytes, same as receipts):
//   { v: 1, kind: "agenticloops-loop", name, publisher, sha256 }
// where sha256 is the hex hash of the LOOP.md text with the `signature:` line
// removed (the publisher line stays — swapping it breaks the hash). Verification
// is self-contained: the ed25519 public key is decoded straight from the
// did:key, so a verifier needs nothing but the file.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { loadOrCreateKey } from "./receipt.mjs";
import { parseLoopMd } from "./loop.mjs";
import { CliError } from "./util.mjs";

const require = createRequire(import.meta.url);
const provenance = require("@5dive/openagent/lib/provenance.js");
const { canonicalBytes, toPrivateKey, shortDidKey } = provenance;

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// did:key:z6Mk... -> ed25519 KeyObject. The did:key encoding is a spec constant
// (multibase base58btc of 0xed 0x01 + the 32 raw key bytes), so decoding here
// cannot drift from the openagent encoder.
export function publicKeyFromDidKey(did) {
  const s = String(did || "");
  if (!s.startsWith("did:key:z")) throw new CliError(`not a did:key: "${s}"`, 3);
  const chars = s.slice("did:key:z".length);
  let n = 0n;
  for (const ch of chars) {
    const v = BASE58.indexOf(ch);
    if (v < 0) throw new CliError(`bad base58 char "${ch}" in did:key`, 3);
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of chars) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  const buf = Buffer.from(bytes);
  if (buf.length !== 34 || buf[0] !== 0xed || buf[1] !== 0x01)
    throw new CliError("did:key does not encode an ed25519 key", 3);
  // Wrap the raw key in the fixed SPKI DER header for Ed25519.
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    buf.subarray(2),
  ]);
  return crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
}

const SIG_LINE_RE = /^signature:[^\n]*\n?/m;
const PUB_LINE_RE = /^publisher:[^\n]*\n?/m;

// Split raw into frontmatter + body so line edits never touch the body.
function splitRaw(raw) {
  const m = raw.match(/^(---\s*\n)([\s\S]*?)(\n---\s*\n?)([\s\S]*)$/);
  if (!m) throw new CliError("LOOP.md has no YAML frontmatter (expected a leading --- block)", 3);
  return { open: m[1], fm: m[2], close: m[3], body: m[4] };
}

function stripSignatureLine(raw) {
  const p = splitRaw(raw);
  return p.open + p.fm.replace(SIG_LINE_RE, "").replace(/\n+$/, "") + p.close + p.body;
}

function signedBody(name, publisher, canonicalText) {
  return {
    v: 1,
    kind: "agenticloops-loop",
    name,
    publisher,
    sha256: crypto.createHash("sha256").update(canonicalText).digest("hex"),
  };
}

// Sign a LOOP.md in place with this machine's ~/.openagent identity.
// Re-signing (same or new key) replaces the previous publisher + signature.
export function signLoopFile(file) {
  const key = loadOrCreateKey();
  const raw = fs.readFileSync(file, "utf8");
  const { manifest } = parseLoopMd(raw); // throws on malformed frontmatter
  if (!manifest.name) throw new CliError("cannot sign: LOOP.md has no `name`", 3);

  // Drop any previous publisher/signature, then re-add publisher as the last
  // frontmatter line so the canonical (signed) text is deterministic.
  const p = splitRaw(raw);
  const fm = p.fm.replace(SIG_LINE_RE, "").replace(PUB_LINE_RE, "").replace(/\n+$/, "");
  const canonicalText = p.open + fm + `\npublisher: ${key.did}` + p.close + p.body;

  const body = signedBody(manifest.name, key.did, canonicalText);
  const sig = crypto.sign(null, canonicalBytes(body), toPrivateKey(key.privateKey)).toString("base64");

  const signedText =
    p.open + fm + `\npublisher: ${key.did}\nsignature: ${sig}` + p.close + p.body;
  fs.writeFileSync(file, signedText);
  return { did: key.did, file };
}

// Verify raw LOOP.md text. Never throws on bad input — returns a status object
// so callers can render a line without gating anything.
//   { signed:false }                          — no publisher/signature fields
//   { signed:true, ok:true,  did }            — verified
//   { signed:true, ok:false, did?, reason }   — present but wrong (worth a loud warn)
export function verifyLoopText(raw) {
  let manifest;
  try {
    ({ manifest } = parseLoopMd(raw));
  } catch {
    return { signed: false };
  }
  const did = manifest.publisher;
  const sig = manifest.signature;
  if (!did && !sig) return { signed: false };
  if (!did || !sig)
    return { signed: true, ok: false, did, reason: "publisher and signature must both be present" };
  let publicKey;
  try {
    publicKey = publicKeyFromDidKey(did);
  } catch (e) {
    return { signed: true, ok: false, did, reason: e.message };
  }
  const body = signedBody(manifest.name, did, stripSignatureLine(raw));
  let ok = false;
  try {
    ok = crypto.verify(null, canonicalBytes(body), publicKey, Buffer.from(String(sig).trim(), "base64"));
  } catch (e) {
    return { signed: true, ok: false, did, reason: "unverifiable signature: " + e.message };
  }
  return ok
    ? { signed: true, ok: true, did }
    : { signed: true, ok: false, did, reason: "signature does not match the content or key (edited after signing, or wrong key)" };
}

// One display line for install/run output. Returns null for unsigned loops —
// absence of a badge IS the unsigned state; we don't nag about it.
export function publisherLine(raw, { c, sym }) {
  const v = verifyLoopText(raw);
  if (!v.signed) return null;
  if (v.ok) return `${sym.ok} verified publisher ${c.bold(shortDidKey(v.did))}`;
  return `${sym.err} publisher signature INVALID — ${v.reason} ${c.dim("(treating as unsigned)")}`;
}
