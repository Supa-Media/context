/**
 * THE SEND-REVIEW GATE: no email leaves without the person's yes to that exact
 * copy (decided by the owner, 2026-10-17;
 * `docs/decisions/communications/sending-email.md`).
 *
 * "If we just give a send email command to an agent who's working on a bunch
 * of stuff and context is muddied … it could just send what [the person]
 * doesn't want." So a `send_email` call never runs as it is made. It runs in
 * `egressGate` before anything else:
 *
 *   1. The email is checked as the control plane will check it, and the
 *      limits are asked about without spending them, so the person is never
 *      asked to approve something that would be refused.
 *   2. The caller must be one the Mail checker's `callers:` names (the AI
 *      tab's switches, `@context-lc ai/agents/mail-checker.md`); with no note,
 *      Tex only. A routine or a dream has no person on the line and never may.
 *   3. On a texted turn the Mail checker (`agent/mailChecker.js`) reads the
 *      person's own texts and the draft, and refuses an email they did not ask
 *      for, or one whose recipient, words or timing differ from what they said.
 *   4. The call is held as a pending approval whose record carries the whole
 *      email, which the person reads before their YES. A texted YES within
 *      twelve hours releases it; any other text disarms it, so a changed
 *      draft is a new ask. Another AI's email is answered in the app.
 *
 * Only the replay of an approved record (`session.egress.approved`) passes
 * through to `send_email` itself.
 */

import { DETAIL_CAP, callKey, createPending, findPending, takeDone } from "./approvals.js";
import { toolError } from "./results.js";
import { EMAIL_TOOL, REFUSED, emailCopy, emailSummary, readEmail } from "./email.js";
import { readHelperCallers } from "../agent/production.js";
import { parseEmailId } from "./emailRead.js";
import { standingForward } from "./forwardRule.js";
import { attachedFiles } from "./emailAttach.js";

export { EMAIL_TOOL };

export const MAIL_CHECKER = "mail-checker";
/** The longest copy a texted ask shows: one text, under the 3,000 a text keeps (`apps/agent/src/clients.ts`). */
export const TEXTED_COPY_CAP = 2_500;
/** Who may send when the Mail checker's note names nobody. */
export const DEFAULT_EMAIL_CALLERS = ["texting-assistant"];

const TEXTS_CLIENT_ID = "context_texts";
/**
 * A group chat's Tex sends as its tagger, from their own Gmail, on their yes
 * in the chat (the owner, 2026-10-21: "email too, write only not read";
 * `agent/groupTurn.js`). It is Tex, so it asks as Tex.
 */
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";
/**
 * First-party clients that never send: routines and dreams have nobody on the
 * line, and the app has no assistant of its own (deleted 2026-10-17); it is
 * where the person approves.
 */
const NEVER_SENDS = new Set(["context_routines", "context_dreams", "context_console"]);

/** The `callers:` key a connection asks as, or null for one that never may. */
export function emailCaller(clientId) {
  if (clientId === TEXTS_CLIENT_ID || clientId === TEXTS_GROUP_CLIENT_ID) return "texting-assistant";
  if (typeof clientId !== "string" || clientId === "" || NEVER_SENDS.has(clientId)) return null;
  return "connected-ais";
}

/**
 * `null` to let an approved replay through to `send_email`, or the answer to
 * give instead: a refusal, a released result, or a hold.
 */
export async function emailGate(supplied, { store, session, target }) {
  if (session.egress?.approved === true) return null;

  if (target.workspaceId !== session.workspaceId) {
    return toolError("Not sent: send_email takes no context. It always sends as the person, from their own Gmail.");
  }
  const read = readEmail(supplied);
  if (read.error) return toolError(`Not sent: ${read.error}`);
  const email = read.email;

  // A routine forwarding under a rule the person 👍'd once (`forwardRule.js`); any other routine send is refused below.
  const standing = await standingForward(store, session, supplied, email);
  if (standing !== null) return standing;

  // A connected AI calling again after the person approved it in the app.
  const released = await takeDone(store, {
    name: EMAIL_TOOL,
    args: supplied,
    userId: session.actorUserId,
    clientId: session.actorClientId,
  });
  if (released) return released;

  const caller = emailCaller(session.actorClientId);
  const callers = (await readHelperCallers(store, session, MAIL_CHECKER)) ?? DEFAULT_EMAIL_CALLERS;
  if (caller === null || !callers.includes(caller)) {
    return toolError(
      "Not sent: this AI is not allowed to send email through Context. Give the person the draft to send themselves.",
    );
  }

  if (typeof store?.email?.check !== "function") return toolError(REFUSED.not_configured);
  // Files it attaches are shown by name, and must still be kept, before the person is asked.
  let attached = [];
  if (email.attach) {
    const files = await attachedFiles(store, email.attach);
    if (files.error) return toolError(`Not sent: ${files.error}.`);
    attached = files.files.map((file) => file.filename);
  }
  const { attach: _ids, ...plain } = email;
  /*
    The Mail checker reads while the control plane checks the limits: each
    can take seconds, and one after the other they ran past the turn's limit
    for a call, so the email was neither held nor asked about and the person
    was told it "timed out" three times for one email (2026-10-22).
  */
  const texting = session.egress?.texting === true;
  // Not when this turn already asked about an email: the second is refused below, unread.
  const early = texting && typeof session.mailChecker === "function" && !session.egress?.ledger?.asked.some((asked) => asked.tool === EMAIL_TOOL);
  const checking = early ? Promise.resolve(session.mailChecker(email)).catch(() => null) : null;
  let room;
  try {
    room = await store.email.check(plain);
  } catch {
    room = { ok: false, refused: "unavailable" };
  }
  if (room?.ok !== true) return toolError(REFUSED[room?.refused] ?? REFUSED.unavailable);

  /*
    The sender the person is shown is the one that sends: an email that named
    none is held with the address the control plane chose, and if that mailbox
    is gone by the YES it is refused rather than sent from another.
  */
  const args = !email.from && typeof room.from === "string" ? { ...supplied, from: room.from } : supplied;
  // A connected AI calling again after the person approved the held copy.
  if (args !== supplied) {
    const releasedBound = await takeDone(store, { name: EMAIL_TOOL, args, userId: session.actorUserId, clientId: session.actorClientId });
    if (releasedBound) return releasedBound;
  }

  // A forward is shown with what goes below their words: the email's sender, subject and each attachment's name.
  let forwarded = null;
  if (email.forward) {
    const named = parseEmailId(String(supplied.forward).trim());
    let read;
    try {
      read = typeof store.email.read === "function" ? await store.email.read(named.address, named.messageId) : null;
    } catch {
      read = null;
    }
    if (read?.ok !== true) {
      const why = read?.refused === "not_found" ? "forward_not_found" : read?.refused === "reconnect_required" ? "reconnect_required" : "unavailable";
      return toolError(REFUSED[why]);
    }
    forwarded = read.message;
  }

  // One email per texted ask: two copies in one text could outgrow it, and one YES would send both.
  const ledger = session.egress?.ledger ?? null;
  if (texting && ledger?.asked.some((asked) => asked.tool === EMAIL_TOOL && asked.key !== callKey(EMAIL_TOOL, args))) {
    return toolError("Not sent: one email at a time by text. The person is already being shown another; ask about this one after they answer.");
  }
  let checked = null;
  if (texting) {
    checked = checking !== null ? await checking : typeof session.mailChecker === "function" ? await session.mailChecker(email) : null;
    if (checked?.verdict === "no") {
      return toolError(
        `Not sent, and not put to the person: the Mail checker read their texts and says ${checked.reason || "they did not ask for this email"}. ` +
          "Show them the draft and ask whether they want it sent.",
      );
    }
  }

  // An unsure or unchecked email is still put to the person, as the email
  // alone: the checker's reason is a model's guess, and texted beside the
  // copy it read as part of the email (2026-10-19).
  const detail = emailCopy({ ...email, from: email.from ?? room.from }, forwarded, attached);
  // The person may allow only what they read, so a copy the record would cut is never asked about.
  if (detail.length > DETAIL_CAP) return toolError("Not sent: this email is too long to show the person whole. Shorten it.");
  if (texting && detail.length > TEXTED_COPY_CAP) {
    return toolError(
      `Not sent: this email is too long to show the person whole in a text. Shorten it to under ${TEXTED_COPY_CAP.toLocaleString("en-US")} characters, or give them the draft.`,
    );
  }
  const existing = await findPending(store, { name: EMAIL_TOOL, args, userId: session.actorUserId });
  const record =
    existing?.record ??
    (await createPending(store, {
      name: EMAIL_TOOL,
      args,
      actor: store.actor,
      tier: session.scope,
      scopes: session.scopes,
      widening: { summary: emailSummary(email), audience: "outside" },
      detail,
      workspaceId: target.workspaceId,
      texting,
      armed: false, // armed by `textedAsk` once the ask goes out whole
    }));
  if (record === null) {
    return toolError("Not sent: the person has too many things waiting for their OK. Ask them to clear some first.");
  }
  if (ledger && !ledger.asked.some((asked) => asked.id === record.id)) ledger.asked.push(record);
  return {
    ...toolError(
      texting
        ? "Held for their 👍, and nothing failed: right after your answer they are texted this exact email and asked " +
            "for their 👍, and it sends then. Say in one short line what you drafted. Don't repeat the email, don't give " +
            "them a copy to send themselves, and don't call send_email again in this turn."
        : "Waiting for the person, and nothing failed: they must approve this exact email in the Context app. " +
            "Once they have, call send_email again with exactly the same arguments and you will be told it was sent.",
    ),
    held: true,
  };
}
