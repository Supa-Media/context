import assert from "node:assert/strict";
import { decideRequest, readDecideAnswers, readDecideBody } from "../../../../../packages/tex/src/textDecide.cjs";
import { decideForTexts, TEXTS_DECIDE_PATH } from "../../../../../packages/tex/gateway/agent/textsDecide.js";
import { decide } from "../../../../../packages/tex/worker/decide.ts";
import { keepSticker, keptStickers, stickerId } from "../../../../../packages/tex/worker/stickers.ts";
import { tapback } from "../../../../../packages/tex/worker/stepEvents.ts";
import { MemoryStorage } from "../../../../../packages/tex/worker/memoryStorage.testing.ts";

const id = (n) => `${String(1_700_000_000_000 + n).padStart(13, "0")}-${String(n).padStart(6, "0")}`;
const LINE = "+15555550199";
const PARTY = stickerId("at_0_PARTY-CAT");
const SIDE_EYE = stickerId("at_0_SIDE-EYE");

/** An invented group: a friend stuck a party-cat sticker on Tex's text earlier, and now shares good news nobody asked Tex about. */
const raw = (more = {}) => ({
  chat: "group-fern-desk",
  sender: "+15555550111",
  line: LINE,
  style: "followAlong",
  transcript: [
    `<${id(1)}> @kofi: Tex is the truck booked for saturday`,
    `<${id(2)}> You: Booked, 9am pickup at the depot.`,
    `<${id(3)}> @kofi: sticker ${PARTY} on Tex's message "Booked, 9am pickup at the depot."`,
    `<${id(4)}> @priya: WE SOLD OUT THE WHOLE MENU BY 2`,
  ].join("\n"),
  candidates: [id(4)],
  running: false,
  waitingAsks: [],
  newest: id(4),
  ...more,
});

/** Clef's answers: quiet, react, the party emoji, and a sticker. */
const answers = (sticker, reacts = 0.9) => ({ act: { choice: "quiet", confidence: 0.8 }, also_react: { noul: reacts }, emoji: { choice: "party" }, sticker: { choice: sticker }, why: { choice: "people_talking" } });

export default {
  id: "decide-picks-chat-sticker",
  incident:
    "2026-11-25: Dev2 asked Tex to reuse the stickers people in a chat use, \"mainly for reactions\", and then: \"you don't want someone prompting ai to use stickers. it should just use it in relevant situations\". Training examples for the front door changed nothing: in the Lab, good news and thanks got words, because the front door almost never ends a turn on a tapback (4 of 201 one-to-one turns that week), and Decide, which gives a group's unprompted reactions, could only pick an emoji.",
  cause:
    "Decide is asked one more question when the chat kept stickers: which of them, if any, to stick instead of the emoji. Its answer counts only beside a reaction and only for a sticker this chat was asked with; the Worker sticks it on the text, or sends the emoji where it can't; Decide's \"Chat stickers\" setting off offers none.",
  path: "group text",
  async run() {
    // The chat's kept stickers, newest last, are what the Worker asks with.
    const storage = new MemoryStorage();
    await keepSticker(storage, { emoji: "", sticker: "at_0_SIDE-EYE" }, 1);
    await keepSticker(storage, { emoji: "", sticker: "at_0_PARTY-CAT" }, 2);
    assert.deepEqual(await keptStickers(storage), [SIDE_EYE, PARTY]);

    // Offered: one question naming each kept sticker by id, and "none".
    const body = readDecideBody(raw({ stickers: [SIDE_EYE, PARTY, "not-an-id", "s"] }));
    assert.deepEqual(body.stickers, [SIDE_EYE, PARTY], "only well-formed ids reach the judge");
    const asked = decideRequest(body);
    assert.deepEqual(Object.keys(asked.questions.sticker.criteria).sort(), ["none", PARTY, SIDE_EYE].sort());
    assert.match(asked.questions.sticker.instructions, /instead of the emoji/);
    // A chat that kept none is asked exactly as before.
    assert.equal(decideRequest(readDecideBody(raw())).questions.sticker, undefined);
    // Room is kept for the held-action questions: with 8 waiting asks the sixteenth question is not a sticker.
    const full = decideRequest(readDecideBody(raw({ stickers: [PARTY], running: true, candidates: [id(3), id(4)], waitingAsks: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => id(100 + n)) })));
    assert.ok(Object.keys(full.questions).length <= 16);
    assert.equal(full.questions.sticker, undefined);

    // Read back: the sticker rides beside a reaction, only one the chat was asked with.
    const picked = readDecideAnswers(body, answers(PARTY));
    assert.deepEqual([picked.act, picked.emoji, picked.sticker], ["react", "🎉", PARTY]);
    assert.equal(readDecideAnswers(body, answers("s9zzzzz")).sticker, undefined, "a sticker never offered is dropped");
    assert.equal(readDecideAnswers(body, answers("none")).sticker, undefined);
    assert.equal(readDecideAnswers(body, answers(PARTY, 0.1)).sticker, undefined, "no reaction, no sticker");

    // The gateway's route: offered while Decide's "Chat stickers" is on; off, the question is never asked.
    const request = (more) => new Request(`https://gateway.invalid${TEXTS_DECIDE_PATH}`, { method: "POST", body: JSON.stringify(raw(more)) });
    let seen;
    const engine = async (_state, questions) => ((seen = questions), answers(PARTY));
    const on = await (await decideForTexts(request({ stickers: [PARTY] }), {}, { engine, settings: () => ({ stickers: true }) })).json();
    assert.ok(seen.sticker);
    assert.equal(on.sticker, PARTY);
    const off = await (await decideForTexts(request({ stickers: [PARTY] }), {}, { engine, settings: () => ({ stickers: false }) })).json();
    assert.equal(seen.sticker, undefined, "off: no sticker question");
    assert.equal(off.sticker, undefined);

    // The Worker believes only a sticker it asked with, whatever the gateway answers.
    const gatewayAnswer = (sticker) => ({
      fetch: async () => new Response(JSON.stringify({ ok: true, act: "react", covers: [], stale: [], movedOn: false, confidence: 0.8, emoji: "🎉", sticker })),
      controlPlaneOrigin: "https://control.invalid",
      workerSecret: "test-only",
    });
    const ask = { ...raw(), stickers: [PARTY] };
    assert.equal((await decide(gatewayAnswer(PARTY), ask)).sticker, PARTY);
    assert.equal((await decide(gatewayAnswer("s0ther1"), ask)).sticker, undefined, "a sticker the chat never kept is never stuck");

    // Decide's reaction sticks the kept sticker on the text, and the emoji goes on a line without stickers.
    const stuck = [];
    const sent = await tapback(storage, { chat: "group-fern-desk", now: () => 3, by: "decide", asked: "🎉" }, "WE SOLD OUT", async () => "🎉", { id: PARTY, stick: async (guid) => void stuck.push(guid) });
    assert.equal(sent, `sticker ${PARTY}`);
    assert.deepEqual(stuck, ["at_0_PARTY-CAT"]);
    assert.equal(await tapback(storage, { chat: "group-fern-desk", now: () => 4, by: "decide", asked: "🎉" }, "WE SOLD OUT", async () => "🎉", { id: PARTY, stick: undefined }), "🎉");
  },
};
