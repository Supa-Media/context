/**
 * Turns the texting Worker queues itself, run and kept as production runs and keeps them (`byCode.mjs`), proven through
 * the real gateway on a scripted model: what the model is asked and shown is read from its own request.
 *
 * Sabotage record (2026-11-17, each restored after): posting the by-code turn's words as a person text fails "a group
 * routine"; dropping `group.mail` fails "a group check-in"; writing an earlier check-in's answer as a plain Tex text
 * fails "an earlier check-in"; leaving out the report fields fails "a job's report".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { QUIET_MS, midConversation } from "../../src/agent/checkInGather.js";
import { byCodeStart } from "../byCode.mjs";
import { createWorld } from "../world.mjs";

const SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

const bench = {
  people: [
    { person: "Priya", workspace: "priya", role: "owner", personal: true },
    { person: "Kofi", workspace: "kofi", role: "owner", personal: true },
    { person: "Priya", workspace: "flat", role: "owner", personal: false },
    { person: "Kofi", workspace: "flat", role: "editor", personal: false },
  ],
  workspaces: {
    priya: { files: { "todo.md": "- nothing\n" }, heldBack: [] },
    kofi: { files: { "todo.md": "- nothing\n" }, heldBack: [] },
    flat: { files: { "bills.md": "Rent $2,400: Priya 1,300, Kofi 1,100.\n" }, heldBack: [] },
  },
};

/** A model that answers `say`, or first calls `call` once; every request it gets is kept. */
function scripted(say, call = null) {
  const asked = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    asked.push(body);
    const last = body.messages.at(-1);
    const result = Array.isArray(last?.content) ? last.content.find((block) => block.type === "tool_result") : null;
    const reply = call && !result ? { content: [{ type: "tool_use", id: "toolu_1", name: call.name, input: call.input }], stop_reason: "tool_use" } : { content: [{ type: "text", text: result ? `${say} ${JSON.stringify(result.content)}` : say }], stop_reason: "end_turn" };
    return new Response(JSON.stringify({ ...reply, usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, asked };
}

/** Every word the model was given on its first round: system, tools and messages. */
const words = (request) => JSON.stringify(request);

async function inWorld(person, models, run) {
  const world = await createWorld(bench, person, SETUP, { ledgerTurns: true, ...models });
  try {
    return await run(world);
  } finally {
    await world.close?.();
  }
}

test("a group routine runs as one turn of the chat in the Worker's words, its note in the home, and posts no text of theirs", async () => {
  const model = scripted("Rent's due: Priya $1,300, Kofi $1,100.");
  await inWorld("Priya", { gatewayFetch: model.fetch, group: "flat" }, async (world) => {
    const start = await byCodeStart(world, { routine: "rent reminder: split by room in the bills note." });
    assert.match(start.message, /^\(It's time for this chat's routine, tex\/groups\/bench-flat\/routines\/daily\/bench-routine\.md \(context: "@context-lc"\)\./);
    const turn = await world.text(start.message, [], { ...start.options, running: start.running });
    assert.equal(turn.ok, true, turn.error);
    assert.match(turn.answer, /Rent's due/);
    // The next text sees Tex's routine text in the chat, and never the routine's question as anyone's text.
    await world.text("thanks tex", [], {});
    const next = words(model.asked.at(-1));
    assert.match(next, /Rent's due: Priya/);
    assert.doesNotMatch(next, /time for this chat's routine.*time for this chat's routine/s, "the question is the turn's own, once");
    assert.doesNotMatch(next, /@priya: \(It's time/, "no text of theirs was posted for it");
  });
});

test("a group check-in reads the writer's mail shared with the chat, through the chat's own grant", async () => {
  const model = scripted("Priya, Mr. Haskins said yes.", { name: "search_email", input: { query: "Haskins" } });
  await inWorld("Priya", { gatewayFetch: model.fetch, group: "flat" }, async (world) => {
    const start = await byCodeStart(world, { checkinMail: { from: "Mr. Haskins", subject: "dishwasher", body: "countertop dishwasher is fine" } });
    assert.match(start.message, /^\(Time for this chat's check-in: look on your own at what is new since [^,]+, [^,]+, in three places only: mail shared with this chat \(search it with after:\d+\)/);
    assert.deepEqual(start.options.groupMail, [{ handle: "priya", address: world.chatSide().mailbox }]);
    const turn = await world.text(start.message, [], { ...start.options, running: start.running });
    assert.equal(turn.ok, true, turn.error);
    const first = words(model.asked[0]);
    assert.match(first, /This chat can read mail shared with it: @priya's/);
    assert.match(words(model.asked.at(-1)), /countertop dishwasher is fine/, "the chat's own grant searches the shared mailbox and finds the email");
  });
});

test("an earlier one-to-one check-in is kept as production keeps it: a check-in's note the next turn reads, the email in the mailbox", async () => {
  const model = scripted("ok");
  await inWorld("Priya", { gatewayFetch: model.fetch }, async (world) => {
    await world.earlier([
      { from: "person", text: "can you watch for the landlord's reply" },
      { from: "tex", text: "Will do." },
      { from: "trigger", via: "checkin", mail: { from: "Mr. Haskins", subject: "dishwasher", body: "countertop dishwasher is fine" } },
      { from: "tex", text: "Mr. Haskins said yes to the dishwasher." },
    ]);
    await world.text("nice", [], {});
    const seen = words(model.asked.at(-1));
    assert.match(seen, /Mr\. Haskins said yes to the dishwasher\./);
    const notes = (await world.ledgerEntries()).filter((entry) => entry.kind === "note" && entry.backfill === undefined);
    assert.deepEqual(notes.map((entry) => [entry.text, /^\(Not a text from them\. This was your own check-in/.test(entry.about ?? "")]), [["Mr. Haskins said yes to the dishwasher.", true]], "kept as a check-in's note, not a reply");
    assert.equal((await world.ledgerEntries()).filter((entry) => entry.kind === "text" && /Haskins/.test(entry.text ?? "")).length, 0);
    assert.equal(world.chatSide().mailbox !== null, true, "the email is in their mailbox");
  });
});

test("the chat before a one-to-one check-in is dated past the check-in's quiet wait, as production only looks once it is quiet", async () => {
  const chat = [
    { from: "person", text: "book the TAP flight" },
    { from: "tex", text: "Booked." },
    { from: "trigger", via: "checkin", mail: { from: "TAP", subject: "receipt", body: "your receipt" } },
    { from: "tex", text: "Receipt's in." },
    { from: "person", text: "done" },
  ];
  for (const checkIn of [true, false]) {
    await inWorld("Priya", { gatewayFetch: scripted("ok").fetch }, async (world) => {
      await world.earlier(chat, { checkIn });
      const now = Date.now();
      const kept = (await world.ledgerEntries()).filter((entry) => entry.backfill === undefined);
      assert.equal(kept.length >= 4, true);
      // A check-in says "busy" while a text of theirs is under QUIET_MS old (`checkInGather.js` `midConversation`).
      assert.equal(midConversation(kept.filter((entry) => entry.kind === "text" && entry.from?.kind === "person").map((entry) => ({ theirs: true, at: entry.at })), now), !checkIn, `checkIn ${checkIn}`);
      for (const entry of kept.filter((one) => one.kind === "text")) assert.equal(now - entry.at >= QUIET_MS, checkIn, `${entry.from?.kind} ${entry.text} dated ${now - entry.at} ms ago`);
    });
  }
});

test("an earlier one-to-one routine is kept as the routine turn's note, which the next turn reads", async () => {
  const model = scripted("ok");
  await inWorld("Priya", { gatewayFetch: model.fetch }, async (world) => {
    await world.earlier([{ from: "trigger", via: "routine", text: "reminder: meds, 9:30pm" }, { from: "tex", text: "Meds 💊" }]);
    await world.text("done", [], {});
    const seen = words(model.asked.at(-1));
    assert.match(seen, /Meds 💊/);
    const notes = (await world.ledgerEntries()).filter((entry) => entry.kind === "note" && entry.backfill === undefined);
    assert.deepEqual(notes.map((entry) => [entry.text, entry.routine, entry.outcome, entry.about]), [["Meds 💊", "tex/routines/daily/bench-routine.md", "answered", undefined]], "the routine turn's own note");
  });
});

test("a job's report runs as the chat's job_report turn, the job in the running list with its result", async () => {
  const model = scripted("Ceremony's 4pm Saturday. All on one page.");
  await inWorld("Priya", { gatewayFetch: model.fetch }, async (world) => {
    const start = await byCodeStart(world, { jobReport: { title: "check my email from Paulo for details", state: "done", text: "ceremony Sat 4pm; page written", asked: "check my email from Paulo for details" } }, { running: [] });
    assert.equal(start.options.event.event, "job_report");
    assert.deepEqual(start.running.map((job) => [job.title, job.state, job.result]), [["check my email from Paulo for details", "done", "ceremony Sat 4pm; page written"]]);
    const turn = await world.text(start.message, [], { ...start.options, running: start.running });
    assert.equal(turn.ok, true, turn.error);
    const seen = words(model.asked[0]);
    assert.match(seen, /Your background job \\"check my email from Paulo for details\\" reported back to you/);
    assert.match(seen, /ceremony Sat 4pm; page written/);
  });
});
