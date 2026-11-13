/**
 * WHAT THIS CHAT HAS READ (one record per chat, part 4; `src/agent/readsIndex.js`): a turn is shown an index of the
 * pages, searches and notes its chat read before, under its own carry key only, and opens any of them whole with
 * `read_back`, which marks the turn as the original read would have.
 *
 * Sabotage (2026-11-13, temporary local edits, reverted; each fails a test here):
 *  - `readable` dropping `entry.grant === grant`: "another grant's read is never listed nor opened";
 *  - `readable` dropping `entry.withheld === undefined`: "a read from another workspace is never listed";
 *  - `read_back` skipping `onRead`, or `markRead` skipping `markUntrusted`: "opening a page counts as reading it";
 *  - `read_back` trusting `open` without checking the id and grant: "an entry swapped under a ref is refused";
 *  - `ledger.read` dropping every slim read's arguments (no `keepArgs`): "a slim read keeps a read's arguments ..." and "a job's part ...";
 *  - `read_back` handing a note back from the ledger (no `reread`): "a note is read again now ...";
 *  - `runTheModel` not offering `read_back`: "a job's part is shown the chat's earlier read and opens it".
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { INDEXED_READS, markRead, MAX_INDEXED_READS, READS_PREFACE, readBackTool, readRef, readsNote, readsOf } from "../src/agent/readsIndex.js";
import { toolEntry } from "../src/agent/ledger.js";
import { texLedger } from "../src/texStore/ledger.js";
import { DESK_LEDGER, READ_ARGS_KEPT } from "../src/texStore/desk.js";
import { durableSql } from "./texStoreFixture.mjs";
import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

const NOW = Date.UTC(2026, 10, 13, 18, 0);
const GRANT = "user1:ws1:read,write";
const read = (name, args, at, extra = {}) => ({ ...toolEntry({ name, args, ok: true, ms: 5, result: `whole result of ${JSON.stringify(args)}` }, { ownSlug: "ada", turn: "turnA", grant: GRANT, at }), ...extra });

test("reads are listed newest first with their source and age, and the stretch's own are left to the stretch", () => {
  const page = read("open_page", { url: "https://example.com/katz" }, NOW - 3 * 3_600_000);
  const note = read("read_note", { path: "trips/lisbon.md" }, NOW - 26 * 3_600_000);
  const fresh = read("search_web", { query: "late dinner midtown" }, NOW - 10 * 60_000);
  const { listed, all } = readsOf([note, page, fresh], { grant: GRANT, before: NOW - 30 * 60_000 });
  assert.deepEqual(listed.map((each) => each.source), ["https://example.com/katz", "trips/lisbon.md"], "the stretch's search is carried whole, so it is not listed");
  assert.equal(all.length, 3, "but read_back can still open it");
  const text = readsNote(listed, { now: NOW });
  assert.ok(text.startsWith(READS_PREFACE));
  assert.match(text, new RegExp(`- ${readRef(page)} · 3 h ago · open_page: https://example\\.com/katz`));
  assert.match(text, /26 h ago · read_note: trips\/lisbon\.md/);
  assert.equal(readsNote([], { now: NOW }), "", "nothing listed, nothing said");
});

test("another grant's read is never listed nor opened, and nor is a failed call", async () => {
  const theirs = read("open_page", { url: "https://example.com/their-bank" }, NOW - 3_600_000, { grant: "user2:ws1:read" });
  const failed = { ...read("open_page", { url: "https://example.com/down" }, NOW - 3_600_000), ok: false };
  const { listed, all } = readsOf([theirs, failed], { grant: GRANT });
  assert.equal(listed.length + all.length, 0);
  const tool = readBackTool({ reads: all, open: async () => theirs });
  const opened = await tool.call({ ref: readRef(theirs) });
  assert.equal(opened.isError, true);
  assert.doesNotMatch(JSON.stringify(opened), /their-bank/);
});

test("a read from another workspace is never listed, and only reads are", () => {
  const other = read("read_note", { path: "secret.md", context: "@other" }, NOW - 3_600_000);
  assert.equal(other.withheld, "other_workspace");
  const write = read("write_note", { path: "todo.md" }, NOW - 3_600_000);
  const mail = read("read_email", { id: "m1" }, NOW - 3_600_000);
  assert.equal(readsOf([other, write, mail], { grant: GRANT }).all.length, 0);
});

test("a note is read again now under the turn's own access, never handed back from the ledger, and a group lists pages only", async () => {
  const note = read("read_note", { path: "health/plan.md" }, NOW - 5 * 3_600_000);
  const page = read("open_page", { url: "https://example.com/menu" }, NOW - 5 * 3_600_000);
  assert.deepEqual(readsOf([note, page], { grant: GRANT, notes: false }).all.map((each) => each.entry.name), ["open_page"], "no note path reaches a room");
  const { all } = readsOf([note], { grant: GRANT });
  const asked = [];
  const now = readBackTool({ reads: all, open: async () => note, reread: async (name, args) => (asked.push([name, args]), { content: [{ type: "text", text: "# Plan, as it is today" }] }) });
  const opened = await now.call({ ref: readRef(note) });
  assert.deepEqual(asked, [["read_note", { path: "health/plan.md" }]]);
  assert.match(opened.content[0].text, /as it is today/);
  assert.doesNotMatch(JSON.stringify(opened), /whole result of/, "never the ledger's old copy");
  const gone = readBackTool({ reads: all, open: async () => note, reread: async () => ({ isError: true, content: [{ type: "text", text: "Not found." }] }) });
  const refused = await gone.call({ ref: readRef(note) });
  assert.equal(refused.isError, true, "a note made private since is refused, as reading it would be");
  assert.doesNotMatch(JSON.stringify(refused), /whole result of/);
});

test(`at most ${MAX_INDEXED_READS} reads are listed`, () => {
  const many = Array.from({ length: MAX_INDEXED_READS + 5 }, (_, i) => read("open_page", { url: `https://example.com/${i}` }, NOW - (i + 1) * 3_600_000));
  assert.equal(readsOf(many, { grant: GRANT }).listed.length, MAX_INDEXED_READS);
});

test("opening a page counts as reading it, and an entry swapped under a ref is refused", async () => {
  const page = read("open_page", { url: "https://example.com/katz" }, NOW - 3 * 3_600_000);
  const { all } = readsOf([{ ...page, result: undefined }], { grant: GRANT });
  const ledger = {};
  const tool = readBackTool({ reads: all, open: async (id) => (id === page.id ? page : null), onRead: (call) => markRead(ledger, call) });
  assert.equal(tool.tool.name, "read_back");
  const opened = await tool.call({ ref: readRef(page) });
  assert.notEqual(opened.isError, true);
  assert.match(opened.content[0].text, /whole result of .*katz/);
  assert.equal(ledger.untrusted, true, "a page is an outsider's words");
  assert.equal(ledger.outside, true);

  const noteLedger = {};
  markRead(noteLedger, { name: "read_note", args: { path: "trips/lisbon.md" }, result: { content: [{ type: "text", text: "# Lisbon" }] } });
  assert.equal(noteLedger.untrusted, undefined, "a note of their own marks nothing, as reading it did not");

  const swapped = readBackTool({ reads: all, open: async () => ({ ...page, id: "somethingelse0000", grant: "user2:ws1:read" }) });
  assert.equal((await swapped.call({ ref: readRef(page) })).isError, true);
  assert.equal((await tool.call({ ref: "rnothere" })).isError, true);
});

test("a slim read keeps a read's arguments and nothing else's, and one entry is read by id with its result", () => {
  assert.deepEqual([...READ_ARGS_KEPT].sort(), [...INDEXED_READS].sort(), "the reads the index lists are the reads whose arguments are kept");
  const ledger = texLedger(durableSql());
  const page = read("open_page", { url: "https://example.com/katz" }, NOW - 3_600_000);
  const write = read("write_note", { path: "todo.md", content: "THE WHOLE NOTE" }, NOW - 3_000_000);
  ledger.append("texts", [page, write]);
  const slim = ledger.read("texts", DESK_LEDGER.options).entries;
  const kept = slim.find((entry) => entry.name === "open_page");
  assert.deepEqual(kept.args, { url: "https://example.com/katz" }, "where the page came from");
  assert.equal(kept.result, undefined, "never what it said");
  const written = slim.find((entry) => entry.name === "write_note");
  assert.equal(written.args, undefined, "a write's arguments carry a note's words: never kept slim");
  const one = ledger.read("texts", { kinds: ["tool"], ids: [page.id], limit: 1 });
  assert.equal(one.entries.length, 1);
  assert.match(one.entries[0].result, /katz/);
  assert.equal(ledger.read("texts", { ids: ["'; DROP TABLE ledger; --"] }).entries.length, 0, "an id that is no id matches nothing");
});

test("a job's part is shown the chat's earlier read and opens it with read_back", async () => {
  const world = await createEgressWorld();
  try {
    const CHAT = "sendblue:line:+15555550100";
    const asked = { id: `${Date.now() - 60_000}-000001`, at: Date.now() - 60_000, chat: CHAT, from: { kind: "person" }, kind: "text", text: "what does fifth say?" };
    assert.equal((await request(world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [asked] })).status, 200);
    world.model.install([{ toolCalls: [{ name: "read_note", args: { path: "2-areas/fifth.md" } }] }, { text: "Fifth is a short note." }]);
    const one = await request(world.env, TOKEN_TEXTS, "/agent", { question: asked.text, conversation: "texts", covers: [asked.id], chat: CHAT, recent: [asked], turn: "turn-reads-0001" });
    assert.equal(one.status, 200, JSON.stringify(one.body));

    let ref = null;
    world.model.install([
      (body) => {
        const shown = JSON.stringify(body);
        ref = shown.match(/- (r[A-Za-z0-9]{1,10}) · [^·]+ · read_note: 2-areas\/fifth\.md/)?.[1] ?? null;
        return { toolCalls: [{ name: "read_back", args: { ref: ref ?? "none" } }] };
      },
      { text: "Fifth says it is a short note." },
    ]);
    const job = { id: "job-reads-00001", title: "Fifth", brief: "Summarise fifth", attempt: 1, followUps: [] };
    const part = await request(world.env, TOKEN_TEXTS, "/agent", { question: "summarise fifth", conversation: "texts", job });
    assert.equal(part.status, 200, JSON.stringify(part.body));
    assert.ok(ref !== null, "the part is shown the earlier read in its index");
    const last = JSON.stringify(world.model.requests.at(-1).messages);
    assert.match(last, /# Fifth/, "and read_back hands it the note as it was read");
  } finally {
    world.restore();
  }
});
