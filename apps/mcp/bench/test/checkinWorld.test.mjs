/**
 * A check-in row's look is the fixture world's and the row's own, never the simulated world's invention (Training,
 * 2026-11-18: a check-in's new mail and calendar were padded with made-up mail and events, so the row read as Tex's
 * doing). And a calendar write Tex makes is a change the judge reads, not a blank "recorded changes".
 *
 * Sabotage: drop the closed-for-new check from simulateServices, or fold a calendar line back into the mail body, and
 * these fail. Drop `calendarChanges` from world.changes() and the calendar move test fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { calendarChanges, withArrivedEvents } from "../calendar.mjs";
import { parseTest } from "../load.mjs";
import { checkinCalendar, checkinMail, cantRun, fdTest } from "../setsFd.mjs";
import { createSimWorld, simMemo, simulateServices, withClosedForNew } from "../simWorld.mjs";
import { createCalendarRoute } from "../../test/controlPlaneStub/calendar.mjs";

const conv = (msgs, more = {}) => ({ id: "c1", set: "dev", kind: "one", members: ["Maya"], world: "maya", msgs, ...more });
const unit = (c, at) => ({ convo: c, at, label: c.msgs[at].labels?.fd ?? {}, row: { chat: c.id, msg: c.msgs[at].id, at, node: "fd" } });
const FRONT = "job: texting-assistant\nrun_as: Maya\ntoday: 2026-10-08\nruns: 1\nweb: scripted";

/** A model that invents mail and calendar events for any ask, counting what it was asked. */
function inventing() {
  const asked = [];
  const answers = {
    "gmail search": { results: [{ id: "invented-1", date: "2026-07-01T09:00:00Z", from: "Bank Alerts <alerts@bank.example>", to: "john@gmail.example", subject: "Invented alert", snippet: "made up" }] },
    "google calendar days": { days: [{ date: "2026-07-01", events: [{ start: "09:00", end: "09:30", title: "Invented standup" }] }] },
  };
  const send = async (body) => {
    const request = JSON.parse(body);
    asked.push(request);
    const kind = /^Call: (.+)$/m.exec(request.messages[0].content)[1];
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(answers[kind] ?? {}) }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  };
  return { send, asked };
}

test("a check-in look's mail search and calendar days are the fixture's and the row's, never invented, while closed for new", async () => {
  const { send, asked } = inventing();
  const sim = createSimWorld({ send, setting: "Tex has Gmail and the calendar", today: "2026-07-01", person: "John", memo: simMemo() });
  const fixtureMail = [{ id: "fixture-1", address: "john@gmail.example", from: "Priya", subject: "Dinner Friday", body: "7pm", snippet: "7pm" }];
  const controlPlane = { flags: { mailResults: async () => fixtureMail, mailboxes: [{ address: "john@gmail.example", folder: "0-inbox/email" }], calendarDays: null } };
  simulateServices(sim, controlPlane, { connectedCalendar: true });

  // Outside a check-in the world still invents, as a Dev chat's world does.
  const open = await controlPlane.flags.mailResults("newer_than:1h");
  assert.deepEqual(open.map((row) => row.id), ["fixture-1", "invented-1"]);

  const asksBefore = asked.length;
  const closed = await withClosedForNew(sim, () => controlPlane.flags.mailResults("newer_than:1h"));
  assert.deepEqual(closed.map((row) => row.id), ["fixture-1"], "no invented new mail in a check-in's look");
  const days = await withClosedForNew(sim, () => controlPlane.flags.calendarDays({ date: "2026-07-01", days: 1 }));
  assert.deepEqual(days, { ok: true, days: [] }, "no invented calendar events in a check-in's look");
  assert.equal(asked.length, asksBefore, "the closed look asks the simulated world nothing");
  assert.equal(sim.newClosed(), false, "the mode is off again after the look");
});

test("withClosedForNew turns the mode off even when the look throws", async () => {
  const sim = createSimWorld({ send: null, setting: "x", memo: simMemo() });
  await assert.rejects(withClosedForNew(sim, async () => { throw new Error("look failed"); }), /look failed/);
  assert.equal(sim.newClosed(), false);
  assert.equal(await withClosedForNew(null, async () => "no world"), "no world", "a run with no simulated world is unchanged");
});

test("\"Gmail: X. Calendar: Y\" splits into the mail X and the calendar event Y", () => {
  assert.deepEqual(checkinMail("Gmail: TAP: flight delayed. Calendar: Dinner at 7"), { from: "TAP", subject: "flight delayed", body: "flight delayed" });
  assert.equal(checkinCalendar("Gmail: TAP: flight delayed. Calendar: Dinner at 7"), "Dinner at 7");
  assert.equal(checkinCalendar("shared calendar: Mon standup at 9; Gmail to the group inbox: Kenji asks to move to 3pm"), "Mon standup at 9");
  assert.equal(checkinMail("shared calendar: Mon standup at 9; Gmail to the group inbox: Kenji asks to move to 3pm").body, "Kenji asks to move to 3pm");
  assert.equal(checkinCalendar("Gmail: TAP: flight delayed"), null, "no calendar named, no calendar event");
  assert.equal(checkinCalendar("rent reminder"), null);
});

test("a check-in row that names only a calendar runs: it is not cut as having found no email", () => {
  const calendarOnly = conv([{ id: "m1", who: "Check-in", via: "checkin", text: "calendar: dentist moved to 3pm" }]);
  assert.equal(cantRun(calendarOnly, 0), null);
  const nothing = conv([{ id: "m1", who: "Check-in", via: "checkin", text: "rent reminder" }]);
  assert.match(cantRun(nothing, 0), /Gmail|calendar/, "a row naming neither still can't run");
});

test("a calendar-only check-in row goes in as its calendar line, and no mail line", () => {
  const calendarOnly = conv([{ id: "m1", who: "Check-in", via: "checkin", text: "calendar: dentist moved to 3pm" }]);
  const raw = fdTest([unit(calendarOnly, 0)], FRONT);
  assert.doesNotMatch(raw, /check-in mail:/, "no email, so no mail line");
  const q = parseTest(raw).questions[0];
  assert.equal(q.checkinCalendar, "dentist moved to 3pm");
  assert.equal(q.checkinMail, null);
});

test("a check-in row with mail and a calendar line carries each to its own line", () => {
  const both = conv([{ id: "m1", who: "Check-in", via: "checkin", text: "Gmail: TAP: flight delayed. Calendar: Dinner at 7" }]);
  const q = parseTest(fdTest([unit(both, 0)], FRONT)).questions[0];
  assert.deepEqual(q.checkinMail, { from: "TAP", subject: "flight delayed", body: "flight delayed" });
  assert.equal(q.checkinCalendar, "Dinner at 7");
});

test("a calendar write Tex makes is a change row the judge reads; a check or a refusal is not", async () => {
  const flags = { calendarAddress: "john@calendar.example.invalid" };
  const route = createCalendarRoute(async () => true, flags, async () => true);
  const call = (change, check = false) => route.handle("/gateway/calendar/event", { accessToken: "t", change, check });
  await call({ action: "move", title: "House dinner", start: "2026-10-20T19:00:00-04:00" });
  await call({ action: "move", title: "Only checked", start: "2026-10-21T19:00:00-04:00" }, true);
  await call({ action: "create", title: "Dentist", start: "2026-10-21T15:00:00-04:00" });
  await call({ action: "cancel", title: "Old standup" });
  assert.deepEqual(calendarChanges(route.calls), [
    { workspace: "calendar", path: "calendar", kind: "move", detail: 'moved "House dinner" to 2026-10-20T19:00:00-04:00' },
    { workspace: "calendar", path: "calendar", kind: "create", detail: 'added "Dentist" at 2026-10-21T15:00:00-04:00' },
    { workspace: "calendar", path: "calendar", kind: "cancel", detail: 'cancelled "Old standup"' },
  ]);
  assert.deepEqual(calendarChanges([{ change: { action: "move", title: "Refused" }, check: false, answer: { ok: false, refused: "has_guests" } }]), []);
});

test("a check-in's calendar line is an event on its day, added to that day's answer and to no other", async () => {
  const arrived = [{ date: "2026-07-01", text: "Mon standup at 9" }];
  const days = withArrivedEvents(null, arrived, () => "john@calendar.example.invalid");
  const day = await days({ date: "2026-07-01", days: 1 });
  assert.equal(day.ok, true);
  assert.equal(day.days[0].date, "2026-07-01");
  assert.match(day.days[0].text, /Mon standup at 9/);
  assert.equal(day.days[0].address, "john@calendar.example.invalid");
  assert.deepEqual(await days({ date: "2026-07-02", days: 1 }), { ok: true, days: [] });

  const fixture = async () => ({ ok: true, days: [{ address: "john@calendar.example.invalid", date: "2026-07-01", text: "### 10:00–11:00 · Dinner" }] });
  const both = await withArrivedEvents(fixture, arrived, () => null)({ date: "2026-07-01", days: 1 });
  assert.equal(both.days.length, 1, "the fixture's day and the event's are one day");
  assert.match(both.days[0].text, /Dinner/);
  assert.match(both.days[0].text, /Mon standup at 9/);
});
