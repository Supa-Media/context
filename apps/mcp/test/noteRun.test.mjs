// Tex in a note (`packages/tex/gateway/agent/noteRun.js`; Dev2, 2026-11-20: headless Tex inside notes): a model reads
// the asker's notes and their 1:1 Tex history, and answers in JSON with an optional replacement for the highlighted
// words. Its tools are the read door's, its dispatcher refuses a write, its ledger is read and never written.
//
// Sabotage record (temporary local edits, reverted): letting a write tool through `noteRunTools` ("a write is never
// offered" fails); letting a write through `noteRunCallTool` ("a write is refused in band" fails); writing the ledger
// from the run ("the ledger is never written" fails).
import { test } from "node:test";
import assert from "node:assert/strict";

import { noteRunTools, noteRunCallTool, noteRunQuestion, parseNoteRun, lenientNoteRun, stepLabel, runNoteRun, withInsert } from "../../../packages/tex/gateway/agent/noteRun.js";

const J19 = "Study/Judges/Judges 19.md";
const G19 = "Study/Genesis/Genesis 19.md";

test("the run is offered the read door's tools only: a write, a reply or a hand-over is never among them", () => {
  const offered = [
    { name: "read_note", annotations: { readOnlyHint: true } },
    { name: "search_notes", annotations: { readOnlyHint: true } },
    { name: "search_web" },
    { name: "write_note", annotations: {} },
    { name: "delete_note" },
    { name: "send_text", annotations: { readOnlyHint: false } },
    { name: "say_nothing" },
    { name: "text_progress" },
    { name: "tapback" },
    { name: "need_more_tools" },
  ];
  assert.deepEqual(noteRunTools(offered).map((tool) => tool.name), ["read_note", "search_notes", "search_web"]);
  assert.deepEqual(noteRunTools(null), []);
});

test("the run's dispatcher refuses a write and any name it was not given, and holds every call to the run's workspace", async () => {
  const seen = [];
  const dispatch = async (name, args) => {
    seen.push([name, args]);
    return { content: [{ type: "text", text: "ok" }] };
  };
  const own = noteRunCallTool(dispatch, ["read_note", "search_notes"], null);
  assert.equal((await own("write_note", { path: J19, content: "x" })).isError, true, "a write is refused in band");
  assert.equal((await own("delete_note", { path: J19 })).isError, true);
  assert.deepEqual(seen, [], "nothing refused reached the dispatcher");
  await own("read_note", { path: J19 });
  assert.deepEqual(seen.at(-1), ["read_note", { path: J19 }], "their own workspace: context stays out");
  await own("read_note", null);
  assert.deepEqual(seen.at(-1), ["read_note", {}]);

  const team = noteRunCallTool(dispatch, ["read_note"], "@team");
  await team("read_note", { path: J19 });
  assert.deepEqual(seen.at(-1), ["read_note", { path: J19, context: "@team" }], "forced to the run's workspace");
  await team("read_note", { path: J19, context: "@other" });
  assert.deepEqual(seen.at(-1), ["read_note", { path: J19, context: "@other" }], "another workspace the person reaches is left to the dispatcher's own checks");
});

test("the question says it is Tex in a note's thread, and carries the note, the words, the thread, the suggestion and the chat, capped", () => {
  const note = `${"a".repeat(12_000)}TAIL_PAST_CAP`;
  const q = noteRunQuestion({
    path: J19,
    noteText: note,
    anchor: { text: "Lot's daughters", before: "Then the men of the city said: ", after: " come out to us." },
    ask: "make this say the men wanted to know them",
    history: [{ who: "Seyi", body: "Is this the right story?" }, { who: "Tex", body: "I think so." }],
    pending: "the men of the city wanted to know them",
    chatHistory: `OLD_CHAT_LINE\n${"x".repeat(70_000)}NEWEST_CHAT_LINE`,
    audience: "the workspace's members",
  });
  assert.match(q, /inside a note's comment thread/);
  assert.match(q, /not a text/);
  assert.ok(q.includes("Lot's daughters") && q.includes("Then the men of the city said:") && q.includes("come out to us."), "the highlighted words with their context");
  assert.ok(q.includes("make this say the men wanted to know them"), "the ask");
  assert.ok(q.includes("Is this the right story?") && q.includes("I think so."), "the thread so far");
  assert.ok(q.includes("the men of the city wanted to know them"), "the pending suggestion");
  assert.ok(q.includes("the workspace's members"), "who else reads the note");
  assert.ok(q.includes("NEWEST_CHAT_LINE") && !q.includes("OLD_CHAT_LINE"), "the newest of the Tex chat is kept");
  assert.ok(!q.includes("TAIL_PAST_CAP") && q.includes("a".repeat(12_000)), "the note is capped at 12000 characters");
  assert.match(q, /\{"answer":/, "answers only JSON");
  assert.match(q, /"replace"/);
});

test("the question carries the note without its comment threads or markers, which an edit would otherwise copy", () => {
  const noteText = "# Plan\n\nShip <!--c:ab12-->the outline<!--/c:ab12--> soon.\n\n```comments\nab12 \"the outline\"\n- 2026-11-21T05:40:40Z @alpha: @Tex give me a basic outline here\n```\n";
  const q = noteRunQuestion({ path: "plan.md", noteText, anchor: { text: "the outline", before: "", after: "" }, ask: "give me a basic outline here", history: [], pending: null, chatHistory: "", audience: "only the asker" });
  assert.match(q, /Ship the outline soon\./);
  assert.doesNotMatch(q, /```comments/);
  assert.doesNotMatch(q, /<!--c:/);
});

test("an answer whose values hold unescaped quotes is still read as its fields, never posted whole", () => {
  const loose = '{"answer": "Added a basic plot outline after the highlighted words.", "replace": null, "insert": "\\n\\nAct 1\\n- She tests the starter, asking about its "ingredients," and her own thoughts."}';
  const parsed = parseNoteRun(loose);
  assert.equal(parsed.answer, "Added a basic plot outline after the highlighted words.");
  assert.equal(parsed.replace, null);
  assert.equal(parsed.insert, '\n\nAct 1\n- She tests the starter, asking about its "ingredients," and her own thoughts.');
  assert.equal(lenientNoteRun('{"replace": "x"}'), null, "no answer key, nothing read");
  const unclosed = parseNoteRun('```json\n{"answer": "The captain finds the letters."\n```');
  assert.equal(unclosed.answer, "The captain finds the letters.", "an object never closed is still read");
  assert.equal(lenientNoteRun('{"answer": 12}'), null, "a value that is not a string or null");
});

test("a collapsed point asks for the text to insert there, not a change to words", () => {
  const q = noteRunQuestion({ path: J19, noteText: "# Judges 19\n", anchor: { text: "", before: "The night was long.", after: "" }, ask: "add a line about the road", history: [], pending: null, chatHistory: "", audience: "only you" });
  assert.match(q, /a point in the note/);
  assert.match(q, /insert/);
  assert.match(q, /only you/);
  assert.match(q, /(none)/, "no suggestion pending is said as none");
});

test("the answer is read from JSON, tolerantly; anything else is the raw words", () => {
  assert.deepEqual(parseNoteRun('Here: {"answer":"Done, one line.","replace":"the new words"}'), { answer: "Done, one line.", replace: "the new words", insert: null });
  assert.deepEqual(parseNoteRun('{"answer":"Kept as it was.","replace":null}'), { answer: "Kept as it was.", replace: null, insert: null });
  assert.deepEqual(parseNoteRun("Plain words, no JSON."), { answer: "Plain words, no JSON.", replace: null, insert: null });
  assert.deepEqual(parseNoteRun('{"answer":42,"replace":"x"}'), { answer: '{"answer":42,"replace":"x"}', replace: null, insert: null }, "a non-string answer is refused");
  assert.equal(parseNoteRun(`{"answer":"${"y".repeat(1600)}","replace":null}`).answer.length, 1500, "the answer is held to 1500 characters");
  const long = parseNoteRun(`{"answer":"ok","replace":"${"z".repeat(20_001)}"}`);
  assert.equal(long.replace, null, "a replacement over 20000 characters is refused");
  assert.equal(parseNoteRun("").answer, "");
});

test("a tool step is labelled for a person, with the note it read as its source", () => {
  assert.deepEqual(stepLabel({ name: "read_note", args: { path: J19 } }), { label: "Reading Judges 19", source: J19 });
  assert.deepEqual(stepLabel({ name: "search_notes", args: { query: "lot" } }), { label: "Searching your notes", source: null });
  assert.deepEqual(stepLabel({ name: "mail", args: { action: "search" } }), { label: "Reading your email", source: null });
  assert.deepEqual(stepLabel({ name: "calendar", args: {} }), { label: "Checking your calendar", source: null });
  assert.deepEqual(stepLabel({ name: "search_web", args: { query: "x" } }), { label: "Looking on the web", source: null });
  assert.deepEqual(stepLabel({ name: "open_page", args: { url: "https://example.test" } }), { label: "Looking on the web", source: null });
  assert.deepEqual(stepLabel({ name: "fetch", args: { id: "tex/history.ledger.json" } }), { label: "Checking your texts", source: null });
  assert.deepEqual(stepLabel({ name: "read_day", args: { day: "2026-11-19" } }), { label: "Checking your texts", source: null });
  assert.ok(stepLabel({ name: "some_other_tool", args: {} }).label.length > 0, "every step has a label");
});

/** A Workers AI binding that answers from a script, as the built-in model's tests do (`agentBuiltin.test.mjs`). */
function fakeAi(replies) {
  const calls = [];
  const script = [...replies];
  return {
    calls,
    async run(model, input) {
      if (input?.questions?.route) return { answers: {} };
      calls.push({ model, input });
      const next = script.shift();
      if (!next) throw new Error("fake ai: the script ran out");
      return next;
    },
  };
}

/** One Workers AI chat answer: words, and the calls it asks for. */
function reply(text, toolCalls = []) {
  return {
    choices: [
      {
        message: {
          content: text,
          tool_calls: toolCalls.map((call, i) => ({ id: `call_${i}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) } })),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  };
}

/** A ledger that is read, and every write is recorded (the history read swallows errors, so a throw would hide a write). */
function readOnlyLedger(reads, writes) {
  const record = (name) => (...args) => {
    writes.push([name, ...args.map((a) => (Array.isArray(a) ? a.length : typeof a))]);
    return { ok: true };
  };
  return {
    async read(chat) {
      reads.push(chat);
      return { entries: [], before: undefined };
    },
    append: record("append"),
    write: record("write"),
    put: record("put"),
    delete: record("delete"),
  };
}

const READ_NOTE = { name: "read_note", description: "Read a note.", input_schema: { type: "object", properties: { path: { type: "string" } } }, annotations: { readOnlyHint: true } };

function runArgs(overrides = {}) {
  const ai = overrides.ai ?? fakeAi([reply('{"answer":"Moved the line.","replace":"The men of the city wanted to know them."}')]);
  const controlPlane = {
    verdict: overrides.verdict ?? { allowed: true },
    async startBuiltinTurn(...args) {
      controlPlane.asked.push(args);
      return this.verdict;
    },
    asked: [],
    async recordBuiltinUsage(...args) {
      controlPlane.usage.push(args);
    },
    usage: [],
  };
  const dispatched = [];
  const dispatch =
    overrides.dispatch ??
    (async (name, args) => {
      dispatched.push([name, args]);
      return { content: [{ type: "text", text: `text of ${args?.path ?? "a note"}` }] };
    });
  return {
    ai,
    controlPlane,
    dispatched,
    args: {
      env: overrides.env ?? { AI: ai },
      controlPlane,
      session: { accessToken: "tok_asker", workspaceId: "ws_asker", workspaceKind: "personal", scopes: ["context:read"] },
      dispatch,
      offered: overrides.offered ?? [READ_NOTE, { name: "write_note", annotations: {} }],
      ledger: overrides.ledger === undefined ? null : overrides.ledger,
      path: J19,
      noteText: "# Judges 19\n\nThe men of the city said: come out to us.\n",
      anchor: { text: "come out to us", before: "The men of the city said: ", after: "." },
      ask: "say what they wanted, in their words",
      history: [{ who: "Seyi", body: "What did they want?" }],
      pending: null,
      audience: "only you",
      node: { model: "haiku-5-5", rounds: 6 },
      now: Date.parse("2026-11-20T10:00:00Z"),
      timeZone: "UTC",
      onStep: overrides.onStep ?? null,
    },
  };
}

test("a run answers with its JSON, shows each read as a step, and names the note and the notes it read as its sources", async () => {
  const steps = [];
  const ai = fakeAi([
    reply("", [{ name: "read_note", args: { path: G19 } }, { name: "read_note", args: { path: J19 } }]),
    reply('{"answer":"Moved the line.","replace":"The men of the city wanted to know them."}'),
  ]);
  const { args, dispatched } = runArgs({ ai, onStep: (step) => steps.push(step) });
  const out = await runNoteRun(args);
  assert.equal(out.outcome, "answered");
  assert.equal(out.answer, "Moved the line.");
  assert.equal(out.replace, "The men of the city wanted to know them.");
  assert.deepEqual(dispatched.map(([name, a]) => [name, a.path]), [["read_note", G19], ["read_note", J19]]);
  assert.deepEqual(out.sources, [J19, G19], "the note itself first, then each note read, once");
  assert.equal(out.calls.length, 2);
  assert.ok(out.model, "the model that answered is named");
  assert.deepEqual(steps.filter((s) => s.state === "running").map((s) => [s.label, s.source]), [["Reading Judges 19", J19], ["Thinking", undefined], ["Reading Genesis 19", G19], ["Reading Judges 19", J19]], "the note read first, then the model's work and each read it asked for");
  assert.equal(steps.filter((s) => s.state === "done").length, 4, "each step is told done");
  assert.equal(steps.find((s) => s.id === "step-think" && s.state === "done").label, "Editing the selected words", "an answer with an edit says so");
  assert.ok(steps.every((s) => s.state !== "done" || Number.isFinite(s.ms)), "every done step has its time");
  assert.ok(steps.every((s) => typeof s.id === "string" && s.id.length > 0));
  assert.equal(args.controlPlane.usage.length, 1, "the usage is metered");
  assert.deepEqual(args.controlPlane.asked[0][2], { noteRun: true }, "asked as a note run, which the app's own grant may spend");
  assert.equal(args.controlPlane.usage[0][2].noteRun, true, "metered as a note run");
});

test("the 1:1 history is read beside the run, and the ledger is never written", async () => {
  const reads = [], writes = [];
  const { args } = runArgs({ ledger: readOnlyLedger(reads, writes) });
  const steps = [];
  const out = await runNoteRun({ ...args, onStep: (step) => steps.push(step) });
  assert.equal(out.outcome, "answered");
  assert.deepEqual(steps.filter((s) => s.id === "step-chat").map((s) => s.state), ["running", "done"], "the chat read is a step of its own");
  assert.ok(reads.length > 0 && reads.every((chat) => chat === "texts"), "read the asker's one-to-one chat");
  assert.deepEqual(writes, [], "the 1:1 ledger is never written");
  assert.ok(!out.sources.includes("Tex chat"), "no Tex chat source when nothing was read from it");
});

test("a refused or missing model says so and never throws", async () => {
  assert.equal((await runNoteRun(runArgs({ verdict: { allowed: false, reason: "daily_cap" } }).args)).outcome, "daily_limit");
  assert.equal((await runNoteRun(runArgs({ env: {} }).args)).outcome, "no_provider");
  const broken = runArgs({ ai: { async run() { throw new Error("upstream down"); } } });
  assert.equal((await runNoteRun(broken.args)).outcome, "model_unavailable");
});

// Dev2, 2026-11-21: "give me a basic plot outline here" on a highlighted premise got an answer in the thread, because
// the only edit was the highlighted words' whole new text. An addition after them is its own shape now.
test("an ask for content is added after the highlighted words, which stay as they are", async () => {
  const steps = [];
  const ai = fakeAi([reply('{"answer":"Added an outline under the premise.","replace":null,"insert":"1. Framed\\n2. Thrown in\\n3. Vindicated"}')]);
  const { args } = runArgs({ ai, onStep: (step) => steps.push(step) });
  const out = await runNoteRun({ ...args, anchor: { text: "A film set in 2025", before: "# Pitch\n\n", after: "\n\nTest" }, ask: "give me a basic plot outline here" });
  assert.equal(out.replace, "A film set in 2025\n\n1. Framed\n2. Thrown in\n3. Vindicated", "the words, then the addition as its own paragraph");
  assert.equal(steps.find((s) => s.id === "step-think" && s.state === "done").label, "Adding below the selected words");
});

test("an insert joins a sentence after a space, stands alone at a point, and never beside a replacement", () => {
  assert.equal(withInsert({ text: "cake", after: " on Saturday." }, "and candles"), "cake and candles");
  assert.equal(withInsert({ text: "Agenda", after: " for the day" }, "- one\n- two"), "Agenda\n\n- one\n- two", "a block is its own paragraph");
  assert.equal(withInsert({ text: "", before: "x", after: "" }, "A new line."), "A new line.");
  assert.deepEqual(parseNoteRun('{"answer":"Fixed.","replace":"new words","insert":"more"}'), { answer: "Fixed.", replace: "new words", insert: null });
  assert.deepEqual(parseNoteRun('{"answer":"Added.","replace":null,"insert":"  "}'), { answer: "Added.", replace: null, insert: null }, "a blank insert is no edit");
  assert.equal(parseNoteRun(`{"answer":"ok","insert":"${"z".repeat(20_001)}"}`).insert, null, "an insert past the cap is the raw words");
});

test("the question asks Tex to act on asks for content, answer questions only, and take a follow-up as an insert", () => {
  const q = noteRunQuestion({ path: J19, noteText: "# Pitch\n", anchor: { text: "A film", before: "", after: "" }, ask: "add it to the note", history: [], pending: null, chatHistory: "", audience: "only you" });
  assert.match(q, /"insert"/);
  assert.match(q, /do it in the note/);
  assert.match(q, /add it to the note/);
  assert.match(q, /Only a question/);
});
