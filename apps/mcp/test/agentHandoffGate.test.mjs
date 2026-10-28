/**
 * The browser is handed over only for what the page shows is the person's
 * (`src/agent/handoffGate.js`), after the owner's chat of 2026-10-27: Tex
 * filled a conference's registration form, its Register click ran out of
 * time, and it texted "Open this to take over the browser" for a form with
 * nothing on it only they could do.
 *
 * Sabotage record: with the `handoffIsTheirs` check in `browse.js` removed,
 * "a registration form is never handed over" fails on the texted link and the
 * handoff read; with `NOT_A_SIGN_IN_CODE` removed, the zip-code form is
 * handed over.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { webSession } from "../src/agent/computer.js";
import { BROWSE_TOOL } from "../src/agent/browse.js";
import { NOT_THEIRS, handoffIsTheirs } from "../src/agent/handoffGate.js";

const FORM = "https://register.example.org/conference";

/** A registration form like the one in the owner's chat. */
const REGISTRATION = [
  { ref: 1, kind: "input text", label: "First name", filled: true },
  { ref: 2, kind: "input text", label: "Last name", filled: true },
  { ref: 3, kind: "input email", label: "Email", filled: true },
  { ref: 4, kind: "input tel", label: "Phone", filled: true },
  { ref: 5, kind: "input radio", label: "First time at the conference? No" },
  { ref: 6, kind: "input radio", label: "Do you want to be baptized? No" },
  { ref: 7, kind: "input radio", label: "Do you need transportation or childcare? No" },
  { ref: 8, kind: "select", label: "School: Graduated/Working Professional" },
  { ref: 9, kind: "button", label: "Register" },
];

function formComputer(elements, text = "Register for the conference.") {
  const calls = [];
  return {
    calls,
    canHandOff: () => true,
    mayResume: () => true,
    async readPage(url) {
      return { url, title: "", text: "", links: [] };
    },
    async browse(session, steps, options) {
      calls.push({ steps: steps.map((s) => s.do), handoff: options?.handoff === true });
      return {
        session: "sess-form-0001",
        ran: steps.map((step) => ({ do: step.do, ok: true })),
        page: { url: FORM, title: "Registration", text, truncated: false, elements },
        ...(options?.handoff ? { handoffUrl: "https://context.lc/tex/maya" } : {}),
      };
    },
    async closeBrowser() {},
  };
}

const openThenHandOver = { steps: [{ do: "goto", url: FORM }, { do: "click", ref: 9 }, { do: "handoff" }] };

test("a registration form is never handed over: no link is texted and the model is told to finish it", async () => {
  const computer = formComputer(REGISTRATION);
  const said = [];
  const web = webSession(computer, `register me on ${FORM}, not my first time, no baptism, no transport, graduated`, {
    say: async (line) => {
      said.push(line);
      return true;
    },
  });
  const result = await web.call(BROWSE_TOOL, openThenHandOver);
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes(NOT_THEIRS));
  assert.deepEqual(said, [], "no take-over link was texted");
  assert.ok(computer.calls.every((c) => !c.handoff), "the browser was never asked for a handoff link");
  assert.equal(web.browser.handoffLine(), null);
  assert.equal(web.browser.handoffLink(), null);
});

test("a form's zip, promo or discount code is not a sign-in code", () => {
  for (const label of ["Zip code", "Postal code", "Promo code", "Discount code"]) {
    const reading = { text: "Register", elements: [...REGISTRATION, { ref: 10, kind: "input text", label }] };
    assert.equal(handoffIsTheirs({ reading }), false, label);
  }
});

test("a sign-in, a code, a captcha, a card or their own ask is still theirs", () => {
  const page = (elements, text = "") => ({ reading: { text, elements } });
  assert.equal(handoffIsTheirs(page([{ ref: 1, kind: "input password", label: "Password" }])), true, "a sign-in (K1)");
  assert.equal(handoffIsTheirs(page([{ ref: 1, kind: "input text", label: "Verification code" }])), true, "a code box (K2)");
  assert.equal(handoffIsTheirs(page([], "We sent a code to your phone. Enter the code to continue.")), true, "a page asking for a code (K2)");
  assert.equal(handoffIsTheirs(page([], "Check your phone and approve the sign-in.")), true, "an approval on their phone (K2)");
  assert.equal(handoffIsTheirs(page([], "Verify you are human")), true, "a captcha wall (K3)");
  assert.equal(handoffIsTheirs({ reading: { text: "", elements: REGISTRATION }, stuck: true }), true, "a captcha that outlasted every try (K3)");
  assert.equal(handoffIsTheirs(page([{ ref: 1001, kind: "input text", label: "Card number" }])), true, "a card box in a payment frame (Y1)");
  assert.equal(
    handoffIsTheirs({ reading: { text: "", elements: REGISTRATION }, theirWords: "I'd rather fill it in myself" }),
    true,
    "they asked to do it themselves",
  );
});

test("a page with a password box is handed over as before, and its link texted", async () => {
  const computer = formComputer([{ ref: 1, kind: "input email", label: "Email" }, { ref: 2, kind: "input password", label: "Password" }], "Sign in");
  const said = [];
  const web = webSession(computer, `sign in on ${FORM}`, {
    say: async (line) => {
      said.push(line);
      return true;
    },
  });
  const result = await web.call(BROWSE_TOOL, { steps: [{ do: "goto", url: FORM }, { do: "handoff" }] });
  assert.ok(!result.content[0].text.includes(NOT_THEIRS));
  assert.equal(said.length, 1);
  assert.match(said[0], /take over the browser on register\.example\.org/);
});

test("an email-first sign-in or a consent screen is a sign-in, by its title or address", () => {
  const email = [{ ref: 1, kind: "input email", label: "Email address" }];
  assert.equal(handoffIsTheirs({ reading: { url: "https://chat.example.com/auth/login", title: "Log in or sign up", text: "", elements: email } }), true);
  assert.equal(handoffIsTheirs({ reading: { url: "https://shop.example.com/x", title: "Sign in | Shop", text: "", elements: email } }), true);
  assert.equal(handoffIsTheirs({ reading: { url: "https://notes.example.com/authorize?client=a", title: "Allow ChatGPT", text: "", elements: [] } }), true);
  assert.equal(handoffIsTheirs({ reading: { url: "https://register.example.org/conference/register", title: "Registration", text: "Sign in for faster checkout", elements: REGISTRATION } }), false, "a sign-in link in a form's words is not a sign-in page");
});
