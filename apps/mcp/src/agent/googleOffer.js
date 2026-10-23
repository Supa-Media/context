/**
 * Tex offers to connect Google before the person has to ask (the owner,
 * 2026-10-23: "Blessing was already a context user. So once [she] texted
 * Tex ... she had to ask ... for a link to connect her Gmail ... make sure
 * that whenever someone texts, that it tells them, hey, connect your email,
 * so we can be proactive about this").
 *
 * Somebody set up by text is asked for Gmail by the "notes are ready" text
 * (`apps/agent/src/ready.ts`). Somebody who had Context before texting never
 * saw it, and somebody whose Gmail was connected before every connect asked
 * to send (2026-10-23, `WRITE_SCOPES` in Convex) can be read and not acted
 * for. On a texted turn this reads their mailboxes (`/gateway/mail-health`)
 * and, when either is so, adds a paragraph to its prompt asking the model to offer the link
 * once, after answering what they asked. The link's own result
 * (`tools/workspaces.js`) carries the warning about Google's unverified-app
 * screen, the "Select all" step and the picture of both.
 *
 * Quiet when the mailboxes cannot be read (a mailbox that cannot be checked
 * is never news), and when an answer in the chat already offered it, so it is
 * offered once and not on every text.
 */

/** Recent answers that offered Google already: the model is not asked again. */
const OFFERED = /connect[^\n]{0,80}\b(?:gmail|google)\b|\b(?:gmail|google)\b[^\n]{0,80}\b(?:connect|reconnect)/i;
/** How many of the latest answers count as recent. */
const RECENT_ANSWERS = 12;

function offeredAlready(history) {
  const answers = (Array.isArray(history) ? history : []).filter((turn) => turn?.role === "assistant").slice(-RECENT_ANSWERS);
  return answers.some((turn) => typeof turn.text === "string" && OFFERED.test(turn.text));
}

/** The paragraph for this texted turn's prompt, or "" when there is nothing to offer. */
export async function googleOfferLine(store, history) {
  if (typeof store?.mailHealth?.read !== "function" || offeredAlready(history)) return "";
  let mailboxes;
  try {
    mailboxes = await store.mailHealth.read();
  } catch {
    return "";
  }
  if (!Array.isArray(mailboxes)) return "";
  const offer =
    "After answering what they asked, offer it once in one short line, and if they want it, send the link from " +
    "manage connect_google (kind gmail) with the steps its result gives and its picture. Don't offer it again if they say not now.";
  if (mailboxes.length === 0) {
    return `\n\nGoogle: they have no Gmail connected yet, so you can't read their email or act for them in Google. ${offer}`;
  }
  if (mailboxes.some((mailbox) => mailbox.readOnly !== true)) return "";
  const address = mailboxes[0].address;
  return (
    `\n\nGoogle: their Gmail ${address} was connected before Context could send email, save drafts, change their calendar or ` +
    `message on Google Chat for them, so you can read it but not do those. One reconnect turns them on. ${offer}`
  );
}
