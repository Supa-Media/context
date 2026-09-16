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

import { VENDORED_BLOCKLIST } from "./reservedNames.generated";

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

/**
 * Reserved as a *handle*, and deliberately fine as a group label.
 *
 * These read as us — or as a role, or as a promise this product makes — only
 * when they stand alone at the top of the namespace. A group name is always
 * stored as `<workspace-slug>-<label>`, so `@supa-owners` is a group inside a
 * context somebody already has to be a member of, and refusing it would cost
 * the natural name for the most obvious group there is. See
 * `RESERVED_GROUP_LABELS` below for which half of the list a label is held to.
 */
const TOP_LEVEL_ONLY_NAMES: readonly string[] = [
  /* ---------------------------------------------------------------------- *
   *            names this product in particular must not hand out            *
   * ---------------------------------------------------------------------- */

  // The plural of a reserved word. `brain`/`brains` and `workspace`/
  // `workspaces` are reserved as pairs above; `context` was not, and
  // `@contexts` reads as the product's own index of them.
  "contexts",

  // The three roles `workspaceMembers.role` is written in. `@owner` in a
  // context list — or in a form's `by` column beside a real person — is the
  // cheapest impersonation this namespace offers, and none of the three was
  // covered by the vendored lists.
  "owner",
  "owners",
  "editor",
  "editors",
  "member",
  "members",

  /*
    NEVER RESERVE A NAME YOU INTEND TO HOLD.

    `supa`, `supa-media` and `context-lc` are deliberately **absent** from this
    list, and the reason is worth stating because each looks like it belongs
    here. `checkAvailability` runs `validateName` and there is no bypass — not
    for an admin, not for a seeding script, not for us. A reserved name is
    refused for everyone, so reserving the handle of a context we actually run
    means we could never recreate it after a delete or a migration.

    What protects a name we hold is holding it: the row in `names` is what makes
    it unavailable. The lookalikes and compounds below are the ones worth
    reserving, because nobody legitimate is ever going to want them.
  */

  // Spellings of `@context-lc`, the context pinned into every account's list.
  // A handle that reads as it is a handle that reads as us.
  "contextlc",
  "context-app",
  "contextapp",
  "getcontext",
  "get-context",
  "the-context",
  "thecontext",
  "mycontext",
  "my-context",
  "context-hq",
  "contexthq",

  /*
    LOOKALIKES OF THAT CONTEXT, WHICH `RESERVED_LABEL_FORM` CANNOT SEE.

    That check catches a homograph smuggled in from outside the charset. These
    are inside it: in the system UI face, digit `1` and letter `l` are one
    glyph, so `@context-1c` beside `@context-lc` is indistinguishable.

    Named entries rather than a rule, deliberately. The general fix is skeleton
    matching — fold `1`→`l`, `0`→`o`, drop hyphens, compare — and it changes
    what `validateName` *means* rather than what it knows, so it can refuse a
    name somebody already holds. It is its own change, and `docs/decisions/`
    records it as owed.
  */
  "context-1c",
  "context1c",
  "context-ic",
  "contextic",

  // Compounds that read as a staffed channel. The bare words (`support`,
  // `help`, `team`, `admin`, `security`, `billing`) are reserved above; the
  // compound with the product name is the form a phishing handle takes.
  "context-team",
  "context-support",
  "context-help",
  "context-admin",
  "context-security",
  "context-billing",
  "context-staff",
  "context-official",
  "official-context",

  // Promises of this product specifically. `export` most of all: the export
  // path is what non-negotiable #1 rests on, and `@export` reads as ours.
  "export",
  "exports",
  "import",
  "imports",
  "credential",
  "credentials",
  "secret",
  "secrets",
  "keys",
  // `share` is vendored; its plural is not, and a share link is a capability
  // this product mints.
  "shares",
];

/**
 * The names this product decided on, one at a time, each with its reason.
 *
 * Separate from the vendored blocklist because the two answer different
 * questions and one caller needs only this half: a **group label** is held to
 * these and not to the bulk — see `RESERVED_GROUP_LABELS`.
 */
const PRODUCT_RESERVED_NAMES: readonly string[] = [


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
  // Meeting ingestion runs at `/meetings/sessions` on the gateway. Claimed as a
  // handle, `@meetings` would be a context nobody can address by name — and,
  // because ingestion is on the apex, `meetings@` the company's own domain: the
  // mailbox every device that records a meeting looks like it is talking to.
  "meetings",
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
  // **Retired product vocabulary, permanently reserved.** "Brain" was the
  // user-facing word for a personal context until the owner retired it
  // (2026-09-13, docs/decisions/vocabulary-and-workspaces.md); every context
  // is a workspace now, and "workspace" is reserved above.
  //
  // Retiring the word makes these *more* important to hold, not less. The
  // reservation was never about vocabulary: ingestion is on the apex, so a
  // claimable `brain@context.lc` would receive mail people believed was going
  // to the product, and `@brain/...` would read as a product path rather than
  // a person's. People go on saying a retired word for years after the copy
  // stops — an address does not stop being believable because a heading
  // changed. Freeing these would hand an impersonation handle to whoever
  // claimed it first. They stay, and `names.test.ts` holds them.
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
];

/**
 * Every name that cannot be claimed at the top of the namespace.
 *
 * Three sources, in the order they are argued below: the vendored public
 * blocklists, the names decided here, and the ones that are only a hazard as a
 * handle rather than as a group label.
 *
 * ## The blocklists are taken whole
 *
 * `PRODUCT_RESERVED_NAMES` above was decided here, one name at a time, each
 * with the reason it is there. That is the right way to decide and a bad way to
 * cover: measured against the two lists most services vendor, it held 66 of 834
 * applicable entries. The rest are names somebody else already got wrong first
 * — `wpad`, `null`, `sudo`, `paypal`, `autodiscover` — and rediscovering them
 * one incident at a time is the thing a blocklist exists to prevent.
 *
 * Taken as a whole rather than pruned. Pruning is re-deciding 834 times on a
 * judgement already made, and the names it buys back are ones nobody is owed.
 * The cost is real and small: `@test`, `@demo`, `@beta`, every HTTP status code
 * and a pile of SSH cipher names stop being claimable.
 *
 * Regenerate with `node scripts/build-reserved-names.mjs`, which records each
 * source's version and digest in the generated file.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...VENDORED_BLOCKLIST,
  ...PRODUCT_RESERVED_NAMES,
  ...TOP_LEVEL_ONLY_NAMES,
]);

/**
 * The half of the reserved list a **group label** is held to.
 *
 * `buildGroupName` checks the label a person types, and has since the group
 * namespace existed: the comment on its own test says why — "`workspace`,
 * `brain` and friends are a mail-interception control, and the label is the
 * half a person types". That reasoning is intact and this keeps it.
 *
 * What it excludes is everything that is only a hazard *at the top of the
 * namespace*:
 *
 *  - the **vendored blocklist**, which is a list of things that collide with
 *    routes, hostnames and error pages — `wpad`, `404`, `staff`, `beta`. A
 *    group is stored as `<slug>-<label>` and is never any of those.
 *  - **`TOP_LEVEL_ONLY_NAMES`**, for the reason stated there.
 *
 * Without the split, adding the blocklist silently took `@supa-owners` and
 * `@publicworship-staff` away — real group names, refused because a word inside
 * them is a bad *handle*. The assembled name is still checked against the whole
 * of `RESERVED_NAMES` in `buildGroupName`, which is the check that matches what
 * actually gets stored and addressed.
 */
export const RESERVED_GROUP_LABELS: ReadonlySet<string> = new Set(PRODUCT_RESERVED_NAMES);

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
export function validateName(
  raw: string,
  /**
   * Which reserved set to hold the candidate to. Defaults to all of them; the
   * only caller that narrows it is `buildGroupName`, and `RESERVED_GROUP_LABELS`
   * states why a label is a different question from a handle.
   */
  options: { reserved?: ReadonlySet<string> } = {},
): NameValidation {
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
  if ((options.reserved ?? RESERVED_NAMES).has(normalized)) {
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

/* -------------------------------------------------------------------------- */
/*                              group names                                   */
/* -------------------------------------------------------------------------- */

/**
 * The longest a group's full name may be.
 *
 * A group is `<workspace slug>-<label>`, so it can be two 32-character halves
 * and the joining hyphen. It is capped separately from `NAME_MAX_LENGTH`
 * because the 32 there exists for things that must survive a DNS label and a
 * mail local-part, and a group is neither: it is never a capture address (only
 * a *personal* context has one) and never a subdomain. It shares the namespace
 * because it shares the `@name` syntax, which is a collision concern, not a
 * length one.
 *
 * It matches `GROUP_SCOPE_PATTERN` in the privacy engines, which accept
 * `@` plus 2-65 characters. The two are the same rule stated in two places
 * that cannot import each other, and `__tests__/groupNames.test.ts` pins them
 * together.
 */
export const GROUP_NAME_MAX_LENGTH = NAME_MAX_LENGTH * 2 + 1;

/**
 * Build and validate a group's full name from its workspace and a label.
 *
 * **The prefix is structural, not a convention.** Group names live in the one
 * global namespace usernames and workspace slugs share — `@kola` is a person
 * and `@supa-leads` is a group, and a privacy rule names either with the same
 * token — so an unprefixed group name would let one workspace claim `@leads`
 * out from under everybody, and a workspace could mint a name inside another's
 * space. Deriving it here, from the workspace's own slug, is what makes
 * "@supa-* belongs to supa" true rather than hoped for; no caller passes the
 * prefix in.
 *
 * The LABEL is validated as a name in its own right — charset, reserved words,
 * the IDNA label form — because everything those rules protect against is
 * still reachable through the half a person types. The assembled name is then
 * length-checked as a whole.
 */
export function buildGroupName(
  workspaceSlug: string,
  rawLabel: string,
): NameValidation {
  /*
    The label is held to `RESERVED_GROUP_LABELS` rather than to the whole list —
    see that export. `validateName` would apply all of it, including the
    vendored blocklist, which is about names at the top of the namespace and
    takes `owners` and `staff` with it.

    Shape first, from the same function, so charset, length and the IDNA form
    are answered in exactly one place.
  */
  const label = validateName(rawLabel, { reserved: RESERVED_GROUP_LABELS });
  if (!label.ok) return label;

  const slug = normalizeName(workspaceSlug);
  // A workspace whose own slug is malformed cannot mint anything. Reachable
  // only from damaged data, and refusing is the direction that cannot produce
  // a name nobody can account for.
  if (!ALLOWED_CHARS.test(slug) || slug.length === 0) {
    return { ok: false, reason: "invalid_characters", normalized: slug };
  }

  const normalized = `${slug}-${label.normalized}`;
  if (normalized.length > GROUP_NAME_MAX_LENGTH) {
    return { ok: false, reason: "too_long", normalized };
  }
  // Re-checked on the assembled name rather than trusted from the halves: the
  // join introduces a `--` that neither half had, which is the IDNA reserved
  // form and therefore a homograph vector. A one-character slug and a label
  // opening with a hyphen cannot both pass on their own, but the rule is
  // asserted on what actually gets stored.
  if (RESERVED_LABEL_FORM.test(normalized)) {
    return { ok: false, reason: "reserved_label_form", normalized };
  }
  if (RESERVED_NAMES.has(normalized)) {
    return { ok: false, reason: "reserved", normalized };
  }
  return { ok: true, normalized };
}

/**
 * The label half of a stored group name, for display beside its workspace.
 *
 * Returns the whole name when it does not carry the expected prefix, which is
 * the honest answer for a row from another workspace or from before a rename:
 * showing a truncated name would be worse than showing the full one.
 */
export function groupLabelOf(workspaceSlug: string, groupName: string): string {
  const prefix = `${normalizeName(workspaceSlug)}-`;
  return groupName.startsWith(prefix) ? groupName.slice(prefix.length) : groupName;
}
