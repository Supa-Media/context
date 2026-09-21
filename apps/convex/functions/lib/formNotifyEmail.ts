/**
 * The words of a form notification, and the bounds on what a stranger can put
 * in one.
 *
 * Pure, for the reason `lib/invitationEmail.ts` is pure and then one more.
 * There, everything interpolated is "a string somebody typed"; here everything
 * interpolated is a string **somebody with no account typed into a published
 * form**, and it is about to become an HTML document and a Subject header in
 * the owner's inbox. Keeping the rendering in a file with no `ctx` means the
 * escaping can be asserted directly against hostile fixtures, and cannot
 * quietly grow a database read that decides what the mail says.
 *
 * ## What a notification may contain
 *
 * The context's name, the form's id, who the answer is stamped as, when it
 * landed, a link to the responses note, and **the answers themselves**.
 *
 * The last one is a decision rather than a default, and the reason it is safe
 * to make here is that it is not made here: `functions/formNotify.ts` resolves
 * the recipient to a member of this workspace and re-derives, through the live
 * `privacy.md`, whether that member may read the responses note. A recipient
 * who may not is not mailed at all. So by the time facts reach this file, the
 * answers are going to somebody who could open the file and read the same
 * bytes — the mail is a faster path to something they already have, never a
 * wider one.
 *
 * What is absent, and required to stay absent: the recipient's address, any
 * other recipient, the form's other responses, the note's other contents, and
 * anything at all about the context beyond the one form. A notification is
 * about one answer.
 *
 * ## Two injections, two different defences
 *
 * Inherited wholesale from the invitation mail, because it is the same pair of
 * failures and there is no reason for a second answer to them:
 *
 *  - A value reaching the HTML body is **escaped**, so a submitted `<script>`
 *    arrives as text.
 *  - A value reaching the Subject is **stripped** of control characters,
 *    because escaping does nothing for a header: a bare `\r\n` in a subject is
 *    how a second header gets appended by a caller who never intended one.
 *
 * Both run on every interpolated value, not on the ones that looked risky. The
 * field *names* are `[a-z][a-z0-9_]{0,31}` and the form id is
 * `[a-z0-9][a-z0-9-]{0,39}`, so neither can carry anything — they are escaped
 * anyway, because "this one is already safe" is a claim that survives exactly
 * until somebody widens the grammar.
 *
 * ## Why there are caps, and why they are not the same cap
 *
 * A `text` field takes 20,000 characters and a form takes 24 fields, so one
 * answer is up to ~480KB of somebody else's prose. Mailing that is a bounced
 * message at best and a way to spend the owner's sending reputation at worst.
 *
 * So a single value is cut at `MAX_VALUE_CHARS` and the rendered set at
 * `MAX_BODY_CHARS`, and **a cut always says so and always leaves the link**.
 * The failure to avoid is not a long email, it is a truncated one that reads
 * complete: an owner who thinks they have read a client's brief when they have
 * read the first third of it has been told something false by their tools.
 */

import { escapeHtml, sanitizeHeaderText, validAppOrigin } from "./invitationEmail";
import type { RenderedEmail } from "./invitationEmail";

/** As much of one answer as goes in the mail. The rest is behind the link. */
const MAX_VALUE_CHARS = 2000;

/**
 * As much of all the answers together as goes in the mail.
 *
 * Smaller than `MAX_VALUE_CHARS * 24` on purpose: the per-value cut keeps one
 * verbose answer readable, and this one keeps a 24-field form from arriving as
 * a wall. Which fields survive is declaration order, which is the order the
 * person who built the form chose to ask in.
 */
const MAX_BODY_CHARS = 20000;

/** What a cut leaves behind, so nothing ever reads as whole when it is not. */
const CUT_MARKER = "… (cut — open the note for the whole answer)";

export interface FormAnswer {
  field: string;
  value: string;
}

/** Everything one notification is built from. Adding a field is a decision. */
export interface FormNotificationFacts {
  /** The context's display name. */
  workspaceName: string;
  /** Its slug, for the console link. Undecorated — `seyi`, not `@seyi`. */
  workspaceSlug: string;
  /** The form's declared id. */
  formId: string;
  /** The note the form block is on. */
  notePath: string;
  /** The note the answers were written to. */
  responsesPath: string;
  /**
   * Who the answer is recorded as, exactly as it was stamped into the file.
   *
   * A handle (`@dan`) for somebody with an account, or a link stamp (`via
   * @seyi/intake`) for a stranger. Passed through rather than re-derived,
   * because the mail and the file must not be able to disagree about who sent
   * something — and because a stamp is deliberately not a name.
   */
  by: string;
  /** The stored timestamp, as it appears in the responses file. */
  at: string;
  answers: FormAnswer[];
}

/**
 * Where the answers live, for somebody who is about to click.
 *
 * `null` when the deployment has no usable origin, and the callers render
 * without a link rather than refusing: a notification that arrives saying an
 * answer landed is worth more than no notification, and `invitationUrlFor`
 * throws in the same case only because *that* link is the entire message.
 *
 * The path goes in the query string through `URLSearchParams`, so a path
 * holding `&`, `#` or a space cannot end the parameter early. Paths are
 * bucket-relative and user-authored; this is the one place one becomes a URL.
 */
export function responsesUrlFor(
  workspaceSlug: string,
  responsesPath: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const origin = validAppOrigin(env);
  if (origin === null) return null;
  const url = new URL(origin);
  url.pathname = `/console/@${workspaceSlug}`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("note", responsesPath);
  return url.toString();
}

/** One value, cut to size, with the cut declared. */
function boundValue(raw: string): string {
  if (raw.length <= MAX_VALUE_CHARS) return raw;
  return `${raw.slice(0, MAX_VALUE_CHARS)}${CUT_MARKER}`;
}

/**
 * The answers that fit, and how many did not.
 *
 * Counted rather than silently dropped: "3 further answers are not shown here"
 * is a true sentence an owner can act on, and an absent field is not.
 */
function boundAnswers(answers: FormAnswer[]): { shown: FormAnswer[]; omitted: number } {
  const shown: FormAnswer[] = [];
  let used = 0;
  for (const answer of answers) {
    const value = boundValue(answer.value);
    const cost = answer.field.length + value.length;
    if (used + cost > MAX_BODY_CHARS && shown.length > 0) break;
    shown.push({ field: answer.field, value });
    used += cost;
  }
  return { shown, omitted: answers.length - shown.length };
}

/**
 * A field name as a person reads it.
 *
 * The grammar is `[a-z][a-z0-9_]{0,31}`, which is a column heading rather than
 * a label — `project_type` in an email reads as a database. Underscores become
 * spaces and the first letter is capitalised, and that is the whole transform:
 * anything cleverer would be guessing at somebody else's wording.
 */
function labelFor(field: string): string {
  const spaced = field.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * One notification, for one answer.
 *
 * The subject names the form and the context and nothing else. It deliberately
 * does **not** carry any of the answer: a subject line is the part of an email
 * that shows on a lock screen, gets quoted into calendar invitations and ends
 * up in notification history, and a client's brief or a bug reporter's
 * complaint arriving there is content leaving the boundary in the one place
 * the recipient cannot control.
 */
export function renderFormNotification(
  facts: FormNotificationFacts,
  env: Record<string, string | undefined> = process.env,
): RenderedEmail {
  const context = sanitizeHeaderText(facts.workspaceName);
  const subject = sanitizeHeaderText(`New ${facts.formId} answer in ${context}`);
  const link = responsesUrlFor(facts.workspaceSlug, facts.responsesPath, env);
  const { shown, omitted } = boundAnswers(facts.answers);

  const text = [
    `A new answer landed on the ${facts.formId} form in ${context}.`,
    "",
    `From: ${facts.by}`,
    `When: ${facts.at}`,
    "",
    ...shown.flatMap((answer) => [`${labelFor(answer.field)}:`, answer.value, ""]),
    ...(omitted > 0 ? [`${omitted} further answer(s) are not shown here.`, ""] : []),
    ...(link === null
      ? [`The answers are in ${facts.responsesPath}.`]
      : [`All the answers: ${link}`]),
    "",
    "You are getting this because this form names you. Remove the notify line",
    "from the form's note to stop it.",
  ].join("\n");

  const html = [
    `<p>A new answer landed on the <strong>${escapeHtml(facts.formId)}</strong> form in ${escapeHtml(context)}.</p>`,
    `<p>From ${escapeHtml(facts.by)} at ${escapeHtml(facts.at)}.</p>`,
    ...shown.map(
      (answer) =>
        `<p><strong>${escapeHtml(labelFor(answer.field))}</strong><br>` +
        // Newlines inside an answer are the submitter's paragraphs. Escaped
        // first, then turned into breaks — the other order is how a literal
        // `<br>` somebody typed becomes a line break, which is the mistake
        // `unescapeCell` has a fixture for on the storage side.
        `${escapeHtml(answer.value).replace(/\r?\n/g, "<br>")}</p>`,
    ),
    ...(omitted > 0 ? [`<p>${omitted} further answer(s) are not shown here.</p>`] : []),
    ...(link === null
      ? [`<p>The answers are in ${escapeHtml(facts.responsesPath)}.</p>`]
      : [`<p><a href="${escapeHtml(link)}">All the answers</a></p>`]),
    `<p style="color:#666;font-size:12px">You are getting this because this form names you. Remove the notify line from the form's note to stop it.</p>`,
  ].join("\n");

  return { subject, html, text };
}

/**
 * The one message that stands in for the answers a rate limit held back.
 *
 * Silence was the alternative and it is the worse one. A published form can
 * take answers faster than anybody wants mail, so a limit is not optional — but
 * a limit that drops notifications without a word means the difference between
 * "nothing arrived" and "a burst arrived and you were over your limit" is
 * invisible to the person the form belongs to. One message per window, naming
 * the count, keeps the inbox bounded and the fact visible.
 *
 * It carries **no answers at all**, and not because they would not fit: a
 * digest is sent precisely when a lot of them landed, and a mail containing
 * twenty strangers' briefs is a different object from one containing one.
 */
export function renderFormDigest(
  facts: {
    workspaceName: string;
    workspaceSlug: string;
    formId: string;
    responsesPath: string;
    count: number;
  },
  env: Record<string, string | undefined> = process.env,
): RenderedEmail {
  const context = sanitizeHeaderText(facts.workspaceName);
  const subject = sanitizeHeaderText(
    `${facts.count} more ${facts.formId} answers in ${context}`,
  );
  const link = responsesUrlFor(facts.workspaceSlug, facts.responsesPath, env);
  const sentence =
    `${facts.count} further answer(s) landed on the ${facts.formId} form while ` +
    "notifications were over their limit, so they were not mailed one by one.";

  const text = [
    sentence,
    "",
    ...(link === null
      ? [`They are in ${facts.responsesPath}.`]
      : [`Read them: ${link}`]),
  ].join("\n");

  const html = [
    `<p>${escapeHtml(sentence)}</p>`,
    ...(link === null
      ? [`<p>They are in ${escapeHtml(facts.responsesPath)}.</p>`]
      : [`<p><a href="${escapeHtml(link)}">Read them</a></p>`]),
  ].join("\n");

  return { subject, html, text };
}
