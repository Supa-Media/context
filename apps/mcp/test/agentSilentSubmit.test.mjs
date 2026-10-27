/**
 * A send button a hidden captcha turns away without a word
 * (`src/agent/silentSubmit.js`), after the owner's registration form of
 * 2026-10-27: Register did nothing twice, the captcha tries never ran, the
 * handoff was refused, and Tex texted the person the whole form to fill in.
 *
 * Sabotage record: with `submits.settle` taken out of `browse.js`, "a
 * Register press that does nothing twice..." fails on the missing fresh
 * browser and the refused handoff; with the `invisible` check in
 * `silentSubmit.js` dropped, "a form with no hidden captcha..." fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { webSession } from "../src/agent/computer.js";
import { BROWSE_TOOL } from "../src/agent/browse.js";
import { NOT_THEIRS } from "../src/agent/handoffGate.js";
import { SUBMIT_CLEARED_LINE, SUBMIT_STUCK_LINE, pressedSend } from "../src/agent/silentSubmit.js";

const FORM = "https://register.example.org/conference";

const ELEMENTS = [
  { ref: 1, kind: "input text", label: "First name" },
  { ref: 2, kind: "input email", label: "Email" },
  { ref: 3, kind: "select", label: "School" },
  { ref: 4, kind: "button", label: "Register" },
];

/**
 * A registration form whose Register press goes nowhere while `turnsAway`
 * says so for that browser (1 for the first, 2 for a fresh one), and says
 * whether a hidden captcha is on it.
 */
function formComputer({ invisible = true, turnsAway = () => true } = {}) {
  const calls = [];
  let browser = 1;
  let url = null;
  return {
    calls,
    canHandOff: () => true,
    mayResume: () => true,
    async readPage(u) {
      return { url: u, title: "", text: "", links: [] };
    },
    async browse(session, steps, options) {
      if (options?.fresh) browser += 1;
      calls.push({ steps: steps.map((s) => s.do), fresh: options?.fresh === true, handoff: options?.handoff === true, browser });
      for (const step of steps) {
        if (step.do === "goto") url = step.url;
        if (step.do === "click" && step.ref === 4 && !turnsAway(browser)) url = `${FORM}/registered`;
      }
      const done = url.endsWith("/registered");
      return {
        session: `sess-${browser}`,
        ran: steps.map((step) => ({ do: step.do, ok: true })),
        page: { url, title: done ? "You're registered" : "Register", text: done ? "You're registered." : "Register for the conference.", truncated: false, elements: done ? [] : ELEMENTS },
        ...(invisible && !done && !options?.handoff ? { invisibleCaptcha: true } : {}),
        ...(options?.handoff ? { handoffUrl: "https://context.lc/tex/maya" } : {}),
      };
    },
    async closeBrowser() {},
  };
}

const fill = [
  { do: "type", ref: 1, text: "Maya" },
  { do: "type", ref: 2, text: "maya@example.invalid" },
  { do: "select", ref: 3, option: "Graduated" },
  { do: "click", ref: 4 },
];
const ask = `register me on ${FORM}, I'm Maya, maya@example.invalid, graduated`;

test("a send button is known by its words, or by Enter", () => {
  assert.equal(pressedSend([{ do: "click", ref: 4 }], ELEMENTS), true);
  assert.equal(pressedSend([{ do: "click", text: "Sign up" }, { do: "read" }], ELEMENTS), true);
  assert.equal(pressedSend([{ do: "press", key: "Enter" }], ELEMENTS), true);
  assert.equal(pressedSend([{ do: "click", ref: 3 }], ELEMENTS), false, "a menu is not a send button");
  assert.equal(pressedSend([{ do: "type", ref: 1, text: "Maya" }], ELEMENTS), false);
});

test("a Register press that does nothing twice on a hidden-captcha page is tried in a fresh browser, filled the same way", async () => {
  const computer = formComputer({ turnsAway: (browser) => browser === 1 });
  const web = webSession(computer, ask);
  await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: FORM }, { do: "read" }] });
  await web.call(BROWSE_TOOL, { steps: fill });
  const second = await web.call(BROWSE_TOOL, { steps: [{ do: "click", ref: 4 }] });
  const fresh = computer.calls.find((c) => c.fresh);
  assert.ok(fresh, "a fresh browser was asked for");
  assert.deepEqual(fresh.steps, ["goto", "type", "type", "select", "click"], "the page opened and the form filled the same way, then sent once");
  assert.ok(second.content[0].text.includes(SUBMIT_CLEARED_LINE));
  assert.match(second.content[0].text, /You're registered/);
});

test("when the fresh browser is turned away too, the one press is the person's, and the handoff goes through", async () => {
  const computer = formComputer();
  const said = [];
  const web = webSession(computer, ask, { say: async (line) => (said.push(line), true) });
  await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: FORM }, ...fill] });
  const second = await web.call(BROWSE_TOOL, { steps: [{ do: "click", ref: 4 }] });
  assert.ok(second.content[0].text.includes(SUBMIT_STUCK_LINE));
  assert.equal(second.captchaStuck, true);
  const handed = await web.call(BROWSE_TOOL, { steps: [{ do: "handoff" }] });
  assert.ok(!handed.content[0].text.includes(NOT_THEIRS));
  assert.equal(said.length, 1);
  assert.match(said[0], /take over the browser on register\.example\.org/);
});

test("a form with no hidden captcha is never tried again for it, and its handoff is still refused", async () => {
  const computer = formComputer({ invisible: false });
  const web = webSession(computer, ask);
  await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: FORM }, ...fill] });
  await web.call(BROWSE_TOOL, { steps: [{ do: "click", ref: 4 }] });
  assert.ok(!computer.calls.some((c) => c.fresh));
  const handed = await web.call(BROWSE_TOOL, { steps: [{ do: "handoff" }] });
  assert.ok(handed.content[0].text.includes(NOT_THEIRS));
});

test("one press that does nothing is not yet a captcha", async () => {
  const computer = formComputer();
  const web = webSession(computer, ask);
  const first = await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: FORM }, ...fill] });
  assert.ok(!computer.calls.some((c) => c.fresh));
  assert.ok(!first.content[0].text.includes(SUBMIT_STUCK_LINE));
});
