/**
 * A BROWSE STEP THAT ISN'T ONE (`src/agent/browseNotAStep.js`).
 *
 * The owner's flight check-in job (2026-11-05) asked the browse tool for
 * "wait", "key" and "fill_login" steps, was told only that there were none,
 * and asked again. These checks drive the browse tool and prove the answer
 * names the step that does the job and lists every real one, and that the
 * browser is never asked to run it.
 *
 * Sabotage record: with `browse.js` answering the old `There is no "x" step.`,
 * every test here fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { webSession } from "../src/agent/computer.js";
import { BROWSE_TOOL } from "../src/agent/browse.js";
import { notAStep } from "../src/agent/browseNotAStep.js";

const SITE = "https://checkin.example.com/";

function pageComputer() {
  const calls = [];
  return {
    calls,
    async readPage(url) {
      return { url, title: "", text: "", links: [] };
    },
    async browse(session, steps) {
      calls.push(steps.map((s) => s.do));
      return { session: "sess-steps-0001", ran: steps.map((s) => ({ do: s.do, ok: true })), page: { url: SITE, title: "Check in", text: "Check in", truncated: false, elements: [] } };
    },
    async closeBrowser() {},
  };
}

async function ask(step) {
  const computer = pageComputer();
  const web = webSession(computer, `check me in on ${SITE}`);
  const result = await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: SITE }, step] });
  return { result, computer };
}

test("a wait step is told every step already waits, with the real steps listed, and nothing runs", async () => {
  const { result, computer } = await ask({ do: "wait", ms: 3000 });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /There is no "wait" step: every step already waits/);
  for (const real of ["goto", "click", "type", "press", "read", "look"]) assert.ok(text.includes(real), `lists ${real}`);
  assert.deepEqual(computer.calls, [], "the browser was never driven");
});

test("a key step is pointed at press, and fill_login at its own tool", async () => {
  assert.match((await ask({ do: "key", key: "Enter" })).result.content[0].text, /a key is a press step/);
  assert.match((await ask({ do: "fill_login" })).result.content[0].text, /fill_login is a tool of its own/);
});

test("a made-up step with no hint still lists the real steps, and odd names stay short", () => {
  const steps = new Set(["goto", "click"]);
  assert.equal(notAStep("teleport", steps), 'There is no "teleport" step. The steps are goto, click.');
  assert.equal(notAStep("x".repeat(50), steps), `There is no "${"x".repeat(20)}" step. The steps are goto, click.`);
  assert.equal(notAStep(undefined, steps), 'There is no "undefined" step. The steps are goto, click.');
  assert.equal(notAStep("constructor", steps), 'There is no "constructor" step. The steps are goto, click.');
  assert.match(notAStep("WAIT", steps), /every step already waits/);
});
