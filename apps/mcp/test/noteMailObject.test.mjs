// A note's mail read in the workspace object that holds it (`workspaceStore/mailOps.js`; Dev2, 2026-11-06: nothing
// about a note is polled from afar). The footer counts what is new in one call instead of reading the note, and an
// ask's wait is held by the object until the answer lands instead of reading the note every 1.5 seconds.
//
// Sabotage record (applied, run, named test observed failing, reverted; 2026-11-06):
//  1. `judge.sees(row)` in `mailOps.js` `visibleNote` replaced with `true`
//     → "a reader who may not see the note learns nothing of its mail" fails.
//  2. The `objectMail` branch dropped from `mail/footer.js`
//     → "the footer counts new mail in the object, without reading the note" fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { texObjects } from "../src/texStore/objects.js";
import { workspaceRows } from "../src/workspaceStore/rows.js";
import { serveWorkspaceStore } from "../src/workspaceStore/serve.js";
import { serveMail, MAIL_OPS } from "../src/workspaceStore/mailOps.js";
import { judgeFor } from "../src/workspaceStore/serve.js";
import { mailFooter } from "../src/mail/footer.js";
import { durableSqlite } from "./durableSqlite.mjs";

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
