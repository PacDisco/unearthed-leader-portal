// Tests for get-student-tickets.js — a student's e-ticket folder link, shown
// on the Flights tab (for an admin's VIEW AS STUDENT pick, or your own).
// Run: node test/student-tickets.test.mjs
import assert from "node:assert/strict";

process.env.SESSION_SECRET = "test-secret-value-that-is-long-enough";
process.env.HUBSPOT_API_KEY = "hs-test";

const { createToken } = await import("../netlify/functions/_shared/auth.js");
const { handler, cleanTicketsUrl } = await import("../netlify/functions/get-student-tickets.js");

const CONTACTS = { "mia@example.com": "10", "other@example.com": "11", "ops@unearthed.example": "1" };
const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

function stub(deals) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/contacts/search")) {
      const b = JSON.parse(init.body || "{}");
      const who = b.filterGroups?.[0]?.filters?.[0]?.value;
      if ((b.properties || []).includes("portal_token_version")) {
        return jsonRes({ results: [{ id: CONTACTS[who] || "0", properties: { portal_token_version: "0" } }] });
      }
      return jsonRes({ results: CONTACTS[who] ? [{ id: CONTACTS[who] }] : [] });
    }
    if (u.match(/contacts\/\d+\/associations\/2-58156993/)) return jsonRes({ results: [] });
    if (u.match(/contacts\/10\/associations\/deals/)) return jsonRes({ results: deals.map(d => ({ toObjectId: d.id })) });
    if (u.includes("deals/batch/read")) return jsonRes({ results: deals.map(d => ({ id: d.id, properties: d })) });
    throw new Error("unstubbed " + u);
  };
}

async function call(caller, email, role = "user") {
  const r = await handler({
    headers: { authorization: `Bearer ${createToken({ email: caller, role, ver: 0 })}` },
    queryStringParameters: { email }
  });
  return { statusCode: r.statusCode, body: JSON.parse(r.body) };
}

let passed = 0;
const t = async (name, fn) => { try { await fn(); passed++; } catch (e) { console.error("✗", name); throw e; } };

await t("an admin sees the selected student's ticket folder", async () => {
  stub([{ id: "1", ue_airline_tickets: "https://drive.google.com/drive/folders/abc", dealname: "Mia - Malaysia", createdate: "2026-01-01" }]);
  const { statusCode, body } = await call("ops@unearthed.example", "mia@example.com", "Director");
  assert.equal(statusCode, 200);
  assert.equal(body.url, "https://drive.google.com/drive/folders/abc");
});

await t("the newest deal's tickets win", async () => {
  stub([
    { id: "1", ue_airline_tickets: "https://drive.google.com/old", createdate: "2025-01-01" },
    { id: "2", ue_airline_tickets: "https://drive.google.com/new", createdate: "2026-01-01" }
  ]);
  const { body } = await call("mia@example.com", "mia@example.com");
  assert.equal(body.url, "https://drive.google.com/new");
});

await t("no tickets yet is a null url, not an error", async () => {
  stub([{ id: "1", ue_airline_tickets: "", createdate: "2026-01-01" }]);
  const { statusCode, body } = await call("mia@example.com", "mia@example.com");
  assert.equal(statusCode, 200);
  assert.equal(body.url, null);
});

await t("someone unconnected can't read another student's tickets", async () => {
  stub([{ id: "1", ue_airline_tickets: "https://drive.google.com/x", createdate: "2026-01-01" }]);
  const { statusCode } = await call("other@example.com", "mia@example.com");
  assert.equal(statusCode, 403);
});

await t("only https links are passed through", async () => {
  assert.equal(cleanTicketsUrl("javascript:alert(1)"), null);
  assert.equal(cleanTicketsUrl("http://insecure.example"), null);
  assert.equal(cleanTicketsUrl(' https://drive.google.com/a"onmouseover=x '), null);
  assert.equal(cleanTicketsUrl(" https://drive.google.com/a "), "https://drive.google.com/a");
});

console.log(`student-tickets: ${passed} tests passed`);
