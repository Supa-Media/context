/**
 * TEX'S HISTORY AND ABOUT ME ARE ONE COPY, IN THE PERSON'S TEX OBJECT (the
 * owner, 2026-11-01, repeated many times: "ONE copy only, in the durable
 * object, for 1:1 AND groups", no expiry, no second copy anywhere, and a
 * texted turn never reads them from storage; `src/agent/history.js`,
 * `src/agent/texDesk.js`, `src/texStore/desk.js`).
 *
 * This file is the guard. It fails when:
 *  - a texted turn reads (or writes) the history or the turn bookkeeping in
 *    the bucket: `.context/agent/{events,conversations,history,turns,running,
 *    cancel,steer}/`, apart from the one move-in of a person who has no
 *    record yet (the migration makes everyone's first);
 *  - the history, About me or the jobs list comes from anywhere but one call
 *    to the person's object (the desk) before the model;
 *  - the copy handed to the texting Worker (`warm`) carries the history,
 *    About me or the jobs list, or one sealed before this change is used for
 *    them;
 *  - a writer (a job's report, a routine, the Worker's fixed text) does not
 *    reach the one record the next text reads.
 *
 * Sabotage record (2026-11-01, temporary local edits, reverted; each fails a test here):
 *  - `isAgentHomeKey` answering false (bookkeeping back in the bucket): "a texted turn never touches ...";
 *  - `readHistory` ignoring the desk (`openDesk` returning null): "... in one desk call";
 *  - `deskTexts` answering {} (About me read as a note again): "About me and the jobs list come from the desk";
 *  - `openWarm` passing `copy.chat` whole: "a copy sealed before ... is never used for the history".
 * 2026-11-02: `readDesk` ignoring `DESK_KEYS_KEY`: "About me and the jobs list come from the desk ..." and "the desk reads the note keys ...".
 * 2026-11-02: `copiedIn` answering false (the record written beside a copied-in ledger): "a texted turn never touches ...".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEgressWorld, request, TOKEN_ROUTINE, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { openWarm, sealWarm, warmTurn } from "../src/agent/warmCopy.js";
import { TOLD } from "../src/agent/conversation.js";
import { deskEligible, learnDeskKeys } from "../src/agent/texDesk.js";
import { DESK_KEYS, HISTORY_KEY } from "../src/agent/history.js";
import { readDesk } from "../src/texStore/desk.js";
import { isAgentHomeKey, TexStoreUnavailable, withTexRouting } from "../src/store/texRouting.js";
import { R2Store } from "../src/store/r2.js";
import { texStoreStub, texBucket } from "../src/texStore/wire.js";

const CHAT = "sendblue:line:+15555550100";
const PERSON = "person:ws_egress";
const BOOKKEEPING = /\.context\/agent\/(events|conversations|history|turns|running|cancel|steer)(\/|$)/;
const ABOUT_ID = "01900000-0000-7000-8000-00000000a001";
const JOBS_ID = "01900000-0000-7000-8000-00000000a002";

let seq = 0;
const event = (at, fields = {}) => ({ id: `${at}-${String(++seq).padStart(6, "0")}`, at, chat: CHAT, from: { kind: "person" }, kind: "text", text: "hi", ...fields });

/** Every bucket request the turn makes to Tex's bookkeeping, and the person's object calls before its model. */
async function watched(world, run) {
  const bucket = [];
  const asked = world.model.requests.length;
  const fromCall = world.tex.calls.length;
  let objectBeforeModel = null;
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.host.startsWith("gateway.ai") && objectBeforeModel === null) objectBeforeModel = world.tex.calls.slice(fromCall);
    const key = decodeURIComponent(url.pathname) + (url.searchParams.get("prefix") ?? "");
    if (BOOKKEEPING.test(key)) bucket.push(`${init.method ?? "GET"} ${key}`);
    return inner(input, init);
  };
  try {
    const result = await run();
    return { result, bucket, before: (objectBeforeModel ?? world.tex.calls.slice(fromCall)).filter((call) => call.name === PERSON), asked: world.model.requests.length > asked };
  } finally {
    globalThis.fetch = inner;
  }
}

/** The person's object, as the gateway reaches it. */
const personObject = (world) => new R2Store(texBucket(texStoreStub(world.env, { person: PERSON.slice("person:".length) })));

async function record(world) {
  const held = await personObject(world).get("state/agent/history/texts.json");
  return held === null ? null : JSON.parse(await held.text());
}

test("a texted turn never touches the bucket for its history or bookkeeping, and every writer reaches the one record", async () => {
  const world = await createEgressWorld();
  try {
    const now = Date.now();
    const first = event(now - 9_000, { text: "hi Tex" });
    world.model.install([{ text: "Hey Seyi." }]);
    // The Worker posts each text both ways to the chat's ledger (`/agent/events`), as it does beside every turn.
    const posted = async (events) => assert.equal((await request(world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events })).status, 200);
    await posted([first]);
    const one = await watched(world, () => request(world.env, TOKEN_TEXTS, "/agent", { question: "hi Tex", conversation: "texts", covers: [first.id], chat: CHAT, recent: [first], turn: "turn-copy-0001" }));
    assert.equal(one.result.status, 200, JSON.stringify(one.result.body));
    // Their chat's past is copied into the ledger (`ledgerBackfill.js`) after the Worker's post, so the turn reads the ledger:
    // no old copy is moved in and no history record is made (`conversation.js` `appendConversation`).
    assert.deepEqual(one.bucket, [], "nothing of the old copies is read");
    assert.equal(await record(world), null, "and no history record is made: the ledger is the one copy");
    await posted([event(Date.now(), { from: { kind: "tex" }, text: "Hey Seyi.", turn: "turn-copy-0001", covers: [first.id], delivered: true })]);

    // A job reports to the chat's own turn.
    world.model.install([{ text: "Your application is drafted." }]);
    const report = await watched(world, () => request(world.env, TOKEN_TEXTS, "/agent", { question: "", conversation: "texts", event: "job_report", jobReport: { title: "Application", state: "done", texts: ["Drafted every answer."] }, chat: CHAT, recent: [first], turn: "turn-copy-0002", warm: one.result.body.warm }));
    assert.equal(report.result.status, 200, JSON.stringify(report.result.body));
    assert.deepEqual(report.bucket, []);

    // A routine texts them.
    world.model.install([{ text: "Nothing changed since yesterday." }]);
    const routine = await watched(world, () => request(world.env, TOKEN_ROUTINE, "/agent", { routine: { path: "routines/daily/brief.md" } }));
    assert.equal(routine.result.status, 200, JSON.stringify(routine.result.body));
    assert.deepEqual(routine.bucket, []);
    assert.equal(routine.result.body.beside, undefined, "nothing is handed to the Worker to carry beside a copy");

    // Their next text, with a fixed text the Worker sent meanwhile.
    // Named by no event, so the turn is shown the history itself (`loggedTurn.js`).
    world.model.install([{ text: "That it's drafted." }]);
    const two = await watched(world, () => request(world.env, TOKEN_TEXTS, "/agent", { question: "what did you say?", conversation: "texts", turn: "turn-copy-0003", warm: report.result.body.warm, told: ["setup"] }));
    assert.equal(two.result.status, 200, JSON.stringify(two.result.body));
    assert.deepEqual(two.bucket, [], "the warm turn: nothing of the history or the bookkeeping in the bucket");
    assert.equal(two.before.filter((call) => call.op === "desk").length, 1, "the history, About me and the jobs list come in one desk call");
    assert.equal(two.before.filter((call) => call.op === "get" && String(call.key).startsWith("state/agent/history/")).length, 0, "and the record is not read again before the model");
    const shown = JSON.stringify(world.model.requests.at(-1));
    assert.match(shown, /Hey Seyi\./);
    assert.match(shown, /Nothing changed since yesterday\./, "the routine's text reached the record the next text read");
    assert.ok(shown.includes(TOLD.setup.slice(0, 40)), "the Worker's fixed text too");

    assert.equal(await record(world), null, "still no history record");
    const ledger = JSON.stringify(await texBucket(texStoreStub(world.env, { person: PERSON.slice("person:".length) })).ledgerRead("texts"));
    for (const said of ["hi Tex", "Hey Seyi.", "Nothing changed since yesterday.", "That it's drafted."]) assert.ok(ledger.includes(said), `${said} is in the one record, the chat's ledger`);
    const inBucket = [...world.bucket.keys()].filter((key) => BOOKKEEPING.test(key));
    assert.deepEqual(inBucket, [], "the bucket holds none of it");
  } finally {
    world.restore();
  }
});

test("About me and the jobs list come from the desk, by the keys kept beside the record, with no note read", async () => {
  const world = await createEgressWorld();
  try {
    world.model.install([{ text: "Hey." }]);
    const one = await request(world.env, TOKEN_TEXTS, "/agent", { question: "hi", conversation: "texts", turn: "turn-desk-0001" });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    const object = personObject(world);
    await object.put(`notes/${ABOUT_ID}.md`, "- Prefers mornings\n- ABOUT-MARKER-7731\n");
    await object.put(`notes/${JOBS_ID}.md`, "- [Visa](@egress/1-projects/visa.md) JOBS-MARKER-4410\n");
    // The keys sit beside the record, in their own key (`history.js` `keepDeskKeys`): the record is retired, they are not.
    await object.put("state/agent/history/desk.json", JSON.stringify({ v: 1, direct: { about: `notes/${ABOUT_ID}.md`, jobs: `notes/${JOBS_ID}.md` } }));

    world.model.install([{ text: "Morning it is." }]);
    const noteReads = [];
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const url = decodeURIComponent(new URL(typeof input === "string" ? input : input.url).pathname);
      if (url.includes("tex/about-me.md") || url.includes("tex/jobs.md")) noteReads.push(url);
      return inner(input, init);
    };
    let two;
    try {
      two = await request(world.env, TOKEN_TEXTS, "/agent", { question: "when should we meet", conversation: "texts", turn: "turn-desk-0002", warm: one.body.warm });
    } finally {
      globalThis.fetch = inner;
    }
    assert.equal(two.status, 200, JSON.stringify(two.body));
    const shown = JSON.stringify(world.model.requests.at(-1));
    assert.match(shown, /ABOUT-MARKER-7731/, "About me is in the prompt");
    assert.match(shown, /JOBS-MARKER-4410/, "and the jobs list");
    assert.deepEqual(noteReads, [], "neither was read as a note (no bucket read, no tree lookup)");

    // The copy handed back holds neither, nor the history.
    const opened = await openWarm(world.env, { workspaceId: "ws_egress", actorUserId: "user_egress", actorClientId: "context_texts" }, two.body.warm);
    const sealed = JSON.stringify(opened ?? {});
    assert.doesNotMatch(sealed, /ABOUT-MARKER|JOBS-MARKER|when should we meet|Morning it is/, "no Worker-side copy of About me, the jobs list or the history");
  } finally {
    world.restore();
  }
});

test("a copy sealed before the change is never used for the history or About me", async () => {
  const env = { GATEWAY_SECRET: "a-test-secret-of-some-length" };
  const session = { workspaceId: "ws_1", actorUserId: "user_1", actorClientId: "context_texts" };
  const now = Date.now();
  const old = await sealWarm(env, session, { v: 1, notes: { at: now, value: { aboutMe: "OLD-ABOUT" } }, chat: { at: now, history: [{ role: "user", text: "OLD-HISTORY" }], events: [], clean: {} } });
  const opened = await openWarm(env, session, old, now);
  assert.equal(opened.notes, undefined);
  assert.equal(opened.chat, undefined);
  const hot = warmTurn(env, session, { warm: old }, { eligible: true, now });
  assert.equal(hot.history, undefined, "the warm copy has no history to offer");
  assert.equal(hot.notes, undefined, "nor About me");
  assert.doesNotMatch(JSON.stringify(await openWarm(env, session, await hot.seal({}), now)), /OLD-ABOUT|OLD-HISTORY/, "and it never carries them on");
});

test("the bookkeeping keys go to the person's object and fail closed without it; nothing near them does", async () => {
  for (const key of [".context/agent/history/texts.json", ".context/agent/turns/turn-abcd1234.json", ".context/agent/running/turn-abcd1234.json", ".context/agent/cancel/turn-abcd1234.json", ".context/agent/steer/turn-abcd1234/1-x.json"]) assert.equal(isAgentHomeKey(key), true, key);
  for (const key of [".context/agent/turns/../x.json", ".context/agent/turns/", ".context/agent/events/x.json", "x/.context/agent/turns/a.json", ".context/agent/turns//a.json", ".context/agent/turns/.hidden"]) assert.equal(isAgentHomeKey(key), false, key);
  const bucketKeys = [];
  const bucket = { get: async (key) => (bucketKeys.push(key), null), put: async (key) => (bucketKeys.push(key), {}), list: async () => ({ objects: [] }) };
  const store = withTexRouting(bucket, { workspaceId: "ws_1", texStore: () => null });
  await assert.rejects(store.get(HISTORY_KEY), TexStoreUnavailable);
  await assert.rejects(store.put(".context/agent/turns/turn-abcd1234.json", "{}"), TexStoreUnavailable);
  await assert.rejects(store.list({ prefix: ".context/agent/turns/" }), TexStoreUnavailable);
  assert.deepEqual(bucketKeys, [], "never looked for in the bucket");
});

test("the desk only keeps keys of notes in this person's own object, and only for their own connection", async () => {
  const kept = [];
  const store = {
    contexts: [{ current: true, kind: "personal", role: "owner", tier: "private" }],
    keysAt: async () => ({ "tex/about-me.md": `tex/person:ws_other/notes/${ABOUT_ID}.md`, "tex/jobs.md": `tex/person:ws_1/notes/${JOBS_ID}.md` }),
    get: async () => ({ etag: "e1", text: async () => JSON.stringify({ v: 1, turns: [] }) }),
    put: async (key, body) => (kept.push({ key, ...JSON.parse(body) }), {}),
  };
  await learnDeskKeys(store, "ws_1");
  assert.deepEqual(kept.at(-1).direct, { jobs: `notes/${JOBS_ID}.md` }, "another workspace's object is never named");
  assert.equal(kept.at(-1).key, DESK_KEYS, "kept in their own key, never the history record");
  assert.equal(kept.at(-1).turns, undefined);
  for (const current of [{ kind: "shared", role: "owner", tier: "private" }, { kind: "personal", role: "editor", tier: "team" }, { kind: "personal", role: "owner", tier: "team" }]) {
    assert.equal(deskEligible({ contexts: [{ current: true, ...current }] }), false, JSON.stringify(current));
  }
  assert.equal(deskEligible(store), true);
});

test("the desk reads the note keys kept by themselves, and an older record's own until those are written", () => {
  const body = (value) => ({ etag: "e", body: new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)) });
  const objectsOf = (held) => ({ get: (key) => held[key] ?? null });
  const about = `notes/${ABOUT_ID}.md`;
  const jobs = `notes/${JOBS_ID}.md`;
  const notes = { [about]: body("ABOUT"), [jobs]: body("JOBS") };
  const old = readDesk(objectsOf({ ...notes, "state/agent/history/texts.json": body({ v: 1, turns: [], direct: { about } }) }));
  assert.equal(old.notes.about.text, "ABOUT", "an older record's keys");
  const own = readDesk(objectsOf({ ...notes, "state/agent/history/texts.json": body({ v: 1, turns: [], direct: { about } }), "state/agent/history/desk.json": body({ v: 1, direct: { jobs } }) }));
  assert.deepEqual(Object.keys(own.notes), ["jobs"], "the keys kept by themselves win");
  const none = readDesk(objectsOf({ ...notes, "state/agent/history/desk.json": body({ v: 1, direct: { about, jobs } }) }));
  assert.equal(none.history, null);
  assert.equal(none.notes.jobs.text, "JOBS", "with no record at all");
});
