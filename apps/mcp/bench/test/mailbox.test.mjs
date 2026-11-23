/**
 * THE BENCHMARK'S GMAIL (`bench/mailbox.mjs`, 2026-10-22), and golden tasks 12
 * and 13 (`tests/tasks.md`) end to end with a scripted model: the receipt's
 * own email never says "receipt", Ama's request for it does, and a good run
 * forwards Signalwire's email in a draft, the next text still knowing its id.
 *
 * ## Sabotage record
 *
 *  1. `searchMailbox` matching any word instead of every word. → "an
 *     every-word search finds only the request..." fails.
 *  2. The `forward` case dropped from `checks.mjs`. → "...and the forward
 *     check sees the draft" fails.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { readBenchFolder, parseTest } from "../load.mjs";
import { readMailbox, searchMailbox } from "../mailbox.mjs";
import { createWorld } from "../world.mjs";
import { checkVerdicts } from "../checks.mjs";
import { asSixCall } from "../../test/sixCallFixture.mjs";

const AI = fileURLToPath(new URL("../ai", import.meta.url));
const RECEIPT = "19a2f0c4signal";
const ASKED = "19a3b1d2amaask";
const SETUP = "---\njob: texting-assistant\nmodels:\n  main: anthropic/claude-haiku-5-5\n---\n\nYou are a test assistant.\n";

test("Kofi's Gmail is read from the fixture's email files, and none of them is a note", async () => {
  const bench = await readBenchFolder(AI);
  const kofi = bench.workspaces.kofi;
  assert.deepEqual(kofi.mail.map((email) => email.id).sort(), ["19a0c7aausage", "19a2f0c4signal", "19a2f9e0digest", ASKED].sort());
  assert.ok(Object.keys(kofi.files).every((path) => !path.startsWith("gmail/")), "no email is a note");
  const receipt = readMailbox(kofi.mail, "kofi@northside.example", RECEIPT);
  assert.equal(receipt.attachments[0].filename, "order-4471.pdf");
  assert.match(receipt.body, /Amount paid: \$30\.69/);
});

test("an every-word search finds only the request; the sender, the amount or any of the words find the receipt", async () => {
  const { mail } = (await readBenchFolder(AI)).workspaces.kofi;
  const ids = (query) => searchMailbox(mail, query).map((result) => result.id);
  assert.deepEqual(ids("Signalwire receipt"), [ASKED]);
  assert.ok(ids("from:signalwire").includes(RECEIPT));
  assert.deepEqual(ids("30.69"), [ASKED, RECEIPT], "newest first");
  assert.ok(ids("{Signalwire receipt phone}").includes(RECEIPT));
  assert.deepEqual(ids("after:2026/10/08 before:2026/10/10"), [RECEIPT]);
  assert.deepEqual(ids("from:signalwire -paused"), [RECEIPT]);
});

/** A model that answers each call with the next scripted step, and keeps what it was asked. */
function scripted(steps, asked) {
  let n = 0;
  return async (url, init) => {
    asked.push(JSON.parse(init.body));
    const step = steps.shift() ?? { text: "Done." };
    n += 1;
    const call = step.text ? null : asSixCall({ name: step.name, args: step.input }); // the six's shape, as a real model is shown them
    const reply = step.text
      ? { content: [{ type: "text", text: step.text }], stop_reason: "end_turn" }
      : { content: [{ type: "tool_use", id: `toolu_${n}`, name: call.name, input: call.args }], stop_reason: "tool_use" };
    return new Response(JSON.stringify({ ...reply, usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("task 12 end to end: found by sender, kept a text later, forwarded in a draft, and the forward check sees the draft", async () => {
  const loaded = await readBenchFolder(AI);
  const bench = { people: [{ person: "Kofi", workspace: "kofi", role: "owner", personal: true }], workspaces: { kofi: loaded.workspaces.kofi } };
  const asked = [];
  const gatewayFetch = scripted(
    [
      { name: "search_email", input: { query: "Signalwire receipt" } },
      { name: "search_email", input: { query: "from:signalwire 30.69" } },
      { name: "read_email", input: { id: `email:kofi@northside.example/${RECEIPT}` } },
      { text: "Signalwire only emailed it to you, on October 9." },
      {
        name: "save_email_draft",
        input: { to: ["ama@northside.example"], subject: "Fwd: Your Signalwire order 4471", body: "Hi Ama, here it is.", forward: `email:kofi@northside.example/${RECEIPT}` },
      },
      { text: "Saved a draft to Ama in your Gmail, with Signalwire's email and its PDF forwarded." },
    ],
    asked,
  );
  const world = await createWorld(bench, "Kofi", SETUP, { gatewayFetch });
  try {
    const first = await world.text("ama says she never got the receipt for the signalwire payment, why not?");
    assert.equal(first.ok, true, first.error ?? "");
    const before = asked.length;
    const second = await world.text("ok save her a draft with it");
    assert.equal(second.ok, true, second.error ?? "");
    // The earlier answer's email is said in the person's turn, after the system prompt (`turn.js`): the whole request is read.
    const system = JSON.stringify(asked[before] ?? "");
    assert.ok(system.includes(`Emails you found: email:kofi@northside.example/`) && system.includes(RECEIPT), "the next text knows the receipt's id");
    const emails = world.emails();
    assert.equal(emails.at(-1)?.forward, RECEIPT);
    assert.equal(emails.at(-1)?.draft, true);
    const task = parseTest(await readFile(join(AI, "tests", "tasks.md"), "utf8")).questions.find((q) => q.n === 12);
    const verdicts = checkVerdicts(task, { tools: [...first.tools, ...second.tools].map((call) => call.tool), browser: [], emails });
    assert.deepEqual(verdicts.filter((verdict) => !verdict.pass), [], "every check of task 12 passes on this record");
  } finally {
    world.close();
  }
});

test("a check-in's look is shown the email that just arrived, and a routine runs with its words: what a Front door test that starts at one sends", async () => {
  const loaded = await readBenchFolder(AI);
  const bench = { people: [{ person: "Kofi", workspace: "kofi", role: "owner", personal: true }], workspaces: { kofi: loaded.workspaces.kofi } };
  const asked = [];
  const gatewayFetch = scripted([{ text: "- nothing" }, { text: "Your TAP flight is 50 minutes late." }, { text: "Meds." }, { text: "Laundry to the dryer." }], asked);
  const world = await createWorld(bench, "Kofi", SETUP, { gatewayFetch, ai: null }, "2026-10-12");
  try {
    world.mailArrives({ from: "TAP", subject: "flight TP 237 delayed 50 minutes", body: "flight TP 237 delayed 50 minutes, new departure 2:05pm." });
    // The check-in's own Gmail question finds it: its inbox since the last look (`newMail.js`).
    assert.deepEqual(searchMailbox([{ address: "a@x", id: "n", date: new Date(Date.now()).toISOString(), from: "TAP", to: "a@x", subject: "s", body: "", attachments: [] }], `after:${Math.floor((Date.now() - 60_000) / 1000)} in:inbox`).length, 1);
    const look = await world.checkIn();
    assert.equal(look.ok, true, look.error ?? "");
    assert.equal(look.answer, "Your TAP flight is 50 minutes late.");
    assert.match(JSON.stringify(asked[1]), /TP 237 delayed 50 minutes/, "the look (after Research) was shown the new email");
    const run = await world.routine("tex/routines/daily/bench-routine.md", "reminder: meds, 9:30pm");
    assert.equal(run.ok, true, run.error ?? "");
    assert.equal(run.answer, "Meds.");
    assert.match(JSON.stringify(asked.at(-1)), /reminder: meds, 9:30pm/, "the run was given the routine's words");
    // A one-off's run is placed where production keeps one, so it reads the one-off's own framing (`routine.js`).
    const { routinePathOf } = await import("../run.mjs");
    assert.equal(routinePathOf({ routineOnce: false }), "tex/routines/daily/bench-routine.md");
    const once = await world.routine(routinePathOf({ routineOnce: true }), "Remind them to move the laundry to the dryer.");
    assert.equal(once.answer, "Laundry to the dryer.");
    assert.match(JSON.stringify(asked.at(-1)), /one-off reminder the person set/, "the run was told it is a one-off");
  } finally {
    world.close();
  }
});

// Dev set, 2026-11-17: three check-in rows came back "(stayed quiet: quiet)", with nothing to tell the model's own
// choice from a step that stopped its text. A quiet start now carries its model's last words and tool calls.
test("a quiet check-in or routine row says what its model said last", async () => {
  const { lastWords, startedTurn } = await import("../worldStarts.mjs");
  const calls = [{ answer: { content: [{ type: "text", text: "Nothing new  for\nthem." }, { type: "tool_use", name: "send", input: { action: "say_nothing" } }] } }];
  assert.equal(lastWords(calls), 'Nothing new for them. send({"action":"say_nothing"})');
  assert.equal(lastWords([]), "");
  const quiet = startedTurn({ status: 200, body: { outcome: "quiet" }, ms: 1, usage: {} }, () => "", calls);
  assert.equal(quiet.answer, '(stayed quiet: quiet: Nothing new for them. send({"action":"say_nothing"}))');
  const spoke = startedTurn({ status: 200, body: { outcome: "speak", answer: "Your flight is late." }, ms: 1, usage: {} }, (b) => b.answer, calls);
  assert.equal(spoke.answer, "Your flight is late.");
  assert.ok(lastWords([{ answer: { content: [{ type: "text", text: "x".repeat(400) }] } }]).length <= 160);
});
