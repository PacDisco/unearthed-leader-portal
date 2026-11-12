// node test/portal-phase.test.mjs — the admin trip picker's phases (get-portals describePortal).
import assert from "node:assert/strict";
import { describePortal } from "../netlify/functions/get-portals.js";

const now = new Date("2026-11-11T00:00:00Z");
const d = (p) => describePortal(p, { now });
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ✓", name); };

t("returned trips are completed from the day after the return flight", () => {
  assert.equal(d({ flight_departure_date: "2026-10-01T18:50:00Z", return_flight_date: "2026-10-10T06:20:00Z" }).phase, "completed");
  assert.equal(d({ flight_departure_date: "2026-11-01", return_flight_date: "2026-11-11" }).phase, "in-progress", "still away on the return day");
  assert.equal(d({ flight_departure_date: "2026-11-25T12:00:00Z", return_flight_date: "2026-12-16T10:00:00Z" }).phase, "upcoming");
});
t("no return date: completed 30 days after departure", () => {
  assert.equal(d({ flight_departure_date: "2026-09-01" }).phase, "completed");
  assert.equal(d({ flight_departure_date: "2026-11-01" }).phase, "in-progress");
  assert.equal(d({ flight_departure_date: "2027-07-03T03:05:00Z" }).phase, "upcoming");
});
t("no dates: past year in the name → completed, otherwise dates TBC", () => {
  assert.equal(d({ unearthed_program: "X - Borneo 2025" }).phase, "completed");
  const tbc = d({ unearthed_program: "Hamilton Boys High School - Nepal 2027", destination: "Nepal" });
  assert.equal(tbc.phase, "no-dates"); assert.equal(tbc.year, 2027); assert.equal(tbc.completed, false);
});
t("Program Start / End Date first, flight dates as the fallback", () => {
  const both = d({ program_start_date: "2026-11-20", program_end_date: "2026-12-05", flight_departure_date: "2026-11-01", return_flight_date: "2026-11-10" });
  assert.equal(both.start, "2026-11-20"); assert.equal(both.end, "2026-12-05"); assert.equal(both.phase, "upcoming");
  const mixed = d({ program_start_date: "2026-11-01", return_flight_date: "2026-11-09" });
  assert.equal(mixed.start, "2026-11-01"); assert.equal(mixed.end, "2026-11-09"); assert.equal(mixed.phase, "completed");
  const flightsOnly = d({ flight_departure_date: "2027-07-03T03:05:00Z", return_flight_date: "2027-07-24T03:55:00Z" });
  assert.equal(flightsOnly.start, "2027-07-03"); assert.equal(flightsOnly.end, "2027-07-24");
  assert.equal(d({ program_start_date: "1793491200000" }).start, "2026-11-01", "HubSpot date as epoch ms");
});
t("HubSpot status can close a trip", () => {
  assert.equal(d({ status: "Cancelled", flight_departure_date: "2027-01-01" }).phase, "cancelled");
  assert.equal(d({ status: "Completed" }).completed, true);
  assert.equal(d({ status: "Confirmed", flight_departure_date: "2027-01-01" }).phase, "upcoming");
});
t("destination country for the filter", () => {
  assert.equal(d({ destination: "Nepal - September 17 - October 9 2026" }).country, "Nepal");
  assert.equal(d({ destination: "Cambodia | July 3 - 24, 2027" }).country, "Cambodia");
  assert.equal(d({ destination: "Sri Lanka, 2-16 December 2026" }).country, "Sri Lanka");
  assert.equal(d({ destination: "Borneo 2027" }).country, "Borneo");
  assert.equal(d({ destination: "", unearthed_program: "Kambala School - New Zealand STEM 2027" }).country, "New Zealand STEM");
});
console.log(`${n} passed`);
