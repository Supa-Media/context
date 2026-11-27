/**
 * A login bound as a bot shows in "agents active" as the bot, not as the app it connects through (Dev, 2026-11-27:
 * "all grokbots still show up as cursor even though they are registered bots, can we instead show them as their bot
 * name?"). `src/live/agentActivity.js` asks `mail/boundBot.js` which bots the grant is here.
 *
 * Sabotage: dropping the bound-bot lookup from `recordAgentActivity` fails the first two checks; dropping the bot from
 * the activity id fails the third (two bots on one connection collapse into one row); dropping the short name fails
 * three; dropping the `works_in` fallback fails one; the caret named by `presenceActor` again fails the last.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordAgentActivity } from "../src/live/agentActivity.js";
import { announceCommittedToPresence, announceWriteToPresence } from "../src/live/presence.js";
import { writerActor } from "../src/live/activityBot.js";

/** A store whose activity room keeps what it is told, and whose object says which bots grant `g1` is. */
function storeOf(bots, { cards = {}, mailboxes = {} } = {}) {
  const posted = [];
  const deferred = [];
  const rooms = {
    idFromName: (name) => name,
    get: () => ({ fetch: async (_url, init) => posted.push(JSON.parse(init.body)) }),
  };
  const store = {
    actor: { workspaceId: "w1", grantId: "g1", clientId: "cursor", client: "Cursor", name: "@seyi", userId: "u1" },
    presenceRooms: rooms,
    mail: { get: async (id) => mailboxes[id] ?? null },
    // Each card's front matter, as the tree's facts answer it.
    treeFacts: async ({ ask, paths }) =>
      ask === "jobs"
        ? { served: true, jobs: { areas: "areas" }, roots: ["areas", "bots"] }
        : { served: true, props: paths.filter((path) => cards[path]).map((path) => ({ path, props: JSON.stringify({ properties: cards[path] }) })) },
    defer: (work) => deferred.push(work),
    objectReading: {
      client: { mail: { bound: async ({ grantId }) => ({ served: true, bots: grantId === "g1" ? bots : [] }) } },
      home: "object",
      behind: false,
      scope: "team",
      names: [],
      workspaceId: "w1",
      userId: "u1",
    },
  };
  return { store, posted, settle: () => Promise.all(deferred) };
}

test("a login bound as one bot shows as that bot wherever it works", async () => {
  const { store, posted, settle } = storeOf([{ bot: "grok-bot", name: "Grok Bot" }]);
  recordAgentActivity(store, [{ kind: "read", path: "areas/operations/delaware-annual-tax.md" }]);
  await settle();
  assert.equal(posted[0].actor.name, "Grok Bot");
});

test("a login bound as several bots shows as the one whose folder it works in, else as the app", async () => {
  const bots = [{ bot: "beth", name: "Beth" }, { bot: "dorothy", name: "Dorothy" }];
  const { store, posted, settle } = storeOf(bots);
  recordAgentActivity(store, [{ kind: "edit", path: "bots/dorothy/notes.md" }]);
  recordAgentActivity(store, [{ kind: "read", path: "todo.md" }]);
  await settle();
  const byPath = Object.fromEntries(posted.map((one) => [one.entries[0].path, one.actor.name]));
  assert.equal(byPath["bots/dorothy/notes.md"], "Dorothy");
  assert.equal(byPath["todo.md"], "@seyi's Cursor", "no guess between two bots");
});

test("two bots on one connection are two rows, and an unbound login stays the app", async () => {
  const { store, posted, settle } = storeOf([{ bot: "beth", name: "Beth" }, { bot: "dorothy", name: "Dorothy" }]);
  recordAgentActivity(store, [{ kind: "read", path: "bots/beth/a.md" }]);
  recordAgentActivity(store, [{ kind: "read", path: "bots/dorothy/a.md" }]);
  await settle();
  assert.notEqual(posted[0].actor.id, posted[1].actor.id);

  const plain = storeOf([]);
  recordAgentActivity(plain.store, [{ kind: "read", path: "todo.md" }]);
  await plain.settle();
  assert.equal(plain.posted[0].actor.name, "@seyi's Cursor");
});

test("a bot's long card name shows as its short name", async () => {
  const { store, posted, settle } = storeOf([{ bot: "pablo", name: "Pablo · Social Strategist & SEO/AEO Visibility Lead" }]);
  recordAgentActivity(store, [{ kind: "read", path: "areas/growth/SEO/plan.md" }]);
  await settle();
  assert.equal(posted[0].actor.name, "Pablo");
});

test("one connection that is several bots shows as the bot its mailbox joined as, else the one whose card works there", async () => {
  // Sayo's bots share one Grok connector (Dev, 2026-11-27: "simply Pablo").
  const bots = [
    { bot: "pablo", name: "Pablo · Social Strategist" },
    { bot: "beth", name: "Beth" },
    { bot: "dorothy", name: "Dorothy" },
  ];
  const cards = {
    "bots/pablo/about.md": { kind: "agent", works_in: ["areas/growth/Socials", "areas/growth/SEO"] },
    "bots/beth/about.md": { kind: "agent", works_in: ["areas/growth/Socials/supaseyi"] },
    "bots/dorothy/about.md": { kind: "agent", works_in: ["areas/growth/Socials/contextdotlc"] },
  };
  const mailboxes = { mb1: { name: "dorothy", path: "bots/dorothy/mail/pablo.md" }, mb2: { name: "somebody-else" } };
  const { store, posted, settle } = storeOf(bots, { cards, mailboxes });
  recordAgentActivity(store, [{ kind: "read", path: "todo.md" }], { mailbox: "mb1" });
  recordAgentActivity(store, [{ kind: "read", path: "areas/growth/SEO/plan.md" }]);
  recordAgentActivity(store, [{ kind: "edit", path: "areas/growth/Socials/supaseyi/drafts.md" }], { mailbox: "mb2" });
  recordAgentActivity(store, [{ kind: "read", path: "areas/operations/x.md" }]);
  await settle();
  // Keyed by note: each call's lookup finishes in its own time.
  assert.deepEqual(
    Object.fromEntries(posted.map((one) => [one.entries[0].path, one.actor.name])),
    {
      "todo.md": "Dorothy",
      "areas/growth/SEO/plan.md": "Pablo",
      "areas/growth/Socials/supaseyi/drafts.md": "Beth",
      "areas/operations/x.md": "@seyi's Cursor",
    },
    "mailbox first, then the deepest works_in; a mailbox that is not one of its bots is ignored; nowhere, the app",
  );
});

test("a bot's write names the bot on the note's live caret, by the same rule", async () => {
  // Dev, 2026-11-27: the caret on a note being written shows the bot's name too.
  const { store, settle } = storeOf([{ bot: "pablo", name: "Pablo · Social Strategist" }]);
  const sent = [];
  store.presenceRooms = { idFromName: (name) => name, get: () => ({ fetch: async (url, init) => sent.push([url, JSON.parse(init.body)]) }) };
  const writer = writerActor(store, { path: "areas/growth/SEO/plan.md" });
  await announceCommittedToPresence(store, "areas/growth/SEO/plan.md", { documentId: "doc", etag: "c2.doc.1" }, writer);
  await announceWriteToPresence(store, { path: "areas/growth/SEO/plan.md", content: "x", etag: "e1", actor: writer });
  await settle();
  assert.deepEqual(sent.map(([url, body]) => [new URL(url).pathname, body.actor?.name]), [["/committed", "Pablo"], ["/external", "Pablo"]]);
  assert.match(sent[0][1].actor.id, /^[0-9a-f]{16}$/, "the caret keeps the client's own id");

  const plain = storeOf([]);
  assert.equal((await writerActor(plain.store, { path: "todo.md" })).name, "@seyi's Cursor");
});
