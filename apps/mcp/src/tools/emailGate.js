/**
 * THE SEND-REVIEW GATE: no email leaves without the person's yes to that exact
 * copy (decided by the owner, 2026-10-17;
 * `docs/decisions/communications/sending-email.md`).
 *
 * "If we just give a send email command to an agent who's working on a bunch
 * of stuff and context is muddied … it could just send what [the person]
 * doesn't want." So a `send_email` call never runs as it is made. It runs in
 * `egressGate` before anything else, and before the deployment's
 * `EGRESS_APPROVALS = "off"`, which switches off widening holds and not this:
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
 *      half an hour releases it; any other text disarms it, so a changed
 *      draft is a new ask. Another AI's email is answered in the app.
 *
 * Only the replay of an approved record (`session.egress.approved`) passes
 * through to `send_email` itself.
 */

import { DETAIL_CAP, createPending, findPending, rearmForText, takeDone } from "./approvals.js";
import { toolError } from "./results.js";
import { EMAIL_TOOL, REFUSED, emailCopy, emailSummary, readEmail } from "./email.js";
import { readHelperCallers } from "../agent/production.js";

export { EMAIL_TOOL };

export const MAIL_CHECKER = "mail-checker";
/** The longest copy a texted ask shows: one text, under the 3,000 a text keeps (`apps/agent/src/clients.ts`). */
export const TEXTED_COPY_CAP = 2_500;
/** Who may send when the Mail checker's note names nobody. */
export const DEFAULT_EMAIL_CALLERS = ["texting-assistant"];

const TEXTS_CLIENT_ID = "context_texts";
/**
 * First-party clients that never send: routines and dreams have nobody on the
 * line, and the app has no assistant of its own (deleted 2026-10-17); it is
 * where the person approves.
 */
const NEVER_SENDS = new Set(["context_routines", "context_dreams", "context_console"]);

/** The `callers:` key a connection asks as, or null for one that never may. */
export function emailCaller(clientId) {
  if (clientId === TEXTS_CLIENT_ID) return "texting-assistant";
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
  let room;
  try {
    room = await store.email.check(email);
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

  const texting = session.egress?.texting === true;
  let checked = null;
  if (texting) {
    checked = typeof session.mailChecker === "function" ? await session.mailChecker(email) : null;
    if (checked?.verdict === "no") {
      return toolError(
        `Not sent, and not put to the person: the Mail checker read their texts and says ${checked.reason || "they did not ask for this email"}. ` +
          "Show them the draft and ask whether they want it sent.",
      );
    }
  }

  const caveat =
    checked === null || checked.verdict === "yes"
      ? ""
      : `\n\n(Mail checker: ${checked.reason || "it could not tell whether you asked for this one"}.)`;
  const detail = `${emailCopy({ ...email, from: email.from ?? room.from })}${caveat}`;
  // The person may allow only what they read, so a copy the record would cut is never asked about.
  if (detail.length > DETAIL_CAP) return toolError("Not sent: this email is too long to show the person whole. Shorten it.");
  if (texting && detail.length > TEXTED_COPY_CAP) {
    return toolError(
      `Not sent: this email is too long to show the person whole in a text. Shorten it to under ${TEXTED_COPY_CAP.toLocaleString("en-US")} characters, or give them the draft.`,
    );
  }
  const existing = await findPending(store, { name: EMAIL_TOOL, args, userId: session.actorUserId });
  const record =
    (existing ? await rearmForText(store, existing, texting) : null) ??
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
    }));
  if (record === null) {
    return toolError("Not sent: the person has too many things waiting for their OK. Ask them to clear some first.");
  }
  const ledger = session.egress?.ledger ?? null;
  if (ledger && !ledger.asked.some((asked) => asked.id === record.id)) ledger.asked.push(record);
  return {
    ...toolError(
      texting
        ? "Not sent yet: the person will be shown this exact email and asked to reply YES to send it. " +
            "Say in a line what you drafted, without repeating the email. Don't call this again in this turn."
        : "Not sent yet: the person must approve this exact email in the Context app. " +
            "Once they have, call send_email again with exactly the same arguments and you will be told it was sent.",
    ),
    held: true,
  };
}
