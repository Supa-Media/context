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
 * Three overlapping reasons, all of which matter:
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
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  // Routing / infrastructure
  "api",
  "app",
  "assets",
  "auth",
  "cdn",
  "dev",
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
  // On-bucket layout words, so a name can never be confused for a folder
  "inbox",
  "projects",
  "areas",
  "resources",
  "archive",
]);

/** Why a candidate name was rejected. Stable codes — clients map these to copy. */
export type NameRejection =
  | "too_short"
  | "too_long"
  | "invalid_characters"
  | "invalid_start_or_end"
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
    case "reserved":
      return "That name is reserved.";
    case "taken":
      return "That name is already taken.";
  }
}
