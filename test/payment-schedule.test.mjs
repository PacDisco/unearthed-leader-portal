// Tests for netlify/functions/_shared/payment-schedule.js — the parsing of the
// Deal's free-text payment_N fields and how payments apply to the schedule.
// Run: node test/payment-schedule.test.mjs
import assert from "node:assert/strict";
import {
  parsePaymentDate, parsePaymentEntry, allocateSchedule
} from "../netlify/functions/_shared/payment-schedule.js";

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (err) { console.error(`✗ ${name}`); throw err; }
}

// ---- dates ----
test("slash dates are day-first (NZ)", () => {
  assert.equal(parsePaymentDate("09/01/2026"), "2026-01-09");
  assert.equal(parsePaymentDate("31/05/2026"), "2026-05-31");
  assert.equal(parsePaymentDate("22.2.26"), "2026-02-22");
});
test("ISO and month-name dates", () => {
  assert.equal(parsePaymentDate("2026-03-12"), "2026-03-12");
  assert.equal(parsePaymentDate("1 Sept 2026"), "2026-09-01");
  assert.equal(parsePaymentDate("27 March 2026"), "2026-03-27");
  assert.equal(parsePaymentDate("2026 Aug 11"), "2026-08-11");
  assert.equal(parsePaymentDate("March 27, 2026"), "2026-03-27");
});
test("a bare amount is never a date", () => {
  assert.equal(parsePaymentDate("805"), null);
  assert.equal(parsePaymentDate("1750"), null);
  assert.equal(parsePaymentDate("31/02/2026"), null); // no 31 Feb
});

// ---- entries ----
test("amount, Stripe id and date", () => {
  const e = parsePaymentEntry("1750, pi_3SnaJODaC93fmk9l3CJWLxzU, 09/01/2026");
  assert.equal(e.amount, 1750);
  assert.equal(e.stripePaymentIntent, "pi_3SnaJODaC93fmk9l3CJWLxzU");
  assert.equal(e.dateIso, "2026-01-09");
  assert.equal(e.note, null);
});
test("free-text notes are kept", () => {
  const e = parsePaymentEntry("214, Lions Donation, 2026 Aug 11");
  assert.equal(e.amount, 214);
  assert.equal(e.dateIso, "2026-08-11");
  assert.equal(e.note, "Lions Donation");
});
test("amount only", () => {
  const e = parsePaymentEntry("805");
  assert.equal(e.amount, 805);
  assert.equal(e.dateIso, null);
});
test("thousands separators and refunds", () => {
  assert.equal(parsePaymentEntry("$1,750.00, 2026-01-09").amount, 1750);
  assert.equal(parsePaymentEntry("-200, refund, 3.4.26").amount, -200);
  assert.equal(parsePaymentEntry("(200), 3.4.26").amount, -200);
});
test("empty fields are skipped", () => {
  assert.equal(parsePaymentEntry(""), null);
  assert.equal(parsePaymentEntry(null), null);
});

// ---- allocation ----
const sched = (...amounts) => amounts.map((amount, i) => ({ index: i + 1, amount }));
const paid = (...amounts) => amounts.map((amount, i) => ({ index: i + 1, amount, dateIso: null }));

test("payments fill the schedule in order", () => {
  const a = allocateSchedule(sched(1750, 805, 805), paid(1750, 805, 805));
  assert.deepEqual(a.rows.map(r => r.status), ["paid", "paid", "paid"]);
  assert.equal(a.credit, 0);
});
test("a short payment leaves a balance on that row", () => {
  const a = allocateSchedule(sched(1750, 805, 805), paid(1750, 805, 214));
  assert.equal(a.rows[2].status, "partial");
  assert.equal(a.rows[2].applied, 214);
  assert.equal(a.rows[2].remaining, 591);
});
test("payments don't have to line up with rows", () => {
  // two chunks paying one row, and one chunk spanning two rows
  const a = allocateSchedule(sched(1000, 500, 500), paid(600, 400, 700));
  assert.deepEqual(a.rows.map(r => r.status), ["paid", "paid", "partial"]);
  assert.equal(a.rows[2].remaining, 300);
});
test("overpayment becomes credit", () => {
  const a = allocateSchedule(sched(1000), paid(1000, 214));
  assert.equal(a.credit, 214);
});
test("refunds reduce what's been applied", () => {
  const a = allocateSchedule(sched(1000, 500), paid(1500, -500));
  assert.equal(a.totalPaid, 1000);
  assert.equal(a.rows[1].status, "unpaid");
});
test("settledOn is the date of the payment that completed the row", () => {
  const a = allocateSchedule(sched(1000, 500), [
    { index: 1, amount: 600, dateIso: "2026-01-01" },
    { index: 2, amount: 600, dateIso: "2026-02-01" }
  ]);
  assert.equal(a.rows[0].settledOn, "2026-02-01");
  assert.equal(a.rows[1].status, "partial");
});
test("TBC rows (no amount) absorb nothing", () => {
  const a = allocateSchedule([{ index: 1, amount: 500 }, { index: 2, amount: null }, { index: 3, amount: 500 }], paid(1000));
  assert.deepEqual(a.rows.map(r => r.index), [1, 3]);
  assert.equal(a.rows[1].status, "paid");
});
test("the real example: 10 deal payments against the schedule", () => {
  const raw = ["1750, pi_x, 09/01/2026", "805, priyapillaig, 31/05/2026", "805, priyapillaig, 29/06/2026",
    "805", "805", "805", "805", "805", "214, Lions Donation, 2026 Aug 11", "805, pi_y, 1 Sept 2026"];
  const entries = raw.map((r, i) => ({ index: i + 1, ...parsePaymentEntry(r) }));
  const a = allocateSchedule(sched(1750, 805, 805, 805, 805, 805, 805, 805, 805, 805), entries);
  assert.equal(a.totalPaid, 8404);
  assert.equal(a.rows[8].status, "paid");
  assert.equal(a.rows[9].status, "partial");
  assert.equal(a.rows[9].remaining, 591);
});

console.log(`payment-schedule: ${passed} tests passed`);
