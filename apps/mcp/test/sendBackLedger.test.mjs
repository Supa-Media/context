/**
 * A SEND-BACK IS WRITTEN FROM THE TURN'S LEDGER (`src/agent/sendBack.js`,
 * Dev2 2026-11-05). Built from the shape of the 14:47-14:49Z turn in Dev2's
 * own chat (names, addresses and words invented): Tex searched notes, read two
 * emails, saved a reply draft, wrote the answer with the draft in it, and the
 * short-and-clean judge held it back. The old send-back put that answer in as
 * said, so the rewrite treated it as sent, dropped the answer and saved a
 * second email draft.
 *
 * Sabotage record (2026-11-05), each applied, this file run, named test failing, reverted:
 *  1. turn.js pushing the draft back as an assistant message again → "the rejected draft is never shown as said…".
 *  2. `repeatedWrite` check removed from turn.js → "a write already made this turn is not run again…".
 *  3. `sendBackNote` leaving out the actions list → "the rewrite is shown every action…".
 *  4. `isMcpWrite` true for every tool (reads refused too) → "a write already made this turn is not run again…".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { RECHECK_FROM } from "../src/agent/recheck.js";
import { GATES } from "../src/agent/replyGates.js";
import { replyJudge } from "../src/agent/replyJudge.js";
import { ALREADY_DONE, repeatedWrite, sendBackNote } from "../src/agent/sendBack.js";
import { runTurn } from "../src/agent/turn.js";

const MAIN = "@cf/acme/main-model";
const read = (name) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });
const TOOLS = [read("search_notes"), read("read_email"), { name: "save_email_draft", description: "Save a draft.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false } }];

const question = "is the review reply window 48 hours?";
const history = [
  { role: "user", text: "draft a nudge to the reviewer for me" },
  { role: "assistant", text: "Which reviewer?" },
];
const ANSWER =
  "No, it's three business days, not 48 hours. You submitted October 29, so that window closed Tuesday. Here's a follow-up to Robin:\n\n" +
  "To: robin@reviewer.example\nSubject: Re: Plan review\n\nHi Robin, we submitted on October 29 and the three-day window has passed. Where does the review stand?\n\nThanks";

function scripted(replies, verdicts) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      if (model.startsWith("@cf/cloudflare/clef")) {
        const [name] = Object.keys(input.questions);
        const next = verdicts[0];
        if (next === undefined) return null;
        next.__seen = (next.__seen ?? 0) + 1;
        if (next.__seen >= (next.__ran ?? Object.keys(GATES).length)) verdicts.shift();
        return { answers: { [name]: { type: "noul", noul: next[name] ?? 0.05 } } };
      }
      calls.push(structuredClone(input.messages));
      const reply = replies.shift();
      if (!reply) throw new Error("script ran out");
      const tool_calls = (reply.calls ?? []).map((call, i) => ({ id: `call_${calls.length}_${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } }));
      return { choices: [{ message: { content: reply.text ?? "", tool_calls } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
}

/** The 14:47 turn: two reads, a saved draft, the full answer held by short_and_clean, then a rewrite that tries the draft again. */
async function the1447Turn() {
  const ai = scripted(
    [
      { calls: [{ name: "search_notes", args: { query: "review reply window" } }, { name: "read_email", args: { id: "email:me@example.com/1" } }] },
      { calls: [{ name: "save_email_draft", args: { to: "robin@reviewer.example", body: "Hi Robin..." } }] },
      { text: ANSWER },
      { calls: [{ name: "read_email", args: { id: "email:me@example.com/1" } }, { name: "save_email_draft", args: { to: "robin@reviewer.example", body: "Hi Robin, shorter" } }] },
      { text: "No, three business days, not 48 hours; it closed Tuesday. Your follow-up to Robin is in Drafts." },
    ],
    [{ short_and_clean: 0.71 }, { __ran: 1 }],
  );
  const ran = [];
  const told = [];
  const judge = replyJudge({ ai, setting: { model: "clef-flash", at: null }, question, history, log: () => {} });
  const result = await runTurn({
    question,
    history,
    observe: (event) => told.push(event),
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: TOOLS,
    env: { AI: ai, AGENT_BUILTIN_MODEL: MAIN },
    providerOptions: { ai },
    texting: true,
    builtinModelOverride: MAIN,
    answerCheck: judge.check,
    callTool: async (name) => {
      ran.push(name);
      return { content: [{ type: "text", text: name === "save_email_draft" ? "Draft saved." : "Robin's email: reply within three business days." }] };
    },
  });
  return { ai, ran, told, result };
}

/** The messages the model was sent on the round after the send-back. */
const afterSendBack = (ai) => ai.calls[3];

test("the rejected draft is never shown as said: it is quoted in the check's note, marked NOT sent", async () => {
  const { ai, result } = await the1447Turn();
  assert.match(result.answer, /three business days/);
  const sent = afterSendBack(ai);
  const said = JSON.stringify(sent.filter((message) => message.role === "assistant"));
  assert.ok(!said.includes("Here's a follow-up to Robin"), "the draft is not an assistant message");
  const note = JSON.stringify(sent.at(-1));
  assert.equal(sent.at(-1).role, "user");
  assert.ok(note.includes(JSON.stringify(RECHECK_FROM).slice(1, 40)), "marked as the gateway's check, not a text from them");
  assert.ok(note.includes("Draft 1, NOT sent"));
  assert.ok(note.includes("> No, it's three business days, not 48 hours."), "the draft itself, quoted, so it can be revised");
  assert.ok(note.includes(`short and clean (0.71 against ${GATES.short_and_clean.at})`), "which judge held it and by how much");
  assert.ok(note.includes("Revise draft 1: keep its answer"), "asked to revise, not to start over");
});

test("the rewrite is shown every action the turn already took, from its ledger", async () => {
  const { ai } = await the1447Turn();
  const note = String(afterSendBack(ai).at(-1).content ?? JSON.stringify(afterSendBack(ai).at(-1)));
  for (const name of ["search_notes", "read_email", "save_email_draft"]) assert.ok(note.includes(`- ${name} `), name);
  assert.match(note, /save_email_draft .*\(done\)/);
  assert.match(note, /already done/);
});

test("a write already made this turn is not run again on a rewrite, and the ledger says why", async () => {
  const { ran, told, ai } = await the1447Turn();
  assert.deepEqual(ran.filter((name) => name === "save_email_draft"), ["save_email_draft"], "one draft saved, not two");
  const refused = told.filter((event) => event.kind === "tool" && event.reason === "already done this turn");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].name, "save_email_draft");
  assert.ok(JSON.stringify(ai.calls[4]).includes(ALREADY_DONE.slice(0, 40)), "the model is told in band");
  assert.equal(ran.filter((name) => name === "read_email").length, 2, "a read may run again on a rewrite");
});

test("a read may run again on a rewrite, and nothing is refused before any send-back", () => {
  const entries = [{ kind: "tool", name: "read_email", ok: true }, { kind: "tool", name: "save_email_draft", ok: true }, { kind: "tool", name: "write_note", ok: false }];
  const isWrite = (name) => name !== "read_email";
  assert.equal(repeatedWrite({ name: "read_email", entries, isWrite }), null);
  assert.equal(repeatedWrite({ name: "save_email_draft", entries, isWrite }), ALREADY_DONE);
  assert.equal(repeatedWrite({ name: "write_note", entries, isWrite }), null, "a write that failed may be tried again");
  assert.equal(repeatedWrite({ name: "send_email", entries: [{ kind: "tool", name: "send_email", ok: false, held: true }], isWrite }), ALREADY_DONE, "a send held for their yes counts as done");
});

test("every earlier draft of the turn is shown, each with what held it", () => {
  const entries = [
    { kind: "tool", name: "search_notes", args: { query: "x" }, ok: true },
    { kind: "judge", by: "gates", draft: "first", went: false, judges: [{ id: "finished", yes: 0.82, at: 0.5, passed: false }, { id: "sourced", yes: 0.1, at: 0.5, passed: true }] },
    { kind: "judge", by: "code", draft: "second", went: false, judges: [], notice: "Fix it." },
  ];
  const note = sendBackNote({ entries, notice: "Fix it.", draft: "second" });
  assert.ok(note.indexOf("Draft 1, NOT sent") < note.indexOf("> first"));
  assert.ok(note.includes("Held back by: finished (0.82 against 0.5)"));
  assert.ok(!note.includes("sourced"), "a judge that passed is not named");
  assert.ok(note.includes("Draft 2, NOT sent") && note.includes("> second") && note.includes("Held back by: a code check"));
  assert.ok(note.includes("Revise draft 2"));
  const bare = sendBackNote({ entries: [], notice: "Fix it.", draft: "only" });
  assert.ok(bare.includes("Actions you took: none.") && bare.includes("> only"), "with no ledger entries, the draft just held is still quoted");
});
