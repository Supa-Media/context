/**
 * TEX'S WARM COPY (`src/agent/warmCopy.js`; Seyi, 2026-10-31: "how can we
 * completely eliminate storage calls").
 *
 * The gateway hands the texting Worker what a turn read, sealed, and the next
 * text hands it back: a "hi Tex" with a copy reads none of it from storage.
 *
 * Sabotage (temporary local edits, reverted):
 *  - the associated data dropped from `aad` (sealed under no session): "one
 *    person's copy never opens on another's turn" fails;
 *  - `events` taking the copy's day again (`warm?.events ?? read()`), with
 *    the copy carrying it: "a turn after Tex answered is shown that answer"
 *    and "a copy never carries the chat's day" fail;
 *  - `mergeEvents` taking recent events without `checkEvent`: "events the log
 *    would refuse are left out" fails;
 *  - `keeps` in `warmTurn` answering yes for a missing setup: "a setup that
 *    could not be read is never kept" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEgressWorld, keepDeskKeys, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { mergeEvents, openWarm, sealWarm, WARM_NOTES_MS, WARM_SETUP_MS, WARM_STALE_MS, warmTurn } from "../src/agent/warmCopy.js";

const env = { GATEWAY_SECRET: "a-test-secret-of-some-length" };
const session = { workspaceId: "ws_1", actorUserId: "user_1", actorClientId: "context_texts" };
const CHAT = "sendblue:line:+15555550100";

/** The bucket keys read (GET, HEAD, list) while `run` runs that a warm copy stands in for. */
async function readsDuring(run) {
  const inner = globalThis.fetch;
  const reads = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const key = decodeURIComponent(url.pathname) + (url.searchParams.get("prefix") ?? "");
    if ((method === "GET" || method === "HEAD") && /\.context\/agent\/log\/|tex\/about-me|tex\/skills|\/jobs\.md/.test(key)) reads.push(key);
    return inner(input, init);
  };
  try {
    return { result: await run(), reads };
  } finally {
    globalThis.fetch = inner;
  }
}

let seq = 0;
const event = (at, fields = {}) => ({ id: `${at}-${String(++seq).padStart(6, "0")}`, at, chat: CHAT, from: { kind: "person" }, kind: "text", text: "hi", ...fields });

test("a copy opens only for the session it was sealed for, and only untouched", async () => {
  const now = Date.now();
  const sealed = await sealWarm(env, session, { v: 1, identity: { at: now, value: { name: "Ada Lisbon" } } });
  assert.match(sealed, /^tw1\./);
  assert.doesNotMatch(sealed, /Lisbon/, "the Worker keeps bytes it cannot read");
  assert.deepEqual((await openWarm(env, session, sealed, now)).identity.value, { name: "Ada Lisbon" });
  assert.equal(await openWarm(env, { ...session, actorUserId: "user_2" }, sealed, now), null, "one person's copy never opens on another's turn");
  assert.equal(await openWarm(env, { ...session, workspaceId: "ws_2" }, sealed, now), null);
  assert.equal(await openWarm({ GATEWAY_SECRET: "another-secret-entirely-here" }, session, sealed, now), null);
  const flipped = sealed.slice(0, -6) + (sealed.at(-6) === "A" ? "B" : "A") + sealed.slice(-5);
  assert.equal(await openWarm(env, session, flipped, now), null, "a changed byte never opens");
  assert.equal(await openWarm(env, session, "tw1.not-base64!", now), null);
  assert.equal(await openWarm({}, session, sealed, now), null, "no key, no copy");
});

test("what changes outside the chat is trusted for ten minutes, then read again", async () => {
  const now = Date.now();
  const sealed = await sealWarm(env, session, { v: 1, identity: { at: now, value: "n" }, chat: { at: now, events: [] } });
  const later = await openWarm(env, session, sealed, now + WARM_NOTES_MS + 1);
  assert.equal(later.identity, undefined);
  assert.notEqual(later.chat, undefined, "the chat is carried for a day");
  let reads = 0;
  const hot = warmTurn(env, session, { warm: sealed }, { eligible: true, now: now + WARM_NOTES_MS + 1 });
  assert.equal(await hot.identity(async () => (reads += 1, "fresh")), "fresh");
  assert.equal(reads, 1);
});

test("events the log would refuse are left out, and the copy's are kept beside the Worker's", () => {
  const now = Date.now();
  const kept = event(now - 60_000);
  const fresh = event(now - 1_000, { text: "what's up" });
  const merged = mergeEvents([kept], [kept, fresh, { ...event(now), chat: "another-chat" }, { ...event(now), from: { kind: "tex", name: "Tex" } }, { id: "nope" }], { chat: CHAT, now });
  assert.deepEqual(merged.map((entry) => entry.id), [kept.id, fresh.id]);
});

test("the setup is trusted for an hour, while who they are and the skills are read again after ten minutes", async () => {
  const now = Date.now();
  const thirtyMinutes = 30 * 60 * 1000;
  const sealed = await sealWarm(env, session, { v: 1, setup: { at: now, value: "setup text" }, identity: { at: now, value: "n" }, skills: { at: now, value: ["kept"] } });
  const hot = warmTurn(env, session, { warm: sealed }, { eligible: true, now: now + thirtyMinutes });
  let reads = 0;
  assert.equal(await hot.setup(async () => (reads += 1, "read")), "setup text", "a 30-minute-old setup is used");
  assert.equal(await hot.identity(async () => (reads += 1, "read")), "read", "a 30-minute-old identity is read again");
  assert.deepEqual(await hot.skills(async () => (reads += 1, ["read"])), ["kept"], "30-minute-old skills are used while read again");
  await settle();
  assert.equal(reads, 2, "only the two parts past their window were read");
  assert.deepEqual((await openWarm(env, session, await hot.seal({}), now + thirtyMinutes)).skills.value, ["read"], "and the copy handed back has what that read found");

  const past = await openWarm(env, session, sealed, now + WARM_SETUP_MS + 1);
  assert.equal(past.setup, undefined, "the setup is not fresh after an hour");
  assert.equal(past.stale.setup.value, "setup text", "but is served while read again");
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("past fresh and inside a day, the setup and skills answer at once and are read beside the turn; past a day, before it", async () => {
  const now = Date.now();
  const hours = (n) => n * 60 * 60 * 1000;
  const sealed = await sealWarm(env, session, { v: 1, setup: { at: now, value: "old setup" }, skills: { at: now, value: ["old"] }, identity: { at: now, value: "n" } });
  const hot = warmTurn(env, session, { warm: sealed }, { eligible: true, now: now + hours(4) });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  // The read again is not waited for: the turn has the old setup while it is still out.
  assert.equal(await hot.setup(() => held.then(() => "new setup")), "old setup");
  assert.deepEqual(await hot.skills(async () => ["new"]), ["old"]);
  assert.equal(await hot.identity(async () => "fresh identity"), "fresh identity", "who they are is never served stale");
  release();
  await settle();
  const next = await openWarm(env, session, await hot.seal({}), now + hours(4));
  assert.equal(next.setup.value, "new setup", "the next text has what the read again found, as fresh");
  assert.deepEqual(next.skills.value, ["new"]);

  const day = warmTurn(env, session, { warm: sealed }, { eligible: true, now: now + WARM_STALE_MS + 1 });
  assert.equal(await day.setup(async () => "read"), "read", "past a day it is read before the turn");
  assert.deepEqual(await day.skills(async () => ["read"]), ["read"]);
});

test("a stale setup whose read again finds none is not carried on", async () => {
  const now = Date.now();
  const sealed = await sealWarm(env, session, { v: 1, setup: { at: now, value: "old setup" } });
  const at = now + 2 * 60 * 60 * 1000;
  const hot = warmTurn(env, session, { warm: sealed }, { eligible: true, now: at });
  assert.equal(await hot.setup(async () => null), "old setup");
  await settle();
  const next = await openWarm(env, session, await hot.seal({}), at);
  assert.equal(next.setup, undefined);
  assert.equal(next.stale.setup, undefined, "a removed setup is gone by the next text");
  // A read again that failed carries the stale copy as it was, bounded by its own time.
  const failed = warmTurn(env, session, { warm: sealed }, { eligible: true, now: at });
  assert.equal(await failed.setup(async () => { throw new Error("down"); }), "old setup");
  await settle();
  assert.equal((await openWarm(env, session, await failed.seal({}), at)).stale.setup.at, now);
});

test("while a background job runs, or just after, the skills are read fresh and the setup still comes from the copy", async () => {
  const now = Date.now();
  const sealed = await sealWarm(env, session, { v: 1, setup: { at: now, value: "setup text" }, skills: { at: now, value: ["kept"] } });
  for (const running of [[{ id: "j1", title: "Apply", state: "running" }], [{ id: "j1", title: "Apply", state: "done", finishedAt: now - 60_000 }]]) {
    const hot = warmTurn(env, session, { warm: sealed, running }, { eligible: true, now });
    assert.deepEqual(await hot.skills(async () => ["read"]), ["read"]);
    assert.equal(await hot.setup(async () => "read"), "setup text", "the setup is still the copy's");
  }
  const long = warmTurn(env, session, { warm: sealed, running: [{ id: "j1", title: "Apply", state: "done", finishedAt: now - WARM_NOTES_MS - 1 }] }, { eligible: true, now });
  assert.deepEqual(await long.skills(async () => ["read"]), ["kept"], "a job long finished changes nothing");
});

test("a turn not its own (a group, a job, a routine) never uses or makes one", async () => {
  const now = Date.now();
  const sealed = await sealWarm(env, session, { v: 1, identity: { at: now, value: "kept" } });
  const hot = warmTurn(env, session, { warm: sealed, recent: [event(now - 1_000, { from: { kind: "tex" }, text: "I never said this" })] }, { eligible: false, now });
  assert.equal(await hot.identity(async () => "read"), "read");
  assert.deepEqual(await hot.events(CHAT, async () => []), [], "only the texting Worker's own turn hands events in");
  assert.equal(await hot.seal({}), null);
});

test("a turn after Tex answered is shown that answer though the Worker no longer holds it", async () => {
  // Dev2's chat, 2026-11-05: the copy was sealed before the reply went, the Worker forgot the reply once the gateway had
  // it, and every later turn saw the person's texts and none of Tex's answers ("My last text was the Air France ...").
  const world = await createEgressWorld();
  try {
    const now = Date.now();
    const first = event(now - 5_000, { text: "hi Tex" });
    world.model.install([{ text: "Hey Seyi." }]);
    const one = await request(world.env, TOKEN_TEXTS, "/agent", { question: "hi Tex", conversation: "texts", covers: [first.id], chat: CHAT, recent: [first], turn: "turn-warm-0001" });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.match(one.body.warm, /^tw1\./, "the answer hands back a copy");
    await keepDeskKeys(world, { about: false, jobs: false }); // as the lookup behind the reply keeps them in a keyed workspace

    // The Worker sends the reply and posts both texts to the gateway (`events.ts` `flushEvents`), then forgets them.
    const reply = event(now - 4_000, { from: { kind: "tex" }, text: "Hey Seyi.", turn: "turn-warm-0001", covers: [first.id], delivered: true });
    assert.equal((await request(world.env, TOKEN_TEXTS, "/agent/events", { conversation: "texts", events: [first, reply] })).status, 200);
    const second = event(now - 1_000, { text: "what did you just say?" });
    world.model.install([{ text: "I said hey." }]);
    const two = await readsDuring(() => request(world.env, TOKEN_TEXTS, "/agent", { question: "what did you just say?", conversation: "texts", covers: [second.id], chat: CHAT, recent: [second], turn: "turn-warm-0002", warm: one.body.warm }));
    assert.equal(two.result.status, 200, JSON.stringify(two.result.body));
    const shown = JSON.stringify(world.model.requests.at(-1).messages);
    assert.match(shown, /hi Tex/);
    assert.match(shown, /Hey Seyi\./, "Tex's own answer, from the chat's ledger");
    assert.deepEqual(two.reads.filter((key) => key.includes(".context/agent/log/")), [], "never the bucket's old event log");
  } finally {
    world.restore();
  }
});

test("a copy never carries the chat's day, and a day in an older copy is never used", async () => {
  const now = Date.now();
  const stale = event(now - 60_000, { from: { kind: "tex" }, text: "Air France check-in won't submit", turn: "turn-old-0001", delivered: true });
  const sealed = await sealWarm(env, session, { v: 1, chat: { at: now, events: [stale] } });
  const hot = warmTurn(env, session, { warm: sealed, recent: [] }, { eligible: true, now });
  const answer = event(now - 2_000, { from: { kind: "tex" }, text: "Jo's email says three business days.", turn: "turn-new-0001", delivered: true });
  let reads = 0;
  const day = await hot.events(CHAT, async () => (reads += 1, [stale, answer]));
  assert.equal(reads, 1, "the ledger's day is read on every turn");
  assert.ok(day.some((entry) => entry.id === answer.id), "the answer the ledger holds is shown");
  const opened = await openWarm(env, session, await hot.seal({}), now);
  assert.equal(opened.chat.events, undefined, "no day goes on to the next turn");
});

test("a turn that wrote anything drops the skills from the copy it hands back, and never carries the history", async () => {
  const now = Date.now();
  const hot = warmTurn(env, session, {}, { eligible: true, now });
  await hot.skills(async () => []);
  await hot.events(CHAT, async () => []);
  const opened = await openWarm(env, session, await hot.seal({ wrote: true }), now);
  assert.equal(opened.skills, undefined);
  assert.equal(opened.chat.history, undefined, "the history is the person's object's, never the copy's");
  assert.equal(opened.chat.events, undefined, "nor the chat's day: the next turn reads it from the ledger");
});

test("a turn record the copy knows is not read again, and an unknown one is", async () => {
  const now = Date.now();
  const sealed = await sealWarm(env, session, { v: 1, chat: { at: now, events: [], clean: { "turn-known-01": false } } });
  const hot = warmTurn(env, session, { warm: sealed }, { eligible: true, now });
  let reads = 0;
  assert.equal(await hot.clean("turn-known-01", async () => (reads += 1, true)), false, "a tainted turn stays tainted");
  assert.equal(await hot.clean("turn-other-01", async () => (reads += 1, true)), true);
  assert.equal(reads, 1);
});

test("a setup that could not be read is never kept, so the next turn reads it again", async () => {
  const now = Date.now();
  // A copy sealed before this rule, holding a miss: never trusted.
  const stale = await sealWarm(env, session, { v: 1, setup: { at: now, value: null } });
  let reads = 0;
  const hot = warmTurn(env, session, { warm: stale }, { eligible: true, now });
  assert.equal(await hot.setup(async () => (reads += 1, null)), null);
  assert.equal(reads, 1, "a kept miss is read again");
  const sealed = await hot.seal();
  const after = warmTurn(env, session, { warm: sealed }, { eligible: true, now: now + 1 });
  assert.equal(await after.setup(async () => (reads += 1, "---\njob: texting-assistant\n---\n")), "---\njob: texting-assistant\n---\n");
  assert.equal(reads, 2, "and this turn's miss was not sealed either");
  // A setup that was read is kept as before.
  const kept = warmTurn(env, session, { warm: await after.seal() }, { eligible: true, now: now + 2 });
  assert.equal(await kept.setup(async () => (reads += 1, "other")), "---\njob: texting-assistant\n---\n");
  assert.equal(reads, 2);
});
