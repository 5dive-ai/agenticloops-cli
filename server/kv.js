// Tiny Upstash-Redis REST client. No SDK — just fetch against the REST API, so
// it works on Vercel KV (which is Upstash under the hood) or a raw Upstash DB.
// Supports both env naming conventions:
//   Vercel KV : KV_REST_API_URL    + KV_REST_API_TOKEN
//   Upstash   : UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
function creds() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

export function kvConfigured() {
  const { url, token } = creds();
  return Boolean(url && token);
}

// Run one Redis command via the Upstash REST endpoint: POST [cmd, ...args].
async function cmd(args) {
  const { url, token } = creds();
  if (!url || !token) throw new Error("KV not configured (missing REST url/token)");
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`KV ${args[0]} failed: ${r.status}`);
  const j = await r.json();
  return j.result;
}

export const kv = {
  hincrby: (key, field, by = 1) => cmd(["HINCRBY", key, field, String(by)]),
  hgetall: async (key) => {
    // Upstash returns HGETALL as a flat [f1, v1, f2, v2, ...] array.
    const flat = (await cmd(["HGETALL", key])) || [];
    const out = {};
    for (let i = 0; i < flat.length; i += 2) out[flat[i]] = Number(flat[i + 1]);
    return out;
  },
};
