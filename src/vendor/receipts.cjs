"use strict";

// VENDORED VERBATIM from 5dive-ai/openagent lib/receipts.js (DIVE-730). The only
// change is the `provenance` require path → the published @5dive/openagent
// package (provenance.js IS published; receipts.js is newer than the last
// openagent npm release, so we vendor it to stay byte-identical without coupling
// this CLI's launch to an openagent republish). When openagent republishes with
// lib/receipts.js, switch receipt.mjs to require the package copy and delete this.
// Signatures + canonical body are identical to card provenance / zerohuman edges,
// so ONE verifier ranks the whole directory ("proof, not popularity").

const crypto = require("crypto");
const {
  canonicalBytes,
  toPublicKey,
  toPrivateKey,
  publicPemFromPrivate,
  didKeyFromPublicKey,
} = require("@5dive/openagent/lib/provenance.js");

function hash(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

// The unsigned body both parties agree on. task/result are content hashes the
// caller supplies (use hash() on raw text); from/to are did:keys.
function buildReceipt({ taskHash, resultHash, fromDid, toDid, at, title = null }) {
  if (!taskHash || !resultHash || !fromDid || !toDid || !at) {
    throw new Error("buildReceipt: taskHash, resultHash, fromDid, toDid, at all required");
  }
  const body = { v: 1, task: taskHash, result: resultHash, from: fromDid, to: toDid, at };
  if (title) body.title = String(title);
  return body;
}

// One party's signature over the canonical receipt body. `by` is the signer's
// did:key, `key` the public half it derives from (self-contained verification).
function sign(receipt, privateKey) {
  const key = publicPemFromPrivate(privateKey);
  return {
    by: didKeyFromPublicKey(key),
    key,
    sig: crypto.sign(null, canonicalBytes(receipt), toPrivateKey(privateKey)).toString("base64"),
  };
}

// A fully co-signed receipt = the body + both parties' signatures over it.
function cosign(receipt, fromPrivateKey, toPrivateKey_) {
  return { receipt, sigs: [sign(receipt, fromPrivateKey), sign(receipt, toPrivateKey_)] };
}

// Verify a co-signed receipt. Every signature must (a) verify over the body and
// (b) have its `by` did match its `key`. With requireBoth, both named parties
// (receipt.from and receipt.to) must be among the signers — a one-sided receipt
// is not an edge.
function verify(cosigned, { requireBoth = true } = {}) {
  const { receipt, sigs } = cosigned || {};
  if (!receipt || !Array.isArray(sigs) || sigs.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  const bytes = canonicalBytes(receipt);
  const signers = new Set();
  for (const s of sigs) {
    if (!s || !s.key || !s.by || !s.sig) return { ok: false, reason: "incomplete signature" };
    let derived;
    try {
      derived = didKeyFromPublicKey(s.key);
    } catch {
      return { ok: false, reason: "unparseable signer key" };
    }
    if (derived !== s.by) return { ok: false, reason: "signer did/key mismatch" };
    let ok = false;
    try {
      ok = crypto.verify(null, bytes, toPublicKey(s.key), Buffer.from(String(s.sig), "base64"));
    } catch {
      ok = false;
    }
    if (!ok) return { ok: false, reason: `bad signature from ${s.by}` };
    signers.add(s.by);
  }
  if (requireBoth) {
    if (receipt.from === receipt.to) return { ok: false, reason: "not an edge (self-addressed receipt)" };
    if (!signers.has(receipt.from) || !signers.has(receipt.to)) {
      return { ok: false, reason: "missing a party's signature" };
    }
  }
  return { ok: true, signers: [...signers] };
}

// Verify a portable history (array of JSONL lines, each a co-signed receipt).
function verifyHistory(lines, selfDid) {
  let total = 0;
  let valid = 0;
  const counterparties = new Set();
  const seen = new Set();
  const bad = [];
  for (const line of lines) {
    if (!String(line).trim()) continue;
    total++;
    let c;
    try {
      c = JSON.parse(line);
    } catch {
      bad.push("parse");
      continue;
    }
    const v = verify(c);
    if (!v.ok) {
      bad.push(v.reason);
      continue;
    }
    if (selfDid && c.receipt.from !== selfDid && c.receipt.to !== selfDid) {
      bad.push("not-mine");
      continue;
    }
    if (c.receipt.from === c.receipt.to) {
      bad.push("self-loop");
      continue;
    }
    const rid = crypto.createHash("sha256").update(canonicalBytes(c.receipt)).digest("hex");
    if (seen.has(rid)) {
      bad.push("duplicate");
      continue;
    }
    seen.add(rid);
    valid++;
    if (selfDid) counterparties.add(c.receipt.from === selfDid ? c.receipt.to : c.receipt.from);
  }
  return { total, valid, counterparties: [...counterparties], bad };
}

module.exports = { hash, buildReceipt, sign, cosign, verify, verifyHistory };
