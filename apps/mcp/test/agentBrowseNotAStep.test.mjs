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
import { webSession } from "../../../packages/tex/gateway/agent/computer.js";
import { BROWSE_TOOL } from "../../../packages/tex/gateway/agent/browse.js";
import { notAStep } from "../../../packages/tex/gateway/agent/browseNotAStep.js";

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

test("a made-up step is told the real steps, a sleep is pointed at wait, and nothing runs", async () => {
  const { result, computer } = await ask({ do: "sleep", ms: 3000 });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /There is no "sleep" step: waiting is a wait step with seconds/);
  for (const real of ["goto", "click", "type", "press", "read", "wait", "look"]) assert.ok(text.includes(real), `lists ${real}`);
  assert.deepEqual(computer.calls, [], "the browser was never driven");
});

// 2026-11-16: a wait step is a real one now (`infra/site-shots/src/patience.ts`); one written in ms is taken in seconds.
test("a wait step written in milliseconds waits that many seconds", async () => {
  const { result, computer } = await ask({ do: "wait", ms: 3000 });
  assert.notEqual(result.isError, true);
  assert.deepEqual(computer.calls, [["goto", "wait"]]);
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
  assert.match(notAStep("SLEEP", steps), /every step already waits/);
});
