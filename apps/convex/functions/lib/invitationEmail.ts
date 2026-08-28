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
 * **The whole life of the invitation, and no longer** — the link works for as
 * long as the offer it was mailed with, and stops the moment either the offer
 * expires or somebody claims it.
 *
 * This was 24 hours, on the reasoning that a link is replayable and forwardable
 * in a way a typed code is not, so a week of it is a week of a live credential
 * sitting in other people's archives. That risk is real and unchanged. It was
 * overruled deliberately, and the trade is worth writing down rather than
 * rediscovering: at 24 hours the common case is somebody opening an invitation
 * on Tuesday that was sent on Sunday and being asked for a code anyway — an
 * invitation that half-works, which is the thing this whole flow exists to
 * remove. A link that expires before the invitation does is a link that mostly
 * expires.
 *
 * What carries the risk instead is **single use**. The code is spent by the
 * first claim: `verifyCodeOnly` deletes the `authVerificationCodes` row before
 * it validates anything else, so a forwarded copy of an opened link is inert,
 * and answering the invitation — accept, decline, or the owner revoking it —
 * deletes the row too (`invalidateInvitationSignInCode`). The window is seven
 * days of *unclaimed* link, not seven days of usable credential.
 *
 * Two limits still stand behind it: no code is minted for an address that
 * already has an account with any membership, so this is only ever a credential
 * into a brand-new empty account; and the code is ~190 bits.
 */
export const SIGNIN_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  /**
   * Whether the context is somebody's own or a shared one.
   *
   * Changes the sentence, not the facts. A personal context's display name is
   * its owner's handle, so "@ada invited you to ada" says the same word twice
   * and reads like a machine; and what the recipient actually gets is a
   * *team-tier* view of somebody's own working context, which is a far more
   * interesting thing to be offered than a name repeated back.
   *
   * This does disclose one bit — personal versus shared — to an address nobody
   * has verified. It is a deliberate trade, not an oversight: see the note on
   * `headlineFor`.
   */
  workspaceKind: "personal" | "shared";
  /** Where the invitation is answered. Built by `invitationUrlFor`. */
  url: string;
  /** When the invitation stops being answerable, epoch ms. */
  expiresAt: number;
  /**
   * When this email is being sent, epoch ms. Passed in rather than read off the
   * clock, so the render stays pure and a test can pin the sentence instead of
   * racing it.
   */
  sentAt: number;
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
 * How long the reader has, in the units a reader actually thinks in.
 *
 * This was a plain UTC date, chosen because the recipient's locale is unknown
 * and an ISO date is unambiguous everywhere. It solved that ambiguity by making
 * somebody do arithmetic: nobody reads a date and immediately knows whether it
 * is soon.
 *
 * "in 7 days" answers the question actually being asked and still has no locale
 * to get wrong, so it keeps the original property rather than trading it away.
 * Two rendered bodies also still compare byte for byte, because this depends on
 * the invitation and the clock, never on the recipient.
 *
 * **Counted at send time, not assumed.** The obvious version hardcodes the
 * seven days of the invitation's TTL, and it would be wrong: an invitation
 * whose send was skipped -- a deployment with no usable `APP_ORIGIN`, say -- is
 * mailed later while still expiring on its original clock, so a constant would
 * promise a week that had already partly gone. Rounded up, so a last partial
 * day reads as a day rather than as "in 0 days".
 */
export function describeExpiry(sentAt: number, expiresAt: number): string {
  const days = Math.ceil((expiresAt - sentAt) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "in 1 day";
  return `in ${days} days`;
}

/**
 * When the emailed sign-in code should stop working, or `null` for "do not
 * mint one".
 *
 * Bounded twice, and the second bound is now the one that binds. The seven-day
 * rule above matches `INVITATION_TTL_MS`, so for an invitation issued now the
 * two are equal and the `- 1` is what keeps the code strictly inside the offer
 * it was mailed with. That strictness is not decoration: a code outliving its
 * invitation would be a bare credential with nothing left to accept, which is
 * exactly what this design refuses to turn the invitation token into.
 *
 * It still binds on a *superseded* invitation, whose expiry is inherited from
 * the row it replaced and can be much closer than a week away.
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
 * One line saying what the product is, identical for every recipient.
 *
 * The first version of this email had none, and it read as phishing: a bare
 * blue link, from a domain the reader has never heard of, asking to be clicked.
 * The fix is not more facts — the list above is closed and stays closed — it is
 * telling somebody what they are being invited *into*, which is the same
 * sentence for everybody and discloses nothing.
 *
 * It also has to dodge the vocabulary the disclosure test forbids anywhere in
 * the body ("note", "folder", "member" among them), which is why it says
 * markdown and storage rather than the obvious words.
 */
const WHAT_CONTEXT_IS =
  "Context gives your AI assistants one place to read from — plain markdown in storage you own.";

const FOOTER_LINE = "Context — free your context, share your context.";

/**
 * The headline, and the one place the two kinds of context read differently.
 *
 * **Personal:** "…invited you into part of their brain." A personal context's
 * display name *is* the owner's handle, so the obvious sentence says the same
 * word twice — "@ada invited you to ada" — which reads like a machine filled a
 * template. Naming what it actually is — their brain, in the product's own
 * vocabulary (CLAUDE.md, "Vocabulary") — says more in fewer words.
 *
 * **"part of" is accuracy before it is intrigue.** An invitee is granted the
 * `team` tier, never the owner's own view, so what they get really is a subset
 * and the email should not imply otherwise. That it also makes somebody curious
 * about what is in there is the point — but a promise of everything would be
 * the kind of overstatement that gets found out on the first click.
 *
 * **"their", never "his" or "hers".** The product stores a display name and a
 * handle; it stores nothing about anybody's gender, and a name is not evidence
 * of one. Guessing would misgender real people in mail sent to third parties,
 * which is a worse failure than sounding slightly formal.
 *
 * **The disclosure, stated plainly.** This is the one place the body varies
 * with a property of the workspace rather than of the invitation, so a
 * mistyped address learns that a given name is personal rather than shared —
 * the same bit the ingestion refusals are byte-identical in order not to
 * publish. It is judged acceptable here and it is a different question: those
 * refusals answer *unauthenticated probes at arbitrary names*, while this is
 * addressed mail about a context whose owner deliberately named this recipient
 * and which they are about to be able to read. If that trade is ever
 * reconsidered, the fix is one branch here, not a redesign.
 */
function headlineFor(
  kind: "personal" | "shared",
  inviter: string,
  context: string,
): string {
  return kind === "personal"
    ? `${inviter} invited you into part of their brain`
    : `${inviter} invited you to ${context}`;
}

/**
 * The palette, lifted from `apps/mobile/features/design/tokens.ts`.
 *
 * The product is a single dark world on purpose and has no light theme. An
 * inbox is not ours to theme, though, so this renders light by default and
 * swaps to the product's real dark values under `prefers-color-scheme: dark`.
 * The button inverts with it — near-black on light, near-white on dark — which
 * is the console's own white CTA, not a second design.
 */
const LIGHT = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  line: "#E4E4E7",
  text: "#18181B",
  text2: "#52525B",
  text3: "#71717A",
  btn: "#08080A",
  btnInk: "#FFFFFF",
  well: "#FAFAFA",
} as const;

/**
 * Render the email.
 *
 * Two alternatives, the same words. The HTML is a whole document rather than a
 * fragment because dark mode needs a `<head>`: `color-scheme` has to be
 * declared before a client decides whether to force-invert the thing, and the
 * `@media (prefers-color-scheme: dark)` block has nowhere else to live.
 *
 * Every colour is *also* inline, because plenty of clients drop `<style>`
 * entirely — the block only ever overrides, so a client that ignores it gets
 * the light design rather than an unstyled one. Layout is tables and the button
 * is a table cell with a padded anchor, for the same reason: it has to survive
 * Outlook, which does not do padding on an `<a>`.
 *
 * There is no unsubscribe footer because there is no list: this is a one-off
 * message somebody with a verified account addressed to this mailbox, and the
 * recipient ignoring it is the whole of the opt-out.
 */
export function renderInvitationEmail(facts: InvitationEmailFacts): RenderedEmail {
  const inviter = describeInviter(facts.inviterName, facts.inviterHandle);
  const context = sanitizeHeaderText(facts.workspaceName);
  const expiry = describeExpiry(facts.sentAt, facts.expiresAt);
  const headline = headlineFor(facts.workspaceKind, inviter, context);
  const subject = sanitizeHeaderText(`${headline} on Context`);

  const text = [
    `${headline}.`,
    "",
    WHAT_CONTEXT_IS,
    "",
    "Open the invitation:",
    facts.url,
    "",
    `This invitation expires ${expiry}. If you were not expecting it, you can ignore this email.`,
    "",
    FOOTER_LINE,
  ].join("\n");

  const safeInviter = escapeHtml(inviter);
  const safeContext = escapeHtml(context);
  const safeUrl = escapeHtml(facts.url);
  const font =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const mono = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

  const html = [
    "<!DOCTYPE html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    "<style>",
    ":root{color-scheme:light dark;supported-color-schemes:light dark}",
    // Overrides only. A client that drops this block still gets the light
    // design from the inline styles below, never an unstyled one.
    "@media (prefers-color-scheme:dark){",
    ".bg{background:#050506!important}",
    ".card{background:#0B0B0D!important;border-color:rgba(255,255,255,0.09)!important}",
    ".t1{color:#F2F2F4!important}",
    ".t2{color:#A8A8B2!important}",
    ".t3{color:#75757F!important}",
    ".rule{background:rgba(255,255,255,0.09)!important}",
    ".btn{background:#F2F2F4!important}",
    ".btn a{color:#08080A!important}",
    ".well{background:#030304!important;border-color:rgba(255,255,255,0.07)!important}",
    "}",
    "@media (max-width:620px){.card{padding:26px 20px!important}.h1{font-size:22px!important}}",
    "</style>",
    "</head>",
    `<body class="bg" style="margin:0;padding:0;background:${LIGHT.bg};">`,
    // Preheader: what the inbox list shows instead of the first markup it finds.
    `<div style="display:none;font-size:1px;color:${LIGHT.bg};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">`,
    `${safeInviter} — this invitation expires ${expiry}.`,
    "</div>",
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:${LIGHT.bg};">`,
    '<tr><td align="center" style="padding:32px 16px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">',

    // Wordmark
    `<tr><td class="t3" style="font-family:${font};font-size:13px;letter-spacing:0.08em;text-transform:uppercase;color:${LIGHT.text3};padding:0 4px 12px;">Context</td></tr>`,

    // Card
    '<tr><td>',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" style="background:${LIGHT.card};border:1px solid ${LIGHT.line};border-radius:14px;">`,
    '<tr><td class="card" style="padding:34px 32px;">',

    `<div class="t1 h1" style="font-family:${font};font-size:24px;line-height:1.3;font-weight:600;color:${LIGHT.text};margin:0 0 10px;">`,
    escapeHtml(headline),
    "</div>",

    `<div class="t2" style="font-family:${font};font-size:15px;line-height:1.55;color:${LIGHT.text2};margin:0 0 26px;">`,
    escapeHtml(WHAT_CONTEXT_IS),
    "</div>",

    // Bulletproof button: padding on the cell, not on the anchor.
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>',
    `<td class="btn" align="center" style="background:${LIGHT.btn};border-radius:10px;">`,
    `<a href="${safeUrl}" style="display:inline-block;padding:13px 26px;font-family:${font};font-size:15px;font-weight:600;color:${LIGHT.btnInk};text-decoration:none;">Open the invitation</a>`,
    "</td></tr></table>",

    // The link in the clear. A reader who will not click an anchor from an
    // unfamiliar domain can read where it goes, and paste it if they prefer.
    `<div class="t3" style="font-family:${font};font-size:13px;color:${LIGHT.text3};margin:24px 0 8px;">Or paste this into your browser:</div>`,
    `<div class="well t3" style="font-family:${mono};font-size:12px;line-height:1.5;color:${LIGHT.text3};background:${LIGHT.well};border:1px solid ${LIGHT.line};border-radius:8px;padding:10px 12px;word-break:break-all;">${safeUrl}</div>`,

    `<div class="rule" style="height:1px;background:${LIGHT.line};margin:26px 0 18px;line-height:1px;font-size:0;">&nbsp;</div>`,

    `<div class="t3" style="font-family:${font};font-size:13px;line-height:1.6;color:${LIGHT.text3};">`,
    `This invitation expires ${expiry}. If you were not expecting it, you can ignore this email.`,
    "</div>",

    "</td></tr></table>",
    "</td></tr>",

    `<tr><td class="t3" style="font-family:${font};font-size:12px;line-height:1.6;color:${LIGHT.text3};padding:16px 4px 0;">${escapeHtml(FOOTER_LINE)}</td></tr>`,

    "</table>",
    "</td></tr></table>",
    "</body></html>",
  ].join("");

  return { subject, html, text };
}
