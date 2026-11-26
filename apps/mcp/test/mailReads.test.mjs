// Read receipts: the object's table (`workspaceStore/mailReads.js`) and the gateway's AI reads (`mail/reads.js`).
// Sabotage, confirmed (applied, run, named case failing, reverted):
//  1. The upsert made a plain INSERT → "one reader is one row, its newest read" fails.
//  2. The mail check dropped from `countAiMailRead` → "an AI read of a note without mail keeps nothing" fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { hasMailBlock, mailReads } from "../src/workspaceStore/mailReads.js";
import { mailBots } from "../src/workspaceStore/mailBots.js";
import { MAIL_OPS, serveMail } from "../src/workspaceStore/mailOps.js";
import { HOMES } from "../src/workspaceStore/api.js";
import { countAiMailRead, countPersonMailRead } from "../src/mail/reads.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}
const skip = DatabaseSync === null ? "node:sqlite is not in this Node" : false;

function sqlOf() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...binds) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

test("only a real mail block counts as mail", () => {
  assert.equal(hasMailBlock("# A\n\n```mail\n- x\n```\n"), true);
  assert.equal(hasMailBlock("Says ```mail in passing.\n"), false);
  assert.equal(hasMailBlock(null), false);
});

test("one reader is one row, its newest read, newest reader first", { skip }, () => {
  let clock = 1_000;
  const reads = mailReads(sqlOf(), { now: () => clock });
  assert.equal(reads.record("n1", { reader: "person:u1", name: "@seyi", by: "person" }), true);
  clock = 2_000;
  assert.equal(reads.record("n1", { reader: "ai:u1:c1", name: "@seyi", by: "ai", clientName: "Claude Code" }), true);
  clock = 3_000;
  reads.record("n1", { reader: "person:u1", name: "@seyi", by: "person" });
  assert.deepEqual(reads.of("n1"), [
    { name: "@seyi", by: "person", clientName: null, at: new Date(3_000).toISOString() },
    { name: "@seyi", by: "ai", clientName: "Claude Code", at: new Date(2_000).toISOString() },
  ]);
  assert.deepEqual(reads.of("n2"), []);
});

test("a malformed read is refused, never kept", { skip }, () => {
  const reads = mailReads(sqlOf());
  assert.equal(reads.record("n1", { reader: "person:u1", by: "person" }), false, "a person is named");
  assert.equal(reads.record("n1", { reader: "x", by: "robot" }), false);
  assert.equal(reads.record("n1", { reader: "x", by: "ai", name: "not a handle" }), false);
  assert.deepEqual(reads.of("n1"), []);
});

test("a workspace keeps which bot each connection is, one row per connection", { skip }, () => {
  const bots = mailBots(sqlOf(), { now: () => 1000 });
  assert.equal(bots.of("g1"), null);
  assert.deepEqual(bots.bind("g1", { bot: "grok-bot", name: "Grok Bot" }), { ok: true });
  assert.deepEqual(bots.of("g1"), { bot: "grok-bot", name: "Grok Bot" });
  assert.deepEqual(bots.bind("g1", { bot: "pipeline", name: "Pipeline" }), { ok: true });
  assert.deepEqual(bots.of("g1"), { bot: "pipeline", name: "Pipeline" });
  assert.equal(bots.of("g2"), null);
  assert.ok(bots.bind("g2", { bot: "Not A Slug", name: "x" }).error);
  assert.ok(bots.bind("g2", { bot: "ok", name: "" }).error);
});

test("the object binds and answers a connection's bot, with no note named", { skip }, async () => {
  const store = { sql: sqlOf(), rows: { home: () => HOMES.OBJECT }, objects: { get: () => null } };
  const judge = { sees: () => false };
  assert.deepEqual(await serveMail(store, MAIL_OPS.BOUND, { grantId: "g1" }, judge), { served: true, bound: null });
  assert.deepEqual(await serveMail(store, MAIL_OPS.BIND, { grantId: "g1", bot: "grok-bot", name: "Grok Bot" }, judge), { served: true, ok: true });
  assert.deepEqual(await serveMail(store, MAIL_OPS.BOUND, { grantId: "g1" }, judge), { served: true, bound: { bot: "grok-bot", name: "Grok Bot" } });
  // A workspace whose notes are not here keeps no bots.
  assert.deepEqual(await serveMail({ ...store, rows: { home: () => "bucket" } }, MAIL_OPS.BOUND, { grantId: "g1" }, judge), { served: false });
});

/** A store whose object keeps what is recorded. */
function storeOf(actor = { userId: "u1", clientId: "c1", clientName: "Claude Code", name: "@seyi" }) {
  const kept = [];
  const deferred = [];
  return {
    kept,
    deferred,
    store: {
      actor,
      defer: (work) => deferred.push(work),
      objectReading: { client: { mail: { read: async (fields) => kept.push(fields) } }, home: "object", behind: false, scope: "team", names: [], workspaceId: "w1", userId: "u1" },
    },
  };
}
const answer = (text) => ({ content: [{ type: "text", text }] });

test("an AI read of a note with mail is that client's receipt, for the person whose client it is", async () => {
  const { store, kept, deferred } = storeOf();
  countAiMailRead("read_note", { path: "bots/grok/mail/seyi.md" }, store, answer("# Mail\n\n```mail\n- 2026-11-26T00:00:00.000Z @seyi to everyone: yo\n```\n"));
  await Promise.all(deferred);
  assert.equal(kept.length, 1);
  assert.deepEqual({ path: kept[0].path, by: kept[0].by, reader: kept[0].reader, name: kept[0].name, clientName: kept[0].clientName }, { path: "bots/grok/mail/seyi.md", by: "ai", reader: "ai:u1:c1", name: "@seyi", clientName: "Claude Code" });
  assert.equal(kept[0].scope, "team", "judged as a read is");
});

test("a bound bot's login reads as the bot, not as the app it connects through", async () => {
  // Dev, 2026-11-26: "things still showing as read by cursor".
  const { store, kept, deferred } = storeOf();
  store.objectReading.client.mail.bound = async ({ grantId }) => ({ served: true, bound: grantId === "g1" ? { bot: "grok-bot", name: "Grok Bot" } : null });
  store.actor.grantId = "g1";
  countAiMailRead("read_note", { path: "bots/grok/mail/seyi.md" }, store, answer("# Mail\n\n```mail\n- 2026-11-26T00:00:00.000Z @seyi to everyone: yo\n```\n"));
  await Promise.all(deferred);
  assert.equal(kept[0].clientName, "Grok Bot");
});

test("an AI read of a note without mail keeps nothing, nor a failed read", async () => {
  const { store, kept, deferred } = storeOf();
  countAiMailRead("read_note", { path: "todo.md" }, store, answer("# Todo\n"));
  countAiMailRead("read_note", { path: "a.md" }, store, { isError: true, content: [{ type: "text", text: "```mail\n" }] });
  countAiMailRead("search", { query: "x" }, store, answer("```mail\n"));
  await Promise.all(deferred);
  assert.deepEqual(kept, []);
});

test("reading a note's mail by itself is a read of it", async () => {
  const { store, kept, deferred } = storeOf();
  countAiMailRead("read_note", { path: "plan.md", mail: { read: true } }, store, answer("3 messages"));
  await Promise.all(deferred);
  assert.equal(kept.length, 1);
});

test("a person's open of a note with mail is their receipt; never without a handle", async () => {
  const { store, kept, deferred } = storeOf();
  countPersonMailRead(store, "plan.md", { userId: "u1", name: "@seyi", text: "```mail\n- x\n```\n" });
  countPersonMailRead(store, "plan.md", { userId: "u1", name: null, text: "```mail\n- x\n```\n" });
  countPersonMailRead(store, "todo.md", { userId: "u1", name: "@seyi", text: "# Todo\n" });
  await Promise.all(deferred);
  assert.deepEqual(kept.map((fields) => [fields.path, fields.reader, fields.name]), [["plan.md", "person:u1", "@seyi"]]);
});

test("a store whose notes are not in an object keeps nothing and never throws", () => {
  const { store, kept } = storeOf();
  store.objectReading.home = "bucket";
  countAiMailRead("read_note", { path: "plan.md" }, store, answer("```mail\n"));
  assert.deepEqual(kept, []);
});
