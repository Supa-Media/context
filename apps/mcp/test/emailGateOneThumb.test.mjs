/**
 * ONE 👍 SENDS IT (the owner, 2026-10-23: "tex asked for like 4 confirmations
 * again if this happens again I will rip your hard drives").
 *
 * The Anthropic receipt forward to Relay, replayed. Tex brought it up after a
 * "nah" about something else; the Mail checker found no ask for it in the
 * texts and said "no"; the gate told Tex to ask in its own words, with
 * nothing held; the 👍 on that reached the checker as a bare "👍" and was
 * refused again; Tex re-offered ("Say yes and I'll forward it"); only the
 * third 👍, on the gateway's own ask, sent it (`src/tools/emailGate.js`,
 * `src/agent/mailChecker.js`, `src/tools/likedPreview.js`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. An "unasked" checker verdict refused like a "no". → `an email Tex
 *     proposes on its own is held and shown whole…` fails (2026-10-23).
 *  2. `agreedToForward` never consulted. → `the 👍 on Tex's offer to forward
 *     sends the forward at once…` fails.
 *  3. `agreedToForward` without the checker's "yes". → `a 👍 on an offer to
 *     forward sends it only when the Mail checker says they asked` fails.
 *  4. The claim check bouncing an offer after a checker "no". → `a checker no
 *     asks in one short text, which the claim check lets go` fails.
 *  5. `checkerQuestion` dropping the words a 👍 was on. → `the Mail checker
 *     reads the 👍 with the words it was on` fails.
 */

import { ask, request, createEgressWorld, TOKEN_TEXTS } from "./agentEgressFixtures.mjs";

const verdict = (value, reason = "") => ({ text: JSON.stringify({ verdict: value, reason }) });
const isChecker = (body) => JSON.stringify(body?.system ?? "").includes("You check one email");
const FORWARD = {
  to: ["books@receipts.example"],
  subject: "Fwd: Your receipt from Anthropic #2508-0278-2435",
  body: "Receipt for the Supa Media books.",
  forward: "email:seyi@gmail.example/18rcpt",
};

export async function runEmailGateOneThumbChecks(check) {
  const world = await createEgressWorld();
  const { model, env, pending, controlPlane } = world;
  const sends = () => controlPlane.emailCalls.filter((entry) => !entry.check);
  try {
    controlPlane.flags.emailSender = "seyi@gmail.example";

    /* ---- the owner, 2026-10-23 8:33 AM: "tex asked for like 4 confirmations again" ---- */

    // "nah" to something else; Tex brings up the Relay forward it never sent. The Mail checker finds no ask for it in
    // these texts: it said "no", Tex asked in its own words with nothing held, and each 👍 only raised the next ask.
    controlPlane.flags.mailMessage = {
      address: "seyi@gmail.example",
      id: "18rcpt",
      from: "Anthropic <invoice@billing.example>",
      subject: "Your receipt from Anthropic #2508-0278-2435",
      body: "Paid $212.00.",
      attachments: [{ filename: "Receipt-2508-0278-2435.pdf", contentType: "application/pdf" }],
    };
    const RELAY = { ...FORWARD, to: ["supa.media.llc@receipts.relay.example"], body: "Forwarding the Anthropic receipt #2508-0278-2435 for the $212.00 Max plan." };
    model.install([
      { toolCalls: [{ name: "send_email", args: RELAY }] },
      verdict("unasked", "nothing in these texts asks to send this receipt"),
      { text: "The Relay receipt still hasn't gone out, so I drafted the forward." },
    ]);
    const relaySends = sends().length;
    const proposed = await ask(env, TOKEN_TEXTS, "nah");
    const proposedAsk = proposed.body?.verbatim?.[0] ?? "";
    check(
      "an email Tex proposes on its own is held and shown whole, never refused into an ask in Tex's words",
      sends().length === relaySends && proposed.body?.asked === 1 && proposedAsk.startsWith("Here's the email I'd send:") && proposedAsk.includes("Receipt-2508-0278-2435.pdf"),
    );
    let relayModel = model.requests.length;
    await request(env, TOKEN_TEXTS, "/agent", { question: "👍", quoted: proposedAsk, tapback: "Liked", conversation: "texts" });
    check(
      "its first 👍 sends it, with no model and no second ask",
      model.requests.length === relayModel && sends().length === relaySends + 1 && sends().at(-1)?.email?.forward === "18rcpt" && pending().length === 0,
    );

    // A checker "no" still refuses, and Tex asks in one short text: the 👍 on that text sends the forward.
    // Another copy: the one above went within the hour, and is answered as sent rather than sent twice.
    const AGAIN = { ...RELAY, body: "The Anthropic receipt for the Supa Media books." };
    const OFFERED = "The Relay receipt still hasn't gone out. Do you want me to send it to supa.media.llc@receipts.relay.example?";
    model.install([
      { toolCalls: [{ name: "send_email", args: AGAIN }] },
      verdict("no", "they were asking about Kansi's receipt"),
      { text: OFFERED },
    ]);
    relayModel = model.requests.length;
    const offeredTurn = await ask(env, TOKEN_TEXTS, "what about the kansi receipt");
    const refusedRound = JSON.stringify(model.requests.at(-1)?.messages ?? []);
    check(
      "a checker no asks in one short text, which the claim check lets go (no extra round)",
      (offeredTurn.body?.answer ?? "").includes("Do you want me to send it to") &&
        model.requests.length === relayModel + 3 &&
        refusedRound.includes("Their 👍 or yes to that text sends it") &&
        !refusedRound.includes("Show them the draft") &&
        pending().length === 0,
    );
    model.install([{ toolCalls: [{ name: "send_email", args: AGAIN }] }, verdict("yes"), { text: "Sent ✓" }]);
    const likedSends = sends().length;
    const likedOffer = await request(env, TOKEN_TEXTS, "/agent", { question: "👍", quoted: OFFERED, tapback: "Liked", conversation: "texts" });
    const offerChecker = model.requests.filter(isChecker).at(-1);
    check(
      "the 👍 on Tex's offer to forward sends the forward at once, with no second ask",
      sends().length === likedSends + 1 && sends().at(-1)?.email?.forward === "18rcpt" && pending().length === 0 && likedOffer.body?.asked === 0,
    );
    check(
      "the Mail checker reads the 👍 with the words it was on",
      JSON.stringify(offerChecker?.messages ?? []).includes("PERSON: 👍 (they tapped Liked on the assistant's text:"),
    );

    // Not when the offer named someone else, nor when the checker isn't sure they asked: then the forward is held and asked about.
    model.install([{ toolCalls: [{ name: "send_email", args: { ...AGAIN, to: ["other@relay.example"] } }] }, verdict("yes"), { text: "Drafted." }]);
    let heldSends = sends().length;
    const otherAddress = await request(env, TOKEN_TEXTS, "/agent", { question: "👍", quoted: OFFERED, tapback: "Liked", conversation: "texts" });
    check(
      "a 👍 on an offer to one address never forwards to another",
      sends().length === heldSends && otherAddress.body?.asked === 1 && pending().length === 1,
    );
    await ask(env, TOKEN_TEXTS, "no");
    model.install([{ toolCalls: [{ name: "send_email", args: AGAIN }] }, verdict("unsure", "not clear"), { text: "Drafted." }]);
    heldSends = sends().length;
    const doubted = await request(env, TOKEN_TEXTS, "/agent", { question: "👍", quoted: OFFERED, tapback: "Liked", conversation: "texts" });
    check(
      "a 👍 on an offer to forward sends it only when the Mail checker says they asked",
      sends().length === heldSends && doubted.body?.asked === 1 && pending().length === 1,
    );
    await ask(env, TOKEN_TEXTS, "no");
    controlPlane.flags.mailMessage = null;
  } finally {
    world.restore();
  }
}
