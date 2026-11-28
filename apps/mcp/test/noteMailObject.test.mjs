// A note's mail read in the workspace object that holds it (`workspaceStore/mailOps.js`; Dev2, 2026-11-06: nothing
// about a note is polled from afar). The footer counts what is new in one call instead of reading the note, and an
// ask's wait is held by the object until the answer lands instead of reading the note every 1.5 seconds.
//
// Sabotage record (applied, run, named test observed failing, reverted; 2026-11-06):
//  1. `judge.sees(row)` in `mailOps.js` `visibleNote` replaced with `true`
//     → "a reader who may not see the note learns nothing of its mail" fails.
//  2. The `objectMail` branch dropped from `mail/footer.js`
//     → "the footer counts new mail in the object, without reading the note" fails.
//  3. `areasHeldBy`'s reader predicate back to `() => true` in `mailRoute.js` (applied, run, reverted; 2026-11-28)
//     → "a bound bot's seat is withheld from a reader who may not see the area that names it" fails, alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { texObjects } from "../../../packages/tex/gateway/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { serveMail, MAIL_OPS } from "../src/workspaceStore/mailOps.js";
import { judgeFor } from "../src/workspaceStore/serve.js";
import { mailFooter } from "../src/mail/footer.js";
import { durableSqlite } from "./durableSqlite.mjs";
import { workspaceFacts } from "../src/workspaceStore/facts.js";
import { botMailWatch } from "../src/workspaceStore/botMail.js";

const NOTE_ID = "0199a000-0000-7000-8000-0000000000a1";
const SECRET_ID = "0199a000-0000-7000-8000-0000000000a2";
const PATH = "1-projects/plan.md";
const SECRET = "2-areas/private.md";
const HELD = { etag: "m.1", accessVersion: 1, folders: [{ prefix: "1-projects", visibility: "team" }, { prefix: "2-areas", visibility: "private" }], notes: [] };

const MAIL = (lines) => `# Plan\n\nThe work.\n\n\`\`\`mail\n${lines.join("\n")}\n\`\`\`\n`;
const JOINED = ["- 2026-11-06T06:00:00.000Z lead (Claude) joined", "- 2026-11-06T06:00:01.000Z builder (Codex) joined"];
const ASK = "- 2026-11-06T06:01:00.000Z lead (Claude) to builder [ask]: Is pricing done?";
const ANSWER = "- 2026-11-06T06:01:30.000Z builder (Codex) to lead: Yes, pricing is done.";

async function world({ home = "object" } = {}) {
  const { sql, transact } = durableSqlite();
  const store = { sql, transact, objects: texObjects(sql), rows: workspaceRows(sql) };
  store.rows.pinWorkspace("ws");
  store.rows.put([
    { id: "f1", path: "1-projects", kind: "folder", at: 1 },
    { id: "f2", path: "2-areas", kind: "folder", at: 1 },
    { id: "r1", noteId: NOTE_ID, path: PATH, kind: "file", at: 1, storageKey: `notes/${NOTE_ID}.md` },
    { id: "r2", noteId: SECRET_ID, path: SECRET, kind: "file", at: 1, storageKey: `notes/${SECRET_ID}.md` },
  ]);
  store.rows.putRules(HELD, "member");
  store.rows.setHome(home);
  store.rows.markBackfilled(1);
  await store.objects.put(`notes/${NOTE_ID}.md`, MAIL([...JOINED, ASK]));
  await store.objects.put(`notes/${SECRET_ID}.md`, MAIL([...JOINED, ASK]));
  const ask = async (op, fields) =>
    await (await serveWorkspaceStore(store, new Request(`https://tex-store.internal/${op}`, { method: "POST", headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) }, body: JSON.stringify({ ...fields, workspaceId: "ws" }) }))).json();
  return { store, ask };
}

const TEAM = { scope: "team", groups: [], audience: "member" };

test("the object says what is new for a mailbox, without the words", async () => {
  const { ask } = await world();
  const answer = await ask(MAIL_OPS.SINCE, { path: PATH, name: "builder", readThrough: null, ...TEAM });
  assert.equal(answer.served, true);
  assert.equal(answer.found, true);
  assert.deepEqual(answer.fresh, [{ at: "2026-11-06T06:01:00.000Z", from: "lead", to: "builder", app: "Claude", mailKind: "ask" }]);
  const read = await ask(MAIL_OPS.SINCE, { path: PATH, name: "builder", readThrough: "2026-11-06T06:01:00.000Z", ...TEAM });
  assert.deepEqual(read.fresh, []);
});

test("a reader who may not see the note learns nothing of its mail", async () => {
  const { ask } = await world();
  assert.deepEqual(await ask(MAIL_OPS.SINCE, { path: SECRET, name: "builder", ...TEAM }), { served: true, found: false });
  assert.deepEqual(await ask(MAIL_OPS.SINCE, { path: "1-projects/none.md", name: "builder", ...TEAM }), { served: true, found: false });
  const waited = await ask(MAIL_OPS.WAIT, { path: SECRET, from: "lead", to: "builder", since: "2026-11-06T06:01:00.000Z", timeoutMs: 0, ...TEAM });
  assert.deepEqual(waited, { served: true, found: false });
});

test("a workspace whose notes are not in its object is not answered here", async () => {
  const { ask } = await world({ home: "dual" });
  assert.deepEqual(await ask(MAIL_OPS.SINCE, { path: PATH, name: "builder", ...TEAM }), { served: false });
});

test("a malformed ask is refused", async () => {
  const { ask } = await world();
  const answer = await ask(MAIL_OPS.SINCE, { path: PATH, name: "Not A Name!", ...TEAM });
  assert.equal(answer.error, "refused");
});

test("an ask's wait is held by the object and ends when the answer lands", async () => {
  const { store } = await world();
  let clock = 0;
  let looks = 0;
  const judge = judgeFor(store.rows, TEAM, null);
  const wait = async (ms) => {
    clock += ms;
    looks += 1;
    // The answer is written while the ask waits, as another agent's send would write it.
    if (looks === 3) await store.objects.put(`notes/${NOTE_ID}.md`, MAIL([...JOINED, ASK, ANSWER]));
  };
  const answer = await serveMail(store, MAIL_OPS.WAIT, { path: PATH, from: "lead", to: "builder", since: "2026-11-06T06:01:00.000Z", timeoutMs: 60_000 }, judge, { now: () => clock, wait });
  assert.equal(answer.found, true);
  assert.equal(answer.answers.length, 1);
  assert.equal(answer.answers[0].text, "Yes, pricing is done.");
  assert.equal(looks, 3, "it answered on the first look after the write");
});

test("a wait with no answer ends at its time, capped at two minutes", async () => {
  const { store } = await world();
  let clock = 0;
  const judge = judgeFor(store.rows, TEAM, null);
  const answer = await serveMail(store, MAIL_OPS.WAIT, { path: PATH, from: "lead", to: "builder", since: "2026-11-06T06:01:00.000Z", timeoutMs: 10 * 60_000 }, judge, { now: () => clock, wait: async (ms) => void (clock += ms) });
  assert.deepEqual(answer, { served: true, found: true, answers: [] });
  assert.equal(clock, 120_000);
});

test("the footer counts new mail in the object, without reading the note", async () => {
  const { ask } = await world();
  const mailbox = { mailboxId: "mb1", workspaceId: "ws", path: PATH, name: "builder", readThrough: null };
  const store = {
    mail: { workspaceId: "ws", get: async () => mailbox },
    objectMail: { since: async (path, name, readThrough) => await ask(MAIL_OPS.SINCE, { path, name, readThrough, ...TEAM }) },
    // Any read of the note fails this test: the object answered.
    get: () => assert.fail("the note was read"),
    getObject: () => assert.fail("the note was read"),
  };
  const line = await mailFooter("mb1", { store, session: { scope: "team" } });
  assert.match(line, /^mail: 1 new for builder in 1-projects\/plan\.md \(1 to you\), from lead\./);
});

// 2026-11-26, Dev: "whenever an mcp call is made it tells you what mail you have, we probably are not showing the right
// mail". Before binding, every bot on one shared connection joined as its app ("cursor"), so one mailbox heard every
// bot's mail. A connection bound as bots hears only a mailbox joined as one of them.
test("the footer reads a bound connection only its own bots' mailboxes", async () => {
  const { ask } = await world();
  const boxes = {
    mb1: { mailboxId: "mb1", workspaceId: "ws", path: PATH, name: "builder", readThrough: null },
    mb2: { mailboxId: "mb2", workspaceId: "ws", path: PATH, name: "cursor", readThrough: null },
  };
  const store = {
    actor: { grantId: "g1" },
    mail: { workspaceId: "ws", get: async (id) => boxes[id] ?? null },
    objectMail: { since: async (path, name, readThrough) => await ask(MAIL_OPS.SINCE, { path, name, readThrough, ...TEAM }) },
    objectReading: { client: { mail: { bound: async () => ({ served: true, bots: [{ bot: "builder", name: "Builder" }, { bot: "reviewer", name: "Reviewer" }] }) } }, home: "object", behind: false, scope: "team", names: [], workspaceId: "ws", userId: "u1" },
  };
  assert.match(await mailFooter("mb1", { store, session: { scope: "team" } }), /^mail: 1 new for builder/);
  const old = await mailFooter("mb2", { store, session: { scope: "team" } });
  assert.match(old, /joined .* as "cursor", which is not a bot this connection is/);
  assert.doesNotMatch(old, /new for/);
});

// A bound bot's seat is a note's path, and `ws.mail.bound` is a session's ask, so it is the reader's own clearance that
// decides whether it is answered. The seat is read from the areas' `about.md` notes, which the object reads whole for
// its own watcher (`mailRoute.js` `areasHeldBy`); an answer handed back to a connection may only name what that
// connection may see.
//
test("a bound bot's seat is withheld from a reader who may not see the area that names it", async () => {
  const { sql, transact } = durableSqlite();
  const store = { sql, transact, objects: texObjects(sql), rows: workspaceRows(sql) };
  store.rows.pinWorkspace("ws");
  const CARD_ID = "0199a000-0000-7000-8000-0000000000b1";
  store.rows.put([
    { id: "a1", path: "areas", kind: "folder", at: 1 },
    { id: "a2", path: "areas/secret", kind: "folder", at: 1 },
    { id: "a3", noteId: CARD_ID, path: "areas/secret/about.md", kind: "file", at: 1, storageKey: `notes/${CARD_ID}.md` },
  ]);
  store.rows.putRules({ etag: "m.1", accessVersion: 1, folders: [{ prefix: "areas", visibility: "team" }, { prefix: "areas/secret", visibility: "private" }], notes: [] }, "member");
  store.rows.setHome("object");
  store.rows.markBackfilled(1);
  await store.objects.put(`notes/${CARD_ID}.md`, '---\nowner: "@kim"\ndelegate: Grok Bot\n---\n\n# Secret\n');
  store.facts = workspaceFacts(sql, store.objects);
  store.botMail = botMailWatch(sql, { rows: store.rows, objects: store.objects, facts: store.facts, tell: () => {}, findAreasRoot: () => "areas", defer: () => {} });

  const bound = async (scope) => (await serveMail(store, MAIL_OPS.BOUND, { grantId: "g1" }, judgeFor(store.rows, { scope, groups: [], audience: "member" }, null))).bots;
  assert.deepEqual((await serveMail(store, MAIL_OPS.BIND, { grantId: "g1", bot: "grok-bot", name: "Grok Bot" }, judgeFor(store.rows, TEAM, null))).ok, true);
  assert.deepEqual(await bound("team"), [{ bot: "grok-bot", name: "Grok Bot" }], "a team reader is told the binding and not the private area that names it");
  assert.deepEqual(await bound("private"), [{ bot: "grok-bot", name: "Grok Bot", seat: "areas/secret" }], "a reader who may see it is told the seat");
});
