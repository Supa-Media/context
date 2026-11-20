/**
 * Several of the person's Gmails can send and the email names none: Tex is
 * told which can, and names one, before anything is held or sent. The control
 * plane used to pick the oldest by itself, and an approved send went from a
 * stale second Gmail and never reached the connected test account's Sent,
 * while the person was told "sent" (google-review rehearsal, 2026-11-19).
 *
 * ## Sabotage record
 *
 *   `choose_sender` dropped from the mail client's refusals
 *     → "the mail client keeps choose_sender and its senders" fails
 *   emailGate answering a refused check with `REFUSED[...]` again
 *     → "a texted email naming no sender is not held, and Tex is told which can send" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ask, request, createEgressWorld, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";
import { createEmailMethods } from "../src/controlPlane/email.js";
import { toolSaveEmailDraft, toolSendEmail } from "../src/tools/email.js";

const EMAIL = { to: ["jo@example.com"], subject: "Thursday", body: "Hi Jo,\n\nThursday at 3 works for me.\n\nSeyi" };
const SENDERS = ["old@gmail.example", "test@work.example"];
const text = (result) => result?.content?.[0]?.text ?? "";

test("the mail client keeps choose_sender and its senders, for a send and a draft", async () => {
  const methods = createEmailMethods({ post: async () => ({ ok: false, refused: "choose_sender", senders: [...SENDERS, 7] }) });
  assert.deepEqual(await methods.sendPersonEmail("token", "ws", EMAIL), { ok: false, refused: "choose_sender", senders: SENDERS });
  assert.deepEqual(await methods.savePersonEmailDraft("token", "ws", EMAIL), { ok: false, refused: "choose_sender", senders: SENDERS });
  // Any other refusal carries no senders.
  const other = createEmailMethods({ post: async () => ({ ok: false, refused: "no_sender", senders: SENDERS }) });
  assert.deepEqual(await other.sendPersonEmail("token", "ws", EMAIL), { ok: false, refused: "no_sender" });
});

test("send_email and save_email_draft name the Gmails that can, and never say it went", async () => {
  const store = { email: { send: async () => ({ ok: false, refused: "choose_sender", senders: SENDERS }), draft: async () => ({ ok: false, refused: "choose_sender", senders: SENDERS }) } };
  const sent = await toolSendEmail(store, EMAIL);
  assert.equal(sent.isError, true);
  assert.match(text(sent), /^Not sent: more than one of their Gmails can send \(old@gmail\.example, test@work\.example\)/);
  assert.match(text(sent), /with from set/);
  const saved = await toolSaveEmailDraft(store, EMAIL);
  assert.equal(saved.isError, true);
  assert.match(text(saved), /^Not saved: more than one of their Gmails can save drafts \(old@gmail\.example, test@work\.example\)/);
});

test("a texted email naming no sender is not held, and Tex is told which can send; naming one holds it from that one", async () => {
  const world = await createEgressWorld();
  const { model, env, pending, controlPlane } = world;
  try {
    controlPlane.flags.emailSenders = SENDERS;
    model.install([
      { toolCalls: [{ name: "send", args: { action: "email", args: EMAIL } }] },
      { text: JSON.stringify({ verdict: "yes", reason: "" }) },
      { toolCalls: [{ name: "send", args: { action: "email", args: { ...EMAIL, from: "test@work.example" } } }] },
      { text: JSON.stringify({ verdict: "yes", reason: "" }) },
      { text: "Drafted the reply to Jo from your work Gmail." },
    ]);
    const asked = await ask(env, TOKEN_TEXTS, "reply to Jo from my work gmail that Thursday at 3 works");
    assert.equal(asked.status, 200);
    const told = JSON.stringify(model.requests.map((request) => request.messages ?? []));
    assert.match(told, /more than one of their Gmails can send \(old@gmail\.example, test@work\.example\)/);
    // Nothing went, and the only hold is the one that names its sender.
    assert.equal(controlPlane.emailCalls.filter((call) => !call.check).length, 0);
    assert.equal(pending().length, 1);
    assert.match(asked.body?.answer ?? "", /From: test@work\.example\nTo: jo@example\.com/);
    assert.doesNotMatch(asked.body?.answer ?? "", /old@gmail\.example/);
  } finally {
    world.restore();
  }
});
