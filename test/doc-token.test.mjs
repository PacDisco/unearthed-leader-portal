// Tests for /document-proxy credentials.
//
// Run with:  node test/doc-token.test.mjs   (or npm test)
//
// Background: file links can't send an Authorization header, so the
// credential rides in the query string. It used to be the SESSION token,
// which meant a leaked document URL was a working session for that user —
// and any signed-in user could proxy any file URL they could guess. These
// tests pin the two properties that fix both:
//
//   1. a doc token unlocks exactly ONE file
//   2. a doc token is not a session token, and a session token is not a
//      doc token — neither can stand in for the other

import assert from "node:assert/strict";

process.env.SESSION_SECRET = "test-secret-value-that-is-long-enough";

const { mintDocToken, verifyDocToken, proxyUrl, hashUrl } =
  await import("../netlify/functions/_shared/doc-token.js");
const { createToken, verifyToken } = await import("../netlify/functions/_shared/auth.js");

let passed = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }
async function run() {
  for (const { name, fn } of cases) {
    try { await fn(); passed++; }
    catch (err) {
      console.error(`FAIL  ${name}\n      ${err.message}`);
      process.exitCode = 1;
    }
  }
}

const FILE_A = "https://www.jotform.com/uploads/Pacific_Discovery/251396787451873/1/passport.pdf";
const FILE_B = "https://www.jotform.com/uploads/Pacific_Discovery/251396787451873/2/other.pdf";
const SESSION = { email: "leader@trip.example", exp: Date.now() + 3600_000 };

test("a doc token verifies for the file it was minted for", () => {
  const t = mintDocToken({ email: SESSION.email, url: FILE_A, exp: SESSION.exp });
  const payload = verifyDocToken(t, FILE_A);
  assert.ok(payload);
  assert.equal(payload.e, "leader@trip.example");
});

test("a doc token does NOT verify for a different file", () => {
  // The whole point. Previously one credential opened every file the proxy
  // would fetch, including ones you were never shown.
  const t = mintDocToken({ email: SESSION.email, url: FILE_A, exp: SESSION.exp });
  assert.equal(verifyDocToken(t, FILE_B), null);
});

test("a tampered file URL is refused even by one character", () => {
  const t = mintDocToken({ email: SESSION.email, url: FILE_A, exp: SESSION.exp });
  assert.equal(verifyDocToken(t, FILE_A + "?x=1"), null);
  assert.equal(verifyDocToken(t, FILE_A.replace("passport", "passporT")), null);
});

test("an expired doc token is refused", () => {
  const t = mintDocToken({ email: SESSION.email, url: FILE_A, exp: Date.now() - 1000 });
  assert.equal(verifyDocToken(t, FILE_A), null);
});

test("a doc token cannot be used as a session token", () => {
  // If this ever passes, a leaked image URL is an account takeover again.
  const t = mintDocToken({ email: SESSION.email, url: FILE_A, exp: SESSION.exp });
  assert.equal(verifyToken(t), null);
});

test("a session token cannot be used as a doc token", () => {
  const s = createToken({ email: SESSION.email, role: "Admin", ver: 1 });
  assert.equal(verifyDocToken(s, FILE_A), null);
});

test("a doc token carries no role — it can't confer admin anywhere", () => {
  const t = mintDocToken({ email: SESSION.email, url: FILE_A, exp: SESSION.exp });
  const body = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(body).sort(), ["e", "exp", "u"]);
  assert.equal(body.role, undefined);
  // The URL is hashed, not embedded — the token doesn't restate the file it
  // travels beside.
  assert.equal(body.u, hashUrl(FILE_A));
  assert.ok(!t.includes("jotform"));
});

test("signature tampering is refused", () => {
  const t = mintDocToken({ email: SESSION.email, url: FILE_A, exp: SESSION.exp });
  const [p, b, sig] = t.split(".");
  const flipped = sig.slice(0, -1) + (sig.slice(-1) === "A" ? "B" : "A");
  assert.equal(verifyDocToken(`${p}.${b}.${flipped}`, FILE_A), null);
});

test("payload tampering (a longer expiry) is refused", () => {
  const t = mintDocToken({ email: SESSION.email, url: FILE_A, exp: SESSION.exp });
  const [p, b, sig] = t.split(".");
  const body = JSON.parse(Buffer.from(b, "base64url").toString("utf8"));
  body.exp = Date.now() + 10 * 365 * 24 * 3600_000;
  const forged = Buffer.from(JSON.stringify(body)).toString("base64url");
  assert.equal(verifyDocToken(`${p}.${forged}.${sig}`, FILE_A), null);
});

test("proxyUrl builds a link the proxy will accept", () => {
  const url = proxyUrl(FILE_A, SESSION);
  assert.ok(url.startsWith("/document-proxy?url="));
  const token = new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("token");
  assert.ok(verifyDocToken(token, FILE_A));
});

test("proxyUrl is deterministic, so offline cache keys stay stable", () => {
  // The service worker caches by URL. A token that changed between renders
  // would orphan every file already saved for offline use.
  assert.equal(proxyUrl(FILE_A, SESSION), proxyUrl(FILE_A, SESSION));
});

test("proxyUrl with no session produces a link the proxy refuses", () => {
  const url = proxyUrl(FILE_A, null);
  assert.ok(!url.includes("token="));
  assert.equal(verifyDocToken(null, FILE_A), null);
});

test("garbage is refused rather than throwing", () => {
  for (const bad of ["", null, undefined, "nonsense", "d1.only-two", "a.b.c", "d1..", {}]) {
    assert.equal(verifyDocToken(bad, FILE_A), null);
  }
});

// --- cross-runtime: the edge function verifies what the Node side mints ----
//
// The proxy runs on Deno and re-implements verification with Web Crypto,
// because it can't import the Node module. Two implementations of one
// signature scheme is exactly the sort of thing that drifts — and if it
// drifts, every document in the portal returns 401. These run the real edge
// handler against real minted tokens.

globalThis.Netlify = { env: { get: (k) => process.env[k] } };
process.env.JOTFORM_API_KEY = "jf-test-key";
const edge = (await import("../netlify/edge-functions/get-document.js")).default;

function edgeRequest(fileUrl, token) {
  const qs = new URLSearchParams({ url: fileUrl });
  if (token != null) qs.set("token", token);
  return new Request(`https://leaders.example/document-proxy?${qs}`);
}

function stubUpstream() {
  globalThis.fetch = async () => new Response("FILEBYTES", {
    status: 200, headers: { "content-type": "application/pdf" },
  });
}

test("the edge proxy serves a file with a token minted for it", async () => {
  stubUpstream();
  const t = mintDocToken({ email: SESSION.email, url: FILE_A, exp: SESSION.exp });
  const res = await edge(edgeRequest(FILE_A, t), {});
  assert.equal(res.status, 200, "Node and Deno implementations disagree");
  assert.equal(res.headers.get("content-type"), "application/pdf");
});

test("the edge proxy refuses a token minted for a different file", async () => {
  stubUpstream();
  const t = mintDocToken({ email: SESSION.email, url: FILE_A, exp: SESSION.exp });
  const res = await edge(edgeRequest(FILE_B, t), {});
  assert.equal(res.status, 401);
});

test("the edge proxy refuses a session token", async () => {
  stubUpstream();
  const s = createToken({ email: SESSION.email, role: "Admin", ver: 1 });
  const res = await edge(edgeRequest(FILE_A, s), {});
  assert.equal(res.status, 401, "a leaked document link must not be a session");
});

test("the edge proxy refuses a missing or expired token", async () => {
  stubUpstream();
  assert.equal((await edge(edgeRequest(FILE_A, null), {})).status, 401);
  const stale = mintDocToken({ email: SESSION.email, url: FILE_A, exp: Date.now() - 1 });
  assert.equal((await edge(edgeRequest(FILE_A, stale), {})).status, 401);
});

test("the edge proxy still rejects hosts outside Jotform and HubSpot", async () => {
  stubUpstream();
  const evil = "https://evil.example/steal";
  const t = mintDocToken({ email: SESSION.email, url: evil, exp: SESSION.exp });
  const res = await edge(edgeRequest(evil, t), {});
  assert.equal(res.status, 400, "a valid token must not turn the proxy into an open relay");
});

await run();
console.log(`\n${passed} passed`);
