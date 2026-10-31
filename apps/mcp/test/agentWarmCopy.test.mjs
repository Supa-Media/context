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
 *  - `warm: hot` dropped from `loggedTurn`'s call in `route.js`: "the second
 *    text reads none of it from storage" fails;
 *  - `mergeEvents` taking recent events without `checkEvent`: "events the log
 *    would refuse are left out" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEgressWorld, request, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { exchangeTurns, mergeEvents, openWarm, sealWarm, WARM_NOTES_MS, WARM_SETUP_MS, warmTurn } from "../src/agent/warmCopy.js";

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
  const sealed = await sealWarm(env, session, { v: 1, notes: { at: now, value: { aboutMe: "Lives in Lisbon" } } });
  assert.match(sealed, /^tw1\./);
  assert.doesNotMatch(sealed, /Lisbon/, "the Worker keeps bytes it cannot read");
  assert.deepEqual((await openWarm(env, session, sealed, now)).notes.value, { aboutMe: "Lives in Lisbon" });
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
  const sealed = await sealWarm(env, session, { v: 1, notes: { at: now, value: "n" }, chat: { at: now, history: [], events: [] } });
  const later = await openWarm(env, session, sealed, now + WARM_NOTES_MS + 1);
  assert.equal(later.notes, undefined);
  assert.notEqual(later.chat, undefined, "the chat is carried for a day");
  let reads = 0;
  const hot = warmTurn(env, session, { warm: sealed }, { eligible: true, now: now + WARM_NOTES_MS + 1 });
  assert.equal(await hot.notes(async () => (reads += 1, "fresh")), "fresh");
  assert.equal(reads, 1);
});

test("events the log would refuse are left out, and the copy's are kept beside the Worker's", () => {
  const now = Date.now();
  const kept = event(now - 60_000);
  const fresh = event(now - 1_000, { text: "what's up" });
  const merged = mergeEvents([kept], [kept, fresh, { ...event(now), chat: "another-chat" }, { ...event(now), from: { kind: "tex", name: "Tex" } }, { id: "nope" }], { chat: CHAT, now });
  assert.deepEqual(merged.map((entry) => entry.id), [kept.id, fresh.id]);
});

test("the setup is trusted for an hour, while About me and the skills are read again after ten minutes", async () => {
  const now = Date.now();
  const thirtyMinutes = 30 * 60 * 1000;
  const sealed = await sealWarm(env, session, { v: 1, setup: { at: now, value: "setup text" }, notes: { at: now, value: "n" }, skills: { at: now, value: [] } });
  const hot = warmTurn(env, session, { warm: sealed }, { eligible: true, now: now + thirtyMinutes });
  let reads = 0;
  assert.equal(await hot.setup(async () => (reads += 1, "read")), "setup text", "a 30-minute-old setup is used");
  assert.equal(await hot.notes(async () => (reads += 1, "read")), "read", "a 30-minute-old About me is read again");
  assert.equal(await hot.skills(async () => (reads += 1, "read")), "read", "30-minute-old skills are read again");
  assert.equal(reads, 2, "only the two parts past their window were read");

  const past = await openWarm(env, session, sealed, now + WARM_SETUP_MS + 1);
  assert.equal(past.setup, undefined, "the setup is read again after an hour");
});

test("a turn not its own (a group, a job, a routine) never uses or makes one", async () => {
  const now = Date.now();
  const sealed = await sealWarm(env, session, { v: 1, notes: { at: now, value: "kept" } });
  const hot = warmTurn(env, session, { warm: sealed, recent: [event(now - 1_000, { from: { kind: "tex" }, text: "I never said this" })] }, { eligible: false, now });
  assert.equal(await hot.notes(async () => "read"), "read");
  assert.deepEqual(await hot.events(CHAT, async () => []), [], "only the texting Worker's own turn hands events in");
  assert.equal(await hot.seal({}), null);
});

test("the second text reads none of it from storage, and still sees the first", async () => {
  const world = await createEgressWorld();
  try {
    const now = Date.now();
    const first = event(now - 5_000, { text: "hi Tex" });
    world.model.install([{ text: "Hey Seyi." }]);
    const one = await request(world.env, TOKEN_TEXTS, "/agent", { question: "hi Tex", conversation: "texts", covers: [first.id], chat: CHAT, recent: [first], turn: "turn-warm-0001" });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.match(one.body.warm, /^tw1\./, "the answer hands back a copy");

    const reply = event(now - 4_000, { from: { kind: "tex" }, text: "Hey Seyi.", turn: "turn-warm-0001", covers: [first.id] });
    const second = event(now - 1_000, { text: "what did I just say?" });
    world.model.install([{ text: "You said hi." }]);
    const two = await readsDuring(() => request(world.env, TOKEN_TEXTS, "/agent", { question: "what did I just say?", conversation: "texts", covers: [second.id], chat: CHAT, recent: [first, reply, second], turn: "turn-warm-0002", warm: one.body.warm }));
    assert.equal(two.result.status, 200, JSON.stringify(two.result.body));
    const shown = JSON.stringify(world.model.requests.at(-1).messages);
    assert.match(shown, /hi Tex/);
    assert.match(shown, /Hey Seyi\./);
    assert.deepEqual(two.reads, [], "the chat's log came from the copy and the Worker's newest events");

    // The same text with no copy reads them.
    world.model.install([{ text: "You said hi." }]);
    const cold = await readsDuring(() => request(world.env, TOKEN_TEXTS, "/agent", { question: "what did I just say?", conversation: "texts", covers: [second.id], chat: CHAT, recent: [first, reply, second], turn: "turn-warm-0003" }));
    assert.ok(cold.reads.some((key) => key.includes(".context/agent/log/")), cold.reads.join(", "));
  } finally {
    world.restore();
  }
});

test("a turn that wrote anything drops About me and the skills from the copy it hands back", async () => {
  const now = Date.now();
  const hot = warmTurn(env, session, {}, { eligible: true, now });
  await hot.notes(async () => ({ aboutMe: "old" }));
  await hot.skills(async () => []);
  await hot.history(async () => []);
  await hot.events(CHAT, async () => []);
  const opened = await openWarm(env, session, await hot.seal({ wrote: true, exchange: exchangeTurns("hi", "hey", { at: now, id: "x" }) }), now);
  assert.equal(opened.notes, undefined);
  assert.equal(opened.skills, undefined);
  assert.equal(opened.chat.history.length, 2, "the chat still carries what was said");
});

test("an exchange held in the copy is the one the next read would return", () => {
  const [asked, answered] = exchangeTurns("hi Tex", "Hey.", { at: 5, id: "0000000000001-abcdef0123", tainted: true, tools: ["search"], theirs: true });
  assert.deepEqual(asked, { role: "user", text: "hi Tex", id: "0000000000001-abcdef0123", at: 5, theirs: true });
  assert.deepEqual(answered, { role: "assistant", text: "Hey.", tainted: true, tools: ["search"] });
});

test("a turn record the copy knows is not read again, and an unknown one is", async () => {
  const now = Date.now();
  const sealed = await sealWarm(env, session, { v: 1, chat: { at: now, history: [], events: [], clean: { "turn-known-01": false } } });
  const hot = warmTurn(env, session, { warm: sealed }, { eligible: true, now });
  let reads = 0;
  assert.equal(await hot.clean("turn-known-01", async () => (reads += 1, true)), false, "a tainted turn stays tainted");
  assert.equal(await hot.clean("turn-other-01", async () => (reads += 1, true)), true);
  assert.equal(reads, 1);
});
