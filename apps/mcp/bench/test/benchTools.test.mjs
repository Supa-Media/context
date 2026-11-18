/**
 * THE BENCH'S OWN STAND-INS MUST LET TEX'S TOOLS WORK (Training run of 2026-11-18: a card that "couldn't be drawn", a
 * settings change that "couldn't be done", rows that read "Tex: " with nothing). Each test here reproduces one of those
 * with a scripted model, in the bench's world, and proves the tool works there now, or that the bench's failure is
 * said as the bench's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { createWorld } from "../world.mjs";
import { saidLine } from "../run.mjs";
import { benchFailed } from "../setsFd.mjs";
import { FAILS_NO_TOOL, benchGaps, isRouteGap, watchedBinding } from "../benchGaps.mjs";
import { applyChange, createTexCommands } from "../texCommands.mjs";
import { drawnPictures, keepsRenders, looksPastDrawn } from "../drawnPictures.mjs";
import { createSimWorld, simMemo } from "../simWorld.mjs";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "../../test/controlPlaneStub.mjs";

const SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

const bench = {
  people: [
    { person: "Maya", workspace: "maya", role: "owner", personal: true },
    { person: "Maya", workspace: "crew", role: "owner", personal: false },
    { person: "Priya", workspace: "priya", role: "owner", personal: true },
    { person: "Priya", workspace: "crew", role: "editor", personal: false },
  ],
  workspaces: {
    maya: { files: { "todo.md": "- nothing\n" }, heldBack: [] },
    priya: { files: { "todo.md": "- nothing\n" }, heldBack: [] },
    crew: { files: { "index.md": "# Crew\n" }, heldBack: [] },
  },
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const usage = { input_tokens: 10, output_tokens: 5 };

/**
 * A model that calls one tool once, then says what came back. `look` answers the card check's own call (the picture
 * it is shown), and `seen` keeps every request it was sent.
 */
function callsOnce(name, input, { look = null, seen = [] } = {}) {
  return async (_url, init) => {
    seen.push(init.body);
    if (init.body.includes("TEX'S PICTURE (")) return json({ content: [{ type: "text", text: JSON.stringify(look ?? { send: true, critique: "" }) }], stop_reason: "end_turn", usage });
    const body = JSON.parse(init.body);
    // The judge that checks a lasting change was asked for in the person's own words (`privacy/judge.js`): it was.
    if ((body.tools ?? []).some((tool) => tool.name === "verdict")) return json({ content: [{ type: "tool_use", id: "toolu_v", name: "verdict", input: { allow: true, reason: "they asked" } }], stop_reason: "tool_use", usage });
    const last = body.messages.at(-1);
    const result = Array.isArray(last?.content) ? last.content.find((block) => block.type === "tool_result") : null;
    if (!result) return json({ content: [{ type: "tool_use", id: "toolu_1", name, input }], stop_reason: "tool_use", usage });
    const words = (Array.isArray(result.content) ? result.content : [{ type: "text", text: String(result.content) }]).filter((part) => part.type === "text").map((part) => part.text).join(" ");
    return json({ content: [{ type: "text", text: `${result.is_error ? "FAILED" : "WORKED"}: ${words}`.slice(0, 600) }], stop_reason: "end_turn", usage });
  };
}

test("a settings change works in the bench: how Tex talks is saved in a group chat, said with who set it, and recorded as a change", async () => {
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: callsOnce("tex_instructions_set", { action: "add", text: "Use fewer emojis." }), group: "crew" });
  try {
    const turn = await world.text("@Tex from now on use fewer emojis please");
    assert.equal(turn.ok, true, turn.error);
    assert.match(turn.answer, /^WORKED: Saved\./, turn.answer);
    assert.match(turn.answer, /maya changed how Tex talks here, and it now reads "Use fewer emojis\."/, "a group's change is said with who made it");
    assert.deepEqual(world.gaps(), [], "no stand-in was missing");
    assert.deepEqual(world.changes().filter((c) => c.kind === "set").map((c) => c.detail), ['how Tex talks here is now: "Use fewer emojis."']);
  } finally {
    world.close();
  }
});

test("a settings change works in a one-to-one chat too, and the settings read says what is saved", async () => {
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: callsOnce("tex_instructions_set", { action: "add", text: "Call me M." }) });
  try {
    const turn = await world.text("from now on call me M");
    assert.match(turn.answer, /^WORKED: Saved\. Their instructions are now: "Call me M\."/, turn.answer);
  } finally {
    world.close();
  }
});

test("the chat's commands follow the control plane's rules: add, remove, undo, too long, nothing to undo", () => {
  assert.deepEqual(applyChange({}, { action: "add", text: " Be brief. " }), { instructions: "Be brief.", instructionsBefore: "" });
  assert.deepEqual(applyChange({ instructions: "Be brief.\nNo emojis." }, { action: "remove", text: "Be brief." }), { instructions: "No emojis.", instructionsBefore: "Be brief.\nNo emojis." });
  assert.deepEqual(applyChange({ instructions: "A", instructionsBefore: "" }, { action: "undo" }), {});
  assert.deepEqual(applyChange({}, { action: "undo" }), { refused: "nothing_to_undo" });
  assert.deepEqual(applyChange({ instructions: "x".repeat(1400) }, { action: "add", text: "y".repeat(200) }), { refused: "too_long" });
  assert.deepEqual(applyChange({}, { action: "add", text: "  " }), { refused: "bad_request" });
  const own = createTexCommands();
  assert.equal(own.answer({ kind: "mute" }).status, "not_allowed", "mute is a group chat's");
  const crew = createTexCommands({ group: "crew", setBy: "maya" });
  assert.deepEqual(crew.answer({ kind: "mute" }), { status: "done", muted: true });
  assert.equal(crew.answer({ kind: "review_sharing", share: true }).status, "not_allowed", "review sharing is never a group's");
  assert.deepEqual(crew.answer({ kind: "nonsense" }), { status: "bad_request" });
});

const CARD = { action: "draw_visual", args: { template: "places", data: { title: "Budget picks", items: [{ name: "The Eleanor", cuisine: "Bowling bar" }] } } };

test("a card drawn in a simulated world is sent: the bench's blank picture never reaches the model that looks at cards", async () => {
  const seen = [];
  // The look would hold the picture back, as a model shown a white rectangle does: it must never be asked.
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: callsOnce("send", CARD, { look: { send: false, critique: "The picture is blank." }, seen }), simulate: { send: null, memo: simMemo(), setting: "Maya is picking a bar.", chat: [] } });
  try {
    const turn = await world.text("show me the budget picks as a card");
    assert.equal(turn.ok, true, turn.error);
    assert.doesNotMatch(turn.answer, /Not sent|could not be drawn|FAILED/, turn.answer);
    assert.equal(turn.pictures, 1, `the card went with the answer: ${turn.answer}`);
    assert.equal(seen.filter((body) => body.includes("TEX'S PICTURE (")).length, 0, "the look at the bench's own picture was answered by the bench");
    assert.match(saidLine(turn), /\[Sent a picture with this answer\.\]$/, "the record says a picture went");
  } finally {
    world.close();
  }
});

test("only a look at a picture the bench drew is answered by the bench; any other call goes to the model", async () => {
  const drawn = drawnPictures();
  const binding = keepsRenders({ fetch: async (url) => json(new URL(url).pathname === "/render" ? { png: "QkxBTks=" } : { ok: true }) }, drawn);
  await binding.fetch("https://site-shots.bench/read", { method: "POST", body: "{}" });
  assert.equal(drawn.count(), 0);
  await binding.fetch("https://site-shots.bench/render", { method: "POST", body: "{}" });
  assert.equal(drawn.count(), 1);
  const sent = [];
  const looks = { n: 0 };
  const send = looksPastDrawn(async (_url, init) => (sent.push(init.body), json({ content: [] })), drawn, looks);
  await send("u", { body: `{"text":"TEX'S PICTURE (draw_visual) is attached.","data":"QkxBTks="}` });
  await send("u", { body: `{"text":"TEX'S PICTURE (make_picture) is attached.","data":"UkVBTA=="}` });
  await send("u", { body: `{"text":"a turn that carries the card back","data":"QkxBTks="}` });
  assert.equal(looks.n, 1);
  assert.equal(sent.length, 2, "a made picture's look and the turn's own calls reach the model");
});

test("a route the bench never learnt is a gap; a report nobody reads and a call no tool waits on are not", async () => {
  assert.equal(isRouteGap("/gateway/vault/text"), true);
  assert.equal(isRouteGap("/gateway/search-timing"), false);
  assert.equal(isRouteGap("/gateway/note-ids/lookup"), false);
  assert.ok(FAILS_NO_TOOL.every((route) => route.startsWith("/gateway/")));
  const gaps = benchGaps();
  const binding = watchedBinding({ fetch: async () => json({ error: "not found" }, 404) }, gaps);
  assert.equal((await binding.fetch("https://site-shots.bench/browse/log", {})).status, 200);
  assert.deepEqual(await (await binding.fetch("https://site-shots.bench/shoot", {})).json(), { ok: true, shots: [] }, "no photograph, and the card goes without");
  assert.deepEqual(gaps.list(), []);
  await binding.fetch("https://site-shots.bench/pdf", {});
  await binding.fetch("https://site-shots.bench/pdf", {});
  assert.deepEqual(gaps.list(), ["the bench's browser Worker has no /pdf"], "each gap once");
});

test("a call to a route the bench never learnt is kept as a gap on the conversation's record, a report's is not, and a host with no stand-in is one too", async () => {
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: callsOnce("read_note", { path: "todo.md" }) });
  try {
    await world.text("what's on my list");
    assert.deepEqual(world.gaps(), [], "an ordinary turn hits no gap");
    const asGateway = { method: "POST", headers: { Authorization: `Bearer ${GATEWAY_SECRET}` }, body: "{}" };
    assert.equal((await fetch(`${CONTROL_PLANE_ORIGIN}/gateway/vault/text`, asGateway)).status, 404);
    await fetch(`${CONTROL_PLANE_ORIGIN}/gateway/search-timing`, asGateway);
    assert.deepEqual(world.gaps(), ["the bench's control plane has no /gateway/vault/text"]);
    await assert.rejects(fetch("https://tile.openstreetmap.org/1/1/1.png"), /outside the model/);
    assert.ok(world.gaps().includes("the bench has no stand-in for tile.openstreetmap.org"));
  } finally {
    world.close();
  }
});

test("a missed test whose turn hit a gap is the bench's failure, never Tex's miss; one that held is a pass", () => {
  assert.equal(benchFailed({ right: true, bench: ["the bench's control plane has no /gateway/vault/text"] }), null);
  assert.equal(benchFailed({ right: false, bench: [] }), null);
  assert.equal(benchFailed({ right: false }), null);
  assert.equal(benchFailed({ right: false, bench: ["the bench's control plane has no /gateway/vault/text"] }), "the bench failed, not Tex: the bench's control plane has no /gateway/vault/text");
});

test("a turn with no words says which kind of nothing it was", () => {
  assert.equal(saidLine({ answer: "Done.", pictures: 0 }), "Done.");
  assert.equal(saidLine({ answer: "", pictures: 2 }), "[Sent 2 pictures as one swipeable set with this answer.]", "a picture alone is not silence");
  assert.equal(saidLine({ answer: "", react: "👍" }), "", "a tapback is its own line");
  assert.equal(saidLine({ answer: "", quiet: true, quietWhy: 'send({"action":"say_nothing"})' }), '(stayed quiet: send({"action":"say_nothing"}))');
  assert.equal(saidLine({ answer: "", cancelled: true }), "(the turn was stopped before it answered)");
  assert.match(saidLine({ answer: "" }), /^\(no answer came back; the texting Worker would retry/);
});

test("Tex choosing to say nothing is recorded as its choice, with the call it made", async () => {
  const say = async () => json({ content: [{ type: "tool_use", id: "toolu_1", name: "send", input: { action: "say_nothing" } }], stop_reason: "tool_use", usage });
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: say });
  try {
    const turn = await world.text("thanks!");
    assert.equal(turn.ok, true, turn.error);
    assert.deepEqual([turn.answer, turn.quiet], ["", true]);
    assert.equal(saidLine(turn), '(stayed quiet: send({"action":"say_nothing"}))');
  } finally {
    world.close();
  }
});

test("a model that answers with no words is never an empty text: the gateway says the answer got lost", async () => {
  const empty = async () => json({ content: [{ type: "text", text: "" }], stop_reason: "end_turn", usage });
  const world = await createWorld(bench, "Maya", SETUP, { gatewayFetch: empty });
  try {
    const turn = await world.text("when is my dentist appointment?");
    assert.equal(turn.ok, true, turn.error);
    assert.match(turn.answer, /got lost/i, turn.answer);
  } finally {
    world.close();
  }
});

test("a simulated world whose model fails says so once as a gap, and asks again next time", async () => {
  const gaps = benchGaps();
  let n = 0;
  const send = async () => ((n += 1), n === 1 ? json({ error: "credit balance is too low" }, 400) : json({ content: [{ type: "text", text: '{"results":[{"title":"Found","url":"https://x.test/","description":"d"}]}' }], usage }));
  const sim = createSimWorld({ send, setting: "s", gaps });
  assert.deepEqual(await sim.search("mics"), []);
  assert.deepEqual(gaps.list(), ["the simulated world's model did not answer a web search (status 400)"]);
  assert.equal((await sim.search("mics")).length, 1, "the failed ask was not remembered as the world's answer");
});
