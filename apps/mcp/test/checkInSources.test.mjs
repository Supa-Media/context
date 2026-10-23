/**
 * What a check-in reads beyond notes and Gmail (`src/agent/checkInSources.js`):
 * today's calendar, live, and the Slack messages written to them since the
 * last look. Neither ever fails a look.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-10-23):
 *  1. `newSlackSince` keeping their own messages → "only what others wrote to them" fails.
 *  2. `hasEvents` always true → "an empty day is shown but wakes no look" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SLACK_SHOWN, calendarSection, chatSection, newChatSince, newSlackSince, slackQueries, slackSection, todaysCalendar } from "../src/agent/checkInSources.js";

function storeWith(name, value) {
  const store = {};
  Object.defineProperty(store, name, { value, enumerable: false });
  return store;
}

const SINCE = Date.UTC(2026, 9, 22, 18, 0, 0);
const ts = (ms) => `${Math.floor(ms / 1000)}.000100`;

function slackStore(matchesFor, calls = []) {
  return storeWith("connectors", {
    call: async (request) => {
      calls.push(request);
      if (request.method === "auth.test") return { ok: true, team: "Acme", body: { ok: true, user_id: "U0ME" } };
      if (request.method === "search.messages") return { ok: true, team: "Acme", body: { ok: true, matches: matchesFor(request.args.query) } };
      return { ok: false, refused: "method_not_allowed" };
    },
  });
}

test("Slack is searched for DMs and mentions of their own id, from the day before the last look", () => {
  assert.deepEqual(slackQueries("U0ME", SINCE), ["to:me after:2026-10-21", "<@U0ME> after:2026-10-21"]);
});

test("a check-in is shown only what others wrote to them since the last look, newest first, once each", async () => {
  const calls = [];
  const dm = { channel_id: "D0AMY", channel: "U0AMY", from: "amy", user: "U0AMY", ts: ts(SINCE + 60_000), text: "Any luck on the venue search?" };
  const mention = { channel_id: "C0GEN", channel: "#events", from: "jo", user: "U0JO", ts: ts(SINCE + 120_000), text: "@Dev can you confirm the date?" };
  const mine = { channel_id: "D0AMY", channel: "U0AMY", from: "dev", user: "U0ME", ts: ts(SINCE + 180_000), text: "on it" };
  const old = { channel_id: "D0AMY", channel: "U0AMY", from: "amy", user: "U0AMY", ts: ts(SINCE - 60_000), text: "yesterday's" };
  const store = slackStore((query) => (query.startsWith("to:me") ? [mine, dm, old] : [mention, dm]), calls);
  const found = await newSlackSince(store, SINCE);
  assert.equal(found.length, 2);
  assert.match(found[0].line, /in #events · from jo\n {4}@Dev can you confirm the date\?/);
  assert.match(found[1].line, /a direct message · from amy\n {4}Any luck on the venue search\?/);
  assert.ok(found.every((entry) => !entry.line.includes("on it") && !entry.line.includes("yesterday's")));
  assert.deepEqual(calls.map((call) => call.method), ["auth.test", "search.messages", "search.messages"]);
  assert.match(slackSection(found), /a stranger's words/);
});

test("at most a handful of Slack messages are shown", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ channel_id: "D0X", from: "x", user: "U0X", ts: ts(SINCE + (i + 1) * 1000), text: `m${i}` }));
  assert.equal((await newSlackSince(slackStore(() => many), SINCE)).length, MAX_SLACK_SHOWN);
});

test("no Slack, a refusal or a throw is an empty list, never a failed look", async () => {
  assert.deepEqual(await newSlackSince({}, SINCE), []);
  assert.deepEqual(await newSlackSince(storeWith("connectors", { call: async () => ({ ok: false, refused: "not_connected" }) }), SINCE), []);
  assert.deepEqual(await newSlackSince(storeWith("connectors", { call: async () => { throw new Error("down"); } }), SINCE), []);
  assert.equal(slackSection([]), "");
});

test("today's calendar is read live for their own day, and an empty day is shown but wakes no look", async () => {
  const asked = [];
  const calendar = (text) =>
    storeWith("calendar", { days: async (request) => (asked.push(request), { ok: true, days: [{ address: "me@example.invalid", date: request.date, text }] }) });
  // 02:30 UTC on the 23rd is still the 22nd in New York.
  const now = Date.UTC(2026, 9, 23, 2, 30);
  const busy = await todaysCalendar(calendar("---\nkind: calendar\n---\n# Calendar · 2026-10-22\n\n## 7:00 pm · Dinner with Sam\n"), now, "America/New_York");
  assert.deepEqual(asked[0], { date: "2026-10-22", days: 1 });
  assert.equal(busy.events, true);
  assert.ok(!busy.text.includes("kind: calendar"));
  assert.match(calendarSection(busy, now, "America/New_York"), /today's calendar \(2026-10-22\).*whoever sent the invite.*Dinner with Sam/s);
  const empty = await todaysCalendar(calendar("# Calendar · 2026-10-22\n\n_(no events)_\n"), now, "America/New_York");
  assert.equal(empty.events, false);
  assert.equal(await todaysCalendar({}, now, "UTC"), null);
  assert.equal(await todaysCalendar(storeWith("calendar", { days: async () => ({ ok: false, refused: "no_calendar" }) }), now, "UTC"), null);
  assert.equal(calendarSection(null, now, "UTC"), "");
});

test("Google Chat written to them is shown by place and sender, and nothing breaks a look", async () => {
  const asked = [];
  const store = storeWith("googleChat", {
    recent: async (request) => (
      asked.push(request),
      {
        ok: true,
        messages: [
          { id: "spaces/DM1/messages/m1", type: "DIRECT_MESSAGE", space: "", from: "Amy", at: "2026-10-23T12:00:00Z", text: "Any luck on the venue search?" },
          { id: "spaces/AAA/messages/a1", type: "SPACE", space: "Venue planning", from: "", at: "2026-10-23T10:30:00Z", text: "@Dev can you confirm?" },
        ],
      }
    ),
  });
  const found = await newChatSince(store, SINCE);
  assert.deepEqual(asked, [{ since: SINCE }]);
  assert.match(found[0].line, /^- chat:spaces\/DM1\/messages\/m1 · 2026-10-23 12:00 UTC · a direct message · from Amy\n {4}Any luck/);
  assert.match(found[1].line, /in Venue planning · from someone/);
  assert.match(chatSection(found), /Google Chat.*a stranger's words/s);
  assert.deepEqual(await newChatSince({}, SINCE), []);
  assert.deepEqual(await newChatSince(storeWith("googleChat", { recent: async () => ({ ok: false, refused: "no_chat" }) }), SINCE), []);
  assert.deepEqual(await newChatSince(storeWith("googleChat", { recent: async () => { throw new Error("down"); } }), SINCE), []);
  assert.equal(chatSection([]), "");
});
