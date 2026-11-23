/**
 * THE ACTION LOG: A TRY AFTER A CRASH NEVER MAKES AN ACTION AGAIN THAT ALREADY HAPPENED (Dev2, 2026-11-20, durable
 * jobs option A; `src/agent/turnResume.js` `roundsKeeper`, `src/agent/savedRounds.js` `carriesOn`).
 *
 * An MCP action (a note saved, a share made) is logged as started before it runs, and the turn waits for that entry.
 * Once it returns, the snapshot holds what it returned, and a try after reads that instead of making it again. One
 * that never returned reaches the try after as "may or may not have happened, check first", never as done.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `carriesOn` without its `acts` branch: "a note saved before the crash is not saved again" fails (written twice);
 *  - `starting` returning at once: "an action is logged as started, and waited for, before it runs" fails;
 *  - the started entry's wait without its cap: "a store that never answers holds an action back no longer than its
 *    cap" times out;
 *  - `keeper.freeze()` back after every round with a call (`turn.js`): "with a job-starting tool offered, a second
 *    round of reads is kept too" fails (the bug that kept only a turn's first round since 11-17).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../../../packages/tex/gateway/agent/builtin.js";
import { runTurn } from "../../../packages/tex/gateway/agent/turn.js";
import { checkedSnapshot, STARTED_UNSURE } from "../../../packages/tex/gateway/agent/savedRounds.js";
import { keptTools, roundsKeeper, STARTED_WAIT_MS } from "../../../packages/tex/gateway/agent/turnResume.js";
import { asSixCall } from "./sixCallFixture.mjs";

const SEARCH = { name: "search_notes", description: "Search notes", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } };
const WRITE = { name: "write_note", description: "Write a note", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } }, annotations: { readOnlyHint: false } };
const USAGE = { prompt_tokens: 10, completion_tokens: 5 };
// The scripted model calls the six tools, as a real one is shown them (`sixCallFixture.mjs`).
const calls = (...list) => ({ choices: [{ message: { content: "", tool_calls: list.map(([id, name, args]) => ({ id, ...asSixCall({ name, args }) })).map(({ id, name, args }) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })) } }], usage: USAGE });
const words = (text) => ({ choices: [{ message: { content: text } }], usage: USAGE });
const NOTE = { path: "health/dentist.md", content: "Dentist: Tuesday 3pm" };

function scripted(replies) {
  const asked = [];
  return { asked, async run(_model, input) { asked.push(input); return replies.shift() ?? words("Done."); } };
}

function turn(ai, extra = {}) {
  const ran = [];
  const done = runTurn({
    question: "Save that the dentist is Tuesday at 3",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH, WRITE],
    env: { AI: ai, AGENT_BUILTIN_MODEL: "@cf/acme/main" },
    providerOptions: { ai },
    texting: true,
    callTool: async (name, args) => (ran.push(name), { content: [{ type: "text", text: name === "write_note" ? `Saved ${args.path}` : "Dentist: Tuesday 3pm" }] }),
    ...extra,
  });
  return { ran, done };
}

const keeping = () => {
  const kept = [];
  return { kept, keepRounds: { keep: (snapshot) => void kept.push(structuredClone(snapshot)), marks: () => ({}) } };
};

test("a note saved before the crash is not saved again: the try after reads that it was", async () => {
  const { kept, keepRounds } = keeping();
  const first = turn(scripted([calls(["c1", "search_notes", { query: "dentist" }]), calls(["c2", "write_note", NOTE]), words("Saved it.")]), { keepRounds, answerCheck: async () => { throw new Error("checks crashed"); } });
  await assert.rejects(first.done, /checks crashed/);
  assert.deepEqual(first.ran, ["search_notes", "write_note"]);
  const resumeFrom = checkedSnapshot(kept.at(-1));
  assert.ok(resumeFrom, "the newest snapshot is whole");
  assert.ok(resumeFrom.messages.some((m) => m.role === "tool" && m.text === "Saved health/dentist.md"), "it holds what the save returned");
  assert.ok(!JSON.stringify(kept.at(-1)).includes(STARTED_UNSURE), "a save that returned is no longer unsure");

  const ai = scripted([words("Saved it.")]);
  const second = turn(ai, { resumeFrom });
  const result = await second.done;
  assert.equal(result.answer, "Saved it.");
  assert.deepEqual(second.ran, [], "the note is not written twice");
  assert.deepEqual(result.steps.map((step) => [step.tool, step.resumed]), [["search_notes", true], ["write_note", true]]);
});

test("an action is logged as started, and waited for, before it runs", async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const keepRounds = {
    keep: (snapshot) => {
      const started = snapshot.unsure?.length > 0;
      order.push(started ? "started kept" : "kept");
      return started ? gate.then(() => order.push("started landed")) : undefined;
    },
    marks: () => ({}),
  };
  const first = turn(scripted([calls(["c1", "write_note", NOTE]), words("Saved it.")]), {
    keepRounds,
    callTool: async (name) => (order.push(`ran ${name}`), { content: [{ type: "text", text: "Saved" }] }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ["started kept"], "the save waits for its entry");
  release();
  await first.done;
  assert.deepEqual(order.slice(0, 3), ["started kept", "started landed", "ran write_note"]);
});

test("a store that never answers holds an action back no longer than its cap", async () => {
  const messages = [{ role: "user", text: "q" }, { role: "assistant", text: "", toolCalls: [{ id: "c", name: "write_note", args: NOTE }] }];
  const keeper = roundsKeeper({ messages, roundsFrom: 1, readOnly: new Set(), acts: new Set(["write_note"]), keep: () => new Promise(() => {}), startWait: 30 });
  keeper.roundStarted();
  const began = Date.now();
  await keeper.starting({ id: "c", name: "write_note", args: NOTE }, 0);
  assert.ok(Date.now() - began < 1_000);
  assert.ok(STARTED_WAIT_MS <= 2_000, "a live turn waits at most a couple of seconds");
});

test("a save that never returned reaches the try after as unsure: checked first, never counted as done", async () => {
  const messages = [{ role: "user", text: "q" }, { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "search_notes", args: { query: "a" } }, { id: "c2", name: "write_note", args: NOTE }] }];
  const kept = [];
  const keeper = roundsKeeper({ messages, roundsFrom: 1, readOnly: new Set(["search_notes"]), acts: new Set(["write_note"]), keep: (snapshot) => void kept.push(structuredClone(snapshot)) });
  keeper.roundStarted();
  messages.push({ role: "tool", id: "c1", name: "search_notes", text: "found" });
  keeper.called({ id: "c1", name: "search_notes", args: { query: "a" } }, { content: [] }, 0);
  await keeper.starting({ id: "c2", name: "write_note", args: NOTE }, 0);
  // The gateway dies here, while the save runs.
  const from = checkedSnapshot(kept.at(-1));
  assert.ok(from, "a model can be handed it: every call has a result");
  const unsure = from.messages.find((m) => m.role === "tool" && m.id === "c2");
  assert.equal(unsure.text, STARTED_UNSURE);
  assert.equal(unsure.isError, true, "never told to the checks as done");
  assert.deepEqual(kept.at(-1).unsure, ["c2"]);
  assert.deepEqual(from.ran.c2, { name: "write_note", args: NOTE }, "the entry names the tool and what it was asked");

  const ai = scripted([words("I'll check the note first.")]);
  const second = turn(ai, { resumeFrom: from });
  await second.done;
  assert.ok(JSON.stringify(ai.asked[0].messages).includes("may or may not have taken effect"), "the model is told to check");
});

test("with a job-starting tool offered, a second round of reads is kept too", async () => {
  const { kept, keepRounds } = keeping();
  const first = turn(scripted([calls(["c1", "search_notes", { query: "a" }]), calls(["c2", "search_notes", { query: "b" }]), words("Tuesday.")]), { keepRounds, endsTurn: () => null });
  await first.done;
  const last = checkedSnapshot(kept.at(-1));
  assert.equal(last.round, 2, "both rounds, not only the first");
  assert.deepEqual(last.messages.filter((m) => m.role === "tool").map((m) => m.id), ["c1", "c2"]);
});

test("only the MCP's own tools are logged: web and local tools never", () => {
  const tools = [SEARCH, WRITE, { name: "browse", annotations: { readOnlyHint: false } }, { name: "ask_advisor", annotations: {} }];
  const { readOnly, acts } = keptTools(tools, { webNames: new Set(["browse"]), localCalls: new Map([["ask_advisor", () => {}]]) });
  assert.deepEqual([...readOnly], ["search_notes"]);
  assert.deepEqual([...acts], ["write_note"]);
});
