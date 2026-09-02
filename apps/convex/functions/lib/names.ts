/**
 * The global name namespace.
 *
 * Usernames and workspace slugs share one namespace, because both are the
 * `name` in `@name/1-projects/foo.md`. A username that could collide with a
 * workspace slug would make cross-context addressing ambiguous, and ambiguity
 * in an addressing scheme that gates access is a security bug, not a UX one.
 *
 * This module is deliberately pure — no Convex imports — so the rules can be
 * unit-tested directly and reused by the gateway if it ever needs to parse a
 * `@name` prefix.
 */

/** Shortest allowed name. Two characters, so `@lk` and `@ab` are claimable. */
export const NAME_MIN_LENGTH = 2;

/** Long enough for a descriptive shared-context slug, short enough to type. */
export const NAME_MAX_LENGTH = 32;

/**
 * Names we never hand out.
 *
 * **This list is a security control, not a style guide.** A name is a
 * username, a workspace slug, a future subdomain, AND — since email ingestion
 * runs on the apex domain — the local part of a real mailbox: claiming
 * `@support` means receiving everything sent to `support@` the company's own
 * domain. Trimming an entry does not tidy the list, it opens a mailbox.
 *
 * Four overlapping reasons, all of which matter:
 *  - **Mail interception** — see `MAIL_ROLE_NAMES` below. This is the newest
 *    and sharpest of the four, because it turns a claimed name into a live
 *    interception of somebody else's mail rather than a merely confusing URL.
 *  - **Routing** — these are (or will be) path segments and subdomains on our
 *    own surfaces, so `@api/...` must never resolve to a person's context.
 *  - **Impersonation** — `@support` and `@security` are the names an attacker
 *    would want in order to be believed.
 *  - **Room to grow** — `@settings`, `@new`, `@me` are the URLs a product
 *    eventually wants, and reclaiming a name someone is already using is not
 *    an option once it is baked into their notes.
 *
 * Adding to this list is cheap. Removing from it is a breaking change for
 * nobody, so err toward reserving.
 */

/**
 * Mailbox names that must never belong to a user.
 *
 * A person's capture address is `<name>@<apex>` — the apex domain, not a
 * subdomain. That is a deliberate product decision, and its direct consequence
 * is that **this list is the only thing standing between a signup and mail
 * interception**: whoever holds the name receives the mail. Four clusters,
 * each for a different concrete attack:
 *
 *  - **RFC 2142 mandatory** (`postmaster`, `abuse`) — required by the standard
 *    to reach the domain's operators. These are where a mail provider, a
 *    blocklist operator, or a victim of abuse *from* our domain writes. Losing
 *    them to a user means abuse reports go to the abuser and deliverability
 *    problems arrive at a stranger's inbox. Non-negotiable, in every sense.
 *  - **Other RFC 2142 roles** — the addresses correspondents are entitled to
 *    assume are operational (`hostmaster`, `webmaster`, `security`, `info`,
 *    `sales`, …). Same failure mode, less catastrophic.
 *  - **Automated senders** — `noreply` and its spellings, `mailer-daemon`,
 *    `bounce(s)`, `notifications`, `alerts`. These are the From: addresses our
 *    own system uses. A user holding one receives the bounce stream — which is
 *    a live feed of who else is on the platform — and can send *as* a name
 *    recipients have been trained to treat as the system talking.
 *  - **Auth, identity, and company surfaces** — `verify`, `password`,
 *    `reset`, `billing`, `legal`, `support`, … The phishing case: mail from
 *    `verify@` or `password-reset@` the real domain, with real SPF/DKIM
 *    alignment, is indistinguishable from ours to a recipient and to a spam
 *    filter, because it *is* from our domain.
 *
 * A future contributor pruning "unused" entries here is removing an
 * anti-phishing control. Do not.
 */
const MAIL_ROLE_NAMES = [
  // RFC 2142 §4 — required. Never claimable, always deliverable to us.
  "postmaster",
  "abuse",
  // RFC 2142 — other defined roles.
  "hostmaster",
  "webmaster",
  "usenet",
  "news",
  "uucp",
  "ftp",
  "info",
  "marketing",
  "sales",
  "security",
  // Automated senders, bounce handling, and anti-phishing.
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "mailer-daemon",
  "bounce",
  "bounces",
  "notifications",
  "alerts",
  // Company and support surfaces.
  "hello",
  "support",
  "help",
  "contact",
  "team",
  "billing",
  "legal",
  "privacy",
  "press",
  "careers",
  "jobs",
  // Auth and identity — the names that read as trustworthy in a From: line.
  "admin",
  "administrator",
  "root",
  "system",
  "account",
  "accounts",
  "auth",
  "login",
  "verify",
  "verification",
  "password",
  "reset",
];

/**
 * The two RFC 2142 addresses a domain is *required* to keep reachable.
 *
 * Exported so a test can assert them independently of the list they live in:
 * if someone prunes `RESERVED_NAMES`, dropping these two must be a distinct,
 * loud failure rather than one line lost in a diff.
 */
export const RFC2142_MANDATORY_NAMES: readonly string[] = ["postmaster", "abuse"];

export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...MAIL_ROLE_NAMES,
  // Routing / infrastructure
  "api",
  "app",
  "assets",
  "auth",
  "cdn",
  "dev",
  // Every first path segment `apps/mcp/src/session.js` reads as a route rather
  // than as a context. `granola-webhook` was claimable until a test derived
  // this set from the gateway's own list instead of restating five of them by
  // hand: the gateway reads `/@granola-webhook/mcp` as a route, so the context
  // was unaddressable by name, and — because ingestion is on the apex — the
  // handle was also a mailbox sharing a name with one of our own endpoints.
  // `t` and `.well-known` need no entry: the first is too short for a name and
  // the second has a character this namespace does not allow.
  "granola-webhook",
  "mcp",
  "oauth",
  "static",
  "status",
  "staging",
  "www",
  // Product surfaces we will want
  "about",
  "account",
  "admin",
  "billing",
  "blog",
  "contact",
  "dashboard",
  "docs",
  "download",
  "help",
  "home",
  "login",
  "logout",
  "me",
  "new",
  "pricing",
  "privacy",
  "register",
  "settings",
  "signin",
  "signup",
  "support",
  "team",
  "terms",
  "workspace",
  "workspaces",
  // Impersonation risks
  "context",
  "official",
  "root",
  "security",
  "system",
  // Product vocabulary (see CLAUDE.md, "Vocabulary"): a person's personal
  // context is a "brain", a shared one is a "workspace" (already reserved
  // above). Claimable, `brain@context.lc` would receive mail people believed
  // was going to the product, and `@brain/...` would read as a product path.
  "brain",
  "brains",
  // On-bucket layout words, so a name can never be confused for a folder.
  //
  // The numbered forms are the ones that actually exist on a bucket
  // (`0-inbox/`, `1-projects/`, …); the bare words are reserved too because
  // they are how people say them out loud and how a future UI would label
  // them. `.history/` and `.audit/` cannot be claimed as written — a name may
  // not contain a dot — but their undotted forms are reserved so that
  // `@history` can never be mistaken for the history folder in a path.
  "0-inbox",
  "1-projects",
  "2-areas",
  "3-resources",
  "4-archive",
  "inbox",
  "projects",
  "areas",
  "resources",
  "archive",
  "history",
  "audit",
]);

/** Why a candidate name was rejected. Stable codes — clients map these to copy. */
export type NameRejection =
  | "too_short"
  | "too_long"
  | "invalid_characters"
  | "invalid_start_or_end"
  | "reserved_label_form"
  | "reserved"
  | "taken";

export type NameValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: NameRejection; normalized: string };

/**
 * Normalize a candidate name to its canonical form.
 *
 * Lowercase and trimmed only — we do NOT strip or substitute characters.
 * Silently rewriting `My Notes` into `my-notes` would mean the name a person
 * typed is not the name they got, and in a namespace where the name is an
 * access path that is a footgun. Invalid input is rejected loudly instead.
 */
export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase();
}

const ALLOWED_CHARS = /^[a-z0-9-]+$/;

/**
 * Hyphens in the third and fourth positions — the reserved LDH label form.
 *
 * `xn--` is the one everybody knows: it is the ACE prefix, so `xn--80ak6aa92e`
 * is a valid `[a-z0-9-]` string that a browser address bar, a mail client, and
 * a certificate viewer all render as Unicode. Since a name is described as a
 * future subdomain, handing one out is handing out a homograph — `@apple`
 * spelled in Cyrillic, addressed as `@xn--80ak6aa92e`, and displayed to a
 * victim as the real thing.
 *
 * The check is the general rule from RFC 5891 §4.2.3.1 rather than a literal
 * `xn--` match: *every* label with `--` in positions 3 and 4 is reserved by
 * IDNA, and reserving only the prefix in use today leaves the next one
 * (`aa--`, `yz--`, whatever IDNA allocates) claimable. It costs us nothing —
 * no legitimate two-letter-then-double-hyphen name exists.
 */
const RESERVED_LABEL_FORM = /^..--/;

/**
 * Validate a candidate name against the shared-namespace rules.
 *
 * Charset is `[a-z0-9-]`, which is exactly what survives a URL path segment, a
 * DNS label, and an S3 key without escaping. No underscores (invalid in a DNS
 * label), no dots (would break `@name/path` parsing against file extensions),
 * no leading/trailing hyphen.
 *
 * Availability is NOT checked here — that needs the database. A `true` result
 * means "well-formed and not reserved", nothing more.
 */
export function validateName(raw: string): NameValidation {
  const normalized = normalizeName(raw);

  if (normalized.length < NAME_MIN_LENGTH) {
    return { ok: false, reason: "too_short", normalized };
  }
  if (normalized.length > NAME_MAX_LENGTH) {
    return { ok: false, reason: "too_long", normalized };
  }
  if (!ALLOWED_CHARS.test(normalized)) {
    return { ok: false, reason: "invalid_characters", normalized };
  }
  if (normalized.startsWith("-") || normalized.endsWith("-")) {
    return { ok: false, reason: "invalid_start_or_end", normalized };
  }
  if (RESERVED_LABEL_FORM.test(normalized)) {
    return { ok: false, reason: "reserved_label_form", normalized };
  }
  if (RESERVED_NAMES.has(normalized)) {
    return { ok: false, reason: "reserved", normalized };
  }
  return { ok: true, normalized };
}

/** Human-readable text for a rejection. Safe to show a client verbatim. */
export function describeRejection(reason: NameRejection): string {
  switch (reason) {
    case "too_short":
      return `Names must be at least ${NAME_MIN_LENGTH} characters.`;
    case "too_long":
      return `Names must be at most ${NAME_MAX_LENGTH} characters.`;
    case "invalid_characters":
      return "Names may only contain lowercase letters, numbers, and hyphens.";
    case "invalid_start_or_end":
      return "Names cannot start or end with a hyphen.";
    case "reserved_label_form":
      return "Names cannot have two hyphens in the third and fourth positions.";
    case "reserved":
      return "That name is reserved.";
    case "taken":
      return "That name is already taken.";
  }
}
