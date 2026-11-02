/**
 * `/cards/` (`src/http/cards.js`): the person's own inbox and busy times, as
 * data for a card's page in Messages, answered only to the card key's client.
 * Driven through the worker, as the Messages extension reaches it.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `handleCards` accepting any client → "an MCP client, or the app's
 *     console, cannot read a card's data" fails.
 *  2. `cards` dropped from `RESERVED_FIRST_SEGMENTS` → "the inbox answers the
 *     card key with the newest mail, as data" fails: the path reads as a
 *     workspace called `cards` at the capture route.
 *  3. A busy block's title passed through → "the week is busy times only,
 *     merged across calendars, for the days asked" fails.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createEgressWorld, request, TOKEN_MCP, TOKEN_CONSOLE } from "./agentEgressFixtures.mjs";

const TOKEN_CARDS = `cat_egress_cards_${"0".repeat(22)}`;
const TOKEN_CARDS_READONLY = `cat_egress_cards_ro_${"0".repeat(19)}`;

let world;

before(async () => {
  world = await createEgressWorld();
  const { controlPlane } = world;
  await controlPlane.addGrant({
    accessToken: TOKEN_CARDS,
    workspaceId: "ws_egress",
    role: "owner",
    scopes: ["context:read", "context:private"],
    clientId: "context_cards",
    clientName: "Context cards in Messages",
    userId: "user_egress",
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_CARDS_READONLY,
    workspaceId: "ws_egress",
    role: "owner",
    scopes: ["context:capture"],
    clientId: "context_cards",
    userId: "user_egress",
  });
  controlPlane.flags.mailboxes = [{ address: "me@example.invalid", folder: "0-inbox/email" }];
  controlPlane.flags.mailResults = (query) => [
    {
      address: "me@example.invalid",
      id: "18c0ffee",
      date: "2026-10-28T10:00:00.000Z",
      from: "Acme <ap@acme.example>",
      subject: `Invoice 1042 overdue ${query}`,
      snippet: "Please pay <b>now</b>",
    },
  ];
  controlPlane.flags.calendarDays = (body) => ({
    ok: true,
    days: [
      { address: "me@example.invalid", date: body.date, events: 2, allDay: 1, text: "## Secret dinner", busy: [{ start: "2026-10-30T23:00:00Z", end: "2026-10-31T01:00:00Z", title: "Secret dinner" }] },
      { address: "work@example.invalid", date: body.date, events: 1, allDay: 0, text: "", busy: [{ start: "2026-10-30T13:00:00Z", end: "2026-10-30T13:30:00Z" }, { start: "bad", end: "worse" }] },
      { address: "me@example.invalid", date: "2026-11-30", events: 1, busy: [{ start: "2026-11-30T13:00:00Z", end: "2026-11-30T14:00:00Z" }] },
    ],
  });
});
after(() => world.restore());

test("the inbox answers the card key with the newest mail, as data", async () => {
  const asked = await request(world.env, TOKEN_CARDS, "/cards/inbox", undefined, "GET");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.ok, true);
  assert.equal(asked.body.messages.length, 1);
  assert.deepEqual(Object.keys(asked.body.messages[0]).sort(), ["address", "date", "from", "id", "snippet", "subject"]);
  assert.match(asked.body.messages[0].subject, /in:inbox newer_than:14d$/);
  const call = world.controlPlane.mailReadCalls.at(-1);
  assert.equal(call.path, "/gateway/email/search");
  assert.equal(call.body.expectedWorkspaceId, "ws_egress");

  const unread = await request(world.env, TOKEN_CARDS, "/cards/inbox?view=unread", undefined, "GET");
  assert.match(unread.body.messages[0].subject, /is:unread/);
  const odd = await request(world.env, TOKEN_CARDS, "/cards/inbox?view=from:boss", undefined, "GET");
  assert.equal(odd.status, 400, "a page picks a view, never writes the query");
});

test("the week is busy times only, merged across calendars, for the days asked", async () => {
  const asked = await request(world.env, TOKEN_CARDS, "/cards/week?from=2026-10-30&days=2", undefined, "GET");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.deepEqual(asked.body.days, [
    {
      date: "2026-10-30",
      busy: [
        { start: "2026-10-30T13:00:00.000Z", end: "2026-10-30T13:30:00.000Z" },
        { start: "2026-10-30T23:00:00.000Z", end: "2026-10-31T01:00:00.000Z" },
      ],
      allDay: 1,
    },
    { date: "2026-10-31", busy: [], allDay: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(asked.body), /Secret dinner/);
  for (const bad of ["from=2026-02-30", "from=tomorrow", "from=2026-10-30&days=8", "from=2026-10-30&days=0", "from=2026-10-30&days=1.5"]) {
    const refused = await request(world.env, TOKEN_CARDS, `/cards/week?${bad}`, undefined, "GET");
    assert.equal(refused.status, 400, bad);
  }
});

test("an MCP client, or the app's console, cannot read a card's data", async () => {
  for (const token of [TOKEN_MCP, TOKEN_CONSOLE]) {
    for (const path of ["/cards/inbox", "/cards/week"]) {
      const asked = await request(world.env, token, path, undefined, "GET");
      assert.equal(asked.status, 403, `${path} ${JSON.stringify(asked.body)}`);
    }
  }
});

test("a card key without read gets nothing, and a card route takes GET only", async () => {
  const noRead = await request(world.env, TOKEN_CARDS_READONLY, "/cards/inbox", undefined, "GET");
  assert.equal(noRead.status, 403);
  const posted = await request(world.env, TOKEN_CARDS, "/cards/inbox", {});
  assert.equal(posted.status, 405);
  const nobody = await request(world.env, "cat_nobody_000000000000000000000000000", "/cards/inbox", undefined, "GET");
  assert.equal(nobody.status, 401);
});

test("Google not answering is a refusal, never an empty inbox", async () => {
  world.controlPlane.flags.mailRefusal = "unavailable";
  try {
    const asked = await request(world.env, TOKEN_CARDS, "/cards/inbox", undefined, "GET");
    assert.deepEqual([asked.body.ok, asked.body.refused], [false, "unavailable"]);
  } finally {
    world.controlPlane.flags.mailRefusal = null;
  }
});
