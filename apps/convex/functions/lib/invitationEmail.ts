/**
 * The words, the link, and the clock of an invitation email.
 *
 * Pure: no `ctx`, no database, no `fetch`. The same reasoning that keeps
 * `lib/invitees.ts` unable to reach a database applies here for a different
 * reason — everything this module interpolates is a string somebody typed, and
 * a string somebody typed is about to become an HTML document and a Subject
 * header addressed to a third party. Keeping the rendering in a file with no
 * `ctx` in it means the escaping can be asserted directly, and cannot quietly
 * grow a database read that decides what the email says.
 *
 * ## What an invitation email may contain, and why the list is short
 *
 * The inviter (display name and `@handle`), the context's display name, the
 * link, and the expiry. That is the whole set.
 *
 * It is short because the recipient is an **unauthenticated address**. Nobody
 * has proved they hold that mailbox — the inviter typed it, possibly wrongly,
 * possibly deliberately. A note count, a folder listing, the names of the other
 * members, or any hint that the recipient does or does not already have an
 * account would each be a fact about a private context, or about a person,
 * delivered to whoever actually reads that inbox. `@name` is also a subdomain
 * and a mail address, so "does this person exist" is exactly the question the
 * control plane's byte-identical errors and the frozen link previews exist to
 * refuse. An email is not a smaller version of that question.
 *
 * The one thing that legitimately differs between recipients is whether the
 * link carries a `?code=` — see `functions/invitationEmail.ts`. The bodies are
 * otherwise identical byte for byte, and a test asserts it.
 *
 * ## Two injections, two different defences
 *
 * A display name reaching the HTML body is **escaped**, so `<script>` arrives
 * as text. A display name reaching the Subject is **stripped** of control
 * characters, because escaping does nothing for a header: a bare `\r\n` in a
 * subject is how a second header gets appended by a caller who never intended
 * to have one. Both run on every interpolated value, not on the ones that
 * looked risky.
 */

import { APP_ORIGIN_ENV_VAR } from "./gatewayAuth";

/**
 * How long the sign-in code that travels in the link stays usable.
 *
 * Deliberately much shorter than the invitation's week (`INVITATION_TTL_MS`),
 * and the difference is not tidiness. The proof a magic link rests on is the
 * same one the ordinary sign-in OTP rests on — possession of the mailbox — but
 * a link is *replayable and forwardable* in a way a ten-minute code typed into
 * a form is not. It sits in an inbox, gets forwarded into a thread, ends up in
 * a backup. A week of that is a week of a live credential in other people's
 * archives.
 *
 * Past 24 hours the link still works as an **invitation**; it just stops
 * signing anybody in and lands on the ordinary sign-in screen instead. Nothing
 * is lost but the shortcut.
 */
export const SIGNIN_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The most header text one interpolated value may contribute.
 *
 * A display name is user input with a schema bound, not a bounded field here.
 * A subject line is not the place to discover that.
 */
const MAX_HEADER_TEXT = 200;

/** The five facts an invitation email is built from. Adding a sixth is a decision. */
export interface InvitationEmailFacts {
  /** The inviter's display name, or `null` if their account has none. */
  inviterName: string | null;
  /** Their handle, undecorated (`ada`, not `@ada`), or `null` if they have none. */
  inviterHandle: string | null;
  /** The context's display name. */
  workspaceName: string;
  /** Where the invitation is answered. Built by `invitationUrlFor`. */
  url: string;
  /** When the invitation stops being answerable, epoch ms. */
  expiresAt: number;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Make a user-supplied string safe to put in a header.
 *
 * Control characters — CR and LF above all — become spaces rather than being
 * dropped, so `Ada\r\nBcc: …` cannot silently close up into something that
 * reads like a single plausible name. Runs of whitespace collapse, and the
 * result is bounded.
 */
export function sanitizeHeaderText(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_HEADER_TEXT);
}

/** The five characters that turn text into markup. */
export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * How the inviter is named.
 *
 * Both halves are optional in the data — an account can exist with no display
 * name, and somebody who has only ever been added to other people's contexts
 * has no handle of their own. Every combination renders as something a person
 * can read, and none of them falls back to the inviter's email address: who
 * invited you is a fact the product owes you; what their mailbox is, is not.
 */
export function describeInviter(
  name: string | null,
  handle: string | null,
): string {
  const cleanName = name === null ? "" : sanitizeHeaderText(name);
  const cleanHandle = handle === null ? "" : sanitizeHeaderText(handle);
  if (cleanName.length > 0 && cleanHandle.length > 0) {
    return `${cleanName} (@${cleanHandle})`;
  }
  if (cleanName.length > 0) return cleanName;
  if (cleanHandle.length > 0) return `@${cleanHandle}`;
  return "Someone";
}

/**
 * The expiry, as a plain UTC date.
 *
 * Not a locale-formatted date: this runs in the Convex action runtime, in
 * `@edge-runtime/vm` under test, and the recipient's locale is not something we
 * know. `2026-09-03 (UTC)` is unambiguous everywhere and identical for
 * everybody, which also keeps two rendered bodies comparable byte for byte.
 */
export function formatExpiryDate(expiresAt: number): string {
  return new Date(expiresAt).toISOString().slice(0, 10);
}

/**
 * When the emailed sign-in code should stop working, or `null` for "do not
 * mint one".
 *
 * Bounded twice, and both bounds matter. Twenty-four hours is the rule above.
 * Strictly inside the invitation's own expiry is the second: a code that
 * outlived the offer it was mailed with would be a bare credential with nothing
 * left to accept, which is exactly the thing this design refuses to make the
 * invitation token into.
 */
export function signInCodeExpiry(
  now: number,
  invitationExpiresAt: number,
): number | null {
  const bounded = Math.min(now + SIGNIN_CODE_TTL_MS, invitationExpiresAt - 1);
  return bounded > now ? bounded : null;
}

/**
 * The configured app origin, or `null` if this deployment has not given us one
 * we are willing to put in a stranger's inbox.
 *
 * Separated from `invitationUrlFor` because the two callers want opposite
 * things from the same rule. A *link builder* wants to refuse loudly; the
 * *sender* wants to find out before it spends anything, because whether
 * `APP_ORIGIN` is set is a fact about the deployment rather than about the
 * invitation — it is identical for every row, and an invitation dropped for it
 * is one that would have been fine an hour later. `sendInvitationEmail` checks
 * this alongside the Resend key, before `claimInvitationEmail` writes
 * `emailSentAt`, so a misconfigured deployment leaves its invitations unspent
 * and mailable rather than burning every one of them identically and forever.
 *
 * Three ways to be unusable, and the third is the one that is easy to miss:
 * unset or empty, not https, and *not a URL at all* — `new URL("app.example")`
 * throws, and a `TypeError` out of a string somebody typed into a dashboard is
 * the same outage as the other two.
 */
export function validAppOrigin(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const origin = env[APP_ORIGIN_ENV_VAR];
  if (typeof origin !== "string" || origin.length === 0) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  // https is not negotiable for a URL that may carry a sign-in code.
  return url.protocol === "https:" ? origin : null;
}

/**
 * Where the invitation is answered.
 *
 * Throws rather than guessing, exactly as `consentUrlFor` does and for the same
 * reason: this URL goes into an email we send to an address we do not control.
 * A guessed origin is a link with our name on it pointing somewhere we do not
 * own, and https is not negotiable for a URL that may carry a sign-in code.
 *
 * The throw is a real refusal and stays one — but it is no longer reachable
 * from `sendInvitationEmail`, which checks `validAppOrigin` first and hands the
 * result back in `env`. What is validated and what is built are the same
 * string, so the check cannot pass for one origin and the build run against
 * another.
 *
 * The token goes in the **path** and the code, when there is one, in the query.
 * That is the shape `@convex-dev/auth`'s client already reads: it takes a
 * `code` query parameter on mount, signs in with it, and strips it from the
 * URL, leaving the invitation route to do the rest.
 */
export function invitationUrlFor(
  token: string,
  code: string | null,
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env[APP_ORIGIN_ENV_VAR];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`${APP_ORIGIN_ENV_VAR} is not set`);
  }
  const origin = validAppOrigin(env);
  if (origin === null) {
    throw new Error(`${APP_ORIGIN_ENV_VAR} must be an https origin`);
  }
  const url = new URL(origin);
  // Encoded rather than trusted. Tokens are hex today; a path segment built by
  // concatenation is how that stops being true without anybody noticing.
  url.pathname = `/invite/${encodeURIComponent(token)}`;
  url.search = "";
  url.hash = "";
  if (code !== null) url.searchParams.set("code", code);
  return url.toString();
}

/**
 * Render the email.
 *
 * Deliberately plain — one paragraph, one link, one expiry. There is no
 * unsubscribe footer because there is no list: this is a one-off message
 * somebody with a verified account addressed to this mailbox, and the recipient
 * ignoring it is the whole of the opt-out.
 */
export function renderInvitationEmail(facts: InvitationEmailFacts): RenderedEmail {
  const inviter = describeInviter(facts.inviterName, facts.inviterHandle);
  const context = sanitizeHeaderText(facts.workspaceName);
  const expiry = formatExpiryDate(facts.expiresAt);
  const subject = sanitizeHeaderText(
    `${inviter} invited you to ${context} on Context`,
  );

  const text = [
    `${inviter} invited you to ${context} on Context.`,
    "",
    "Open the invitation:",
    facts.url,
    "",
    `The invitation expires on ${expiry} (UTC).`,
    "If you were not expecting this, you can ignore this email.",
    "",
    "Context — free your context, share your context.",
  ].join("\n");

  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.5;color:#111">',
    `<p>${escapeHtml(inviter)} invited you to <strong>${escapeHtml(context)}</strong> on Context.</p>`,
    `<p><a href="${escapeHtml(facts.url)}">Open the invitation</a></p>`,
    `<p style="color:#555;font-size:14px">The invitation expires on ${expiry} (UTC). If you were not expecting this, you can ignore this email.</p>`,
    '<p style="color:#555;font-size:14px">Context — free your context, share your context.</p>',
    "</div>",
  ].join("");

  return { subject, html, text };
}
