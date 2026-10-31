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
    const reply = step.text
      ? { content: [{ type: "text", text: step.text }], stop_reason: "end_turn" }
      : { content: [{ type: "tool_use", id: `toolu_${n}`, name: step.name, input: step.input }], stop_reason: "tool_use" };
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
