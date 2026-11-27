/**
 * A login bound as a bot shows in "agents active" as the bot, not as the app it connects through (Dev, 2026-11-27:
 * "all grokbots still show up as cursor even though they are registered bots, can we instead show them as their bot
 * name?"). `src/live/agentActivity.js` asks `mail/boundBot.js` which bots the grant is here.
 *
 * Sabotage: dropping the bound-bot lookup from `recordAgentActivity` fails the first two checks; dropping the bot from
 * the activity id fails the third (two bots on one connection collapse into one row).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordAgentActivity } from "../src/live/agentActivity.js";

/** A store whose activity room keeps what it is told, and whose object says which bots grant `g1` is. */
function storeOf(bots) {
  const posted = [];
  const deferred = [];
  const rooms = {
    idFromName: (name) => name,
    get: () => ({ fetch: async (_url, init) => posted.push(JSON.parse(init.body)) }),
  };
  const store = {
    actor: { workspaceId: "w1", grantId: "g1", clientId: "cursor", client: "Cursor", name: "@seyi", userId: "u1" },
    presenceRooms: rooms,
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
  assert.equal(posted[0].actor.name, "Dorothy");
  assert.equal(posted[1].actor.name, "@seyi's Cursor", "no guess between two bots");
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
