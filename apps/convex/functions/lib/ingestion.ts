/**
 * Email ingestion policy — who may post into a **personal** context, and where
 * it lands.
 *
 * ## What this module is, and why it is shaped like this
 *
 * Cloudflare Email Routing → Email Worker → `0-inbox/` (CLAUDE.md, "Stack").
 * The receiver is `infra/email-worker/`; the settings an owner configures are
 * in `functions/ingestion.ts`; and the function that turns an inbound sender
 * into an accept/reject is here.
 *
 * A capture address belongs to a personal context and to nothing else. A shared
 * context has no address, so no policy governs one — see the header of
 * `lib/ingestionStore.ts` for the reasoning and
 * `resolvePersonalContextForIngestion` for the single place that decides it.
 *
 * This function is here, pure, with no Convex import — exactly like
 * `lib/names.ts` — for three reasons:
 *
 *  1. **The Worker calls it directly.** The receiver runs on the Workers
 *     runtime with no database of its own, and if these rules lived inside a
 *     Convex mutation it would have to reimplement them — two implementations
 *     of an allowlist drift into a bypass.
 *     `infra/email-worker/src/policy.ts` is a bare re-export of this module,
 *     and `policy.test.ts` there asserts the seam by *function identity* plus
 *     the attack strings a hand-rolled matcher gets wrong. So there is one
 *     matcher, and "replace the re-export with a small local helper, just for
 *     the Worker" fails a test rather than production.
 *  2. **It is handed attacker-controlled input.** Anybody who learns a capture
 *     address can put arbitrary bytes in a `From:` header. A pure function
 *     over a string is the only shape that can be exhaustively tested against
 *     the header forms a real attacker sends.
 *  3. **The failure mode is not "spam".** Ingested notes are read back by the
 *     owner's AI clients *as their own trusted context*. A forged capture is a
 *     prompt-injection primitive with a persistence guarantee. This allowlist
 *     is the only thing between a semi-public address and that.
 *
 * ## The rule that is easiest to get backwards
 *
 * **Domain matching is exact equality. It is never a suffix test.** An
 * allowlist of `publicworship.life` admits `publicworship.life` and nothing
 * else — not `evil.publicworship.life`, not `notpublicworship.life`. Both of
 * those are trivially registrable/creatable by an attacker, and both are what
 * `domain.endsWith(allowed)` would let through. Subdomains are admitted by
 * listing them, one line each. `__tests__/ingestionPolicy.test.ts` asserts the
 * attack strings directly; if you "simplify" this to a suffix check, several
 * tests named after the attack will fail. That is the point.
 *
 * ## What this does NOT do
 *
 * It does not authenticate the sender. A `From:` header is asserted, not
 * proven; SPF/DKIM/DMARC is what makes it worth anything, and that check lives
 * in the receiver. **An allowlist over an unauthenticated header stops casual
 * and accidental posting, not a determined forger** — and on the deployed
 * receiver, that is exactly what it is: an allowlist over an unauthenticated
 * header.
 *
 * This block used to go on to say the receiver rejects on a failed verdict
 * first and consults this second, so the address reaching here was always one
 * the sender had proved. That is no longer true. `decideCapture` in
 * `infra/email-worker/src/ingest.ts` still evaluates the verdict first, but it
 * now writes the result into the capture note as a label — `verified`,
 * `sender-authenticated-by`, `authentication-result` — rather than refusing the
 * message, and hands this matcher the claimed `From:` addr-spec when nothing
 * authenticated. See the "authentication is a label, not a gate" block at the
 * top of `infra/email-worker/src/auth.ts` for the two real deliveries that
 * settled it: ordinary forwarded mail cannot align, and Cloudflare folds its
 * own `Authentication-Results`, so the gate refused essentially everything.
 *
 * So for `allowAnySender`: it now means literally any sender, and a message
 * that failed alignment reaches this function exactly as one that passed does.
 * The one thing that has not changed is that `senderIsAllowed` returns false
 * for an address it cannot parse *before* it consults that flag.
 *
 * If you are here because you want the guarantee back, the guarantee has moved
 * rather than gone: it is the note, which says per message what was and was not
 * established. Do not restore the refusal without reading why it went.
 */

/**
 * The apex the capture addresses live on.
 *
 * Deliberately the apex, not a subdomain — which is precisely why the reserved
 * list in `lib/names.ts` is a mail-interception control. See CLAUDE.md,
 * "Ingestion is on the apex".
 */
export const INGESTION_DOMAIN = "context.lc";

/** Where captures land unless the owner says otherwise. */
export const DEFAULT_TARGET_FOLDER = "0-inbox/";

/**
 * How many entries a policy may hold.
 *
 * Not a storage concern — the evaluator walks these lists for every inbound
 * message, and an unbounded list is an unbounded per-message cost payable by
 * anyone who can send mail. Both caps are enforced on write *and* honoured on
 * read: a row that somehow exceeds one is truncated rather than trusted, which
 * fails closed (extra entries stop matching) rather than open.
 */
export const MAX_ALLOWED_SENDERS = 50;
export const MAX_ALLOWED_DOMAINS = 20;

/** RFC 5321 §4.5.3.1 — the largest addr-spec that can legally reach us. */
const MAX_ADDRESS_LENGTH = 320;
const MAX_LOCAL_PART_LENGTH = 64;
const MAX_DOMAIN_LENGTH = 255;
const MAX_LABEL_LENGTH = 63;

/**
 * The longest header value we will even look at.
 *
 * An absurdly long input must fail closed *cheaply*. Length is checked before
 * any regular expression touches the string, so a megabyte of `a` costs one
 * comparison rather than a pathological match.
 */
const MAX_INPUT_LENGTH = 1_000;

/** S3 caps keys at 1024; `lib/fileOps.ts` caps paths at 512. Match it. */
const MAX_FOLDER_LENGTH = 512;

/* -------------------------------------------------------------------------- */
/*                                  addresses                                 */
/* -------------------------------------------------------------------------- */

export interface ParsedAddress {
  /** `local@domain`, lowercased, trailing dot stripped. The canonical form. */
  address: string;
  /** The local part, lowercased, sub-address tag intact. */
  localPart: string;
  /** The local part with a `+tag` suffix removed. See `senderIsAllowed`. */
  baseLocalPart: string;
  /** The domain, lowercased, trailing dot stripped, ASCII only. */
  domain: string;
}

/** RFC 5322 `atext`, plus `.`. Quoted local parts are deliberately refused. */
const LOCAL_PART_CHARS = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;

/**
 * One DNS label. No leading or trailing hyphen, no empty label.
 *
 * Applied per label after splitting on `.` rather than as one big domain
 * regex. A single anchored pattern with nested quantifiers
 * (`^(label(\.label)*)$`) is how a validator becomes a denial-of-service on an
 * input the attacker chooses; splitting first keeps every match linear.
 */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Anything a header value must not contain: C0 controls other than tab, DEL,
 * and every non-ASCII code unit.
 *
 * Tab survives because it is legal folding whitespace between a display name
 * and an angle-addr; it cannot reach the addr-spec, which refuses all
 * whitespace separately. A newline is forbidden outright — a `From:` carrying
 * one is header injection, not a sender.
 */
const FORBIDDEN_CHARS = /[\x00-\x08\x0a-\x1f\x7f-\uffff]/;

/**
 * Parse a `From:`-style value down to its addr-spec, or `null`.
 *
 * Everything about this function is "fail closed": every branch that is not
 * obviously safe returns `null`, and `null` means the message is not accepted.
 * Refusing a legitimate but exotic address costs one support ticket; admitting
 * a forged one costs a poisoned context.
 *
 * Accepted:
 *  - `seyi@example.test`
 *  - `Seyi <seyi@example.test>`
 *  - `"Seyi, O." <seyi@example.test>`
 *
 * Refused (all `null`, none throw):
 *  - anything with more than one `<` or `>`, or text after the `>` — an
 *    ambiguous header is not worth guessing at;
 *  - a group list or several addresses (`a@x.test, b@y.test`);
 *  - more than one `@`, an empty local part, an empty domain, a single-label
 *    domain (`root@localhost`);
 *  - control characters, and **any non-ASCII byte**. A Unicode domain must
 *    arrive as punycode (`xn--…`, which is plain ASCII and compares exactly)
 *    or not at all: normalizing Unicode here would mean two spellings of one
 *    allowlist entry, and homograph confusion is the entire attack.
 *
 * ### Why the display name is discarded rather than searched
 *
 * `From: "seyi@example.test" <attacker@evil.test>` is the classic bypass: the
 * allowed address appears in the header, in a part that means nothing. Any
 * implementation that regex-searches the raw header for an allowed address
 * admits it. This one extracts the angle-addr and throws the rest away, so the
 * display name cannot influence the decision at all.
 */
export function parseEmailAddress(input: unknown): ParsedAddress | null {
  if (typeof input !== "string") return null;
  if (input.length === 0 || input.length > MAX_INPUT_LENGTH) return null;
  if (FORBIDDEN_CHARS.test(input)) return null;

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const addrSpec = extractAddrSpec(trimmed);
  if (addrSpec === null) return null;
  if (addrSpec.length === 0 || addrSpec.length > MAX_ADDRESS_LENGTH) return null;

  // A comma or semicolon means the header carried more than one address (or a
  // group). Which one is "the sender" is a guess, so refuse instead.
  if (/[,;\s"<>()[\]\\]/.test(addrSpec)) return null;

  // Exactly one `@`. `a@b@evil.test` is not "the last one wins" — it is
  // malformed, and every parser in the chain disagrees about it differently.
  let atCount = 0;
  for (const character of addrSpec) if (character === "@") atCount += 1;
  if (atCount !== 1) return null;

  const at = addrSpec.indexOf("@");
  const localPart = addrSpec.slice(0, at).toLowerCase();
  const domain = normalizeDomain(addrSpec.slice(at + 1));
  if (domain === null) return null;

  if (localPart.length === 0 || localPart.length > MAX_LOCAL_PART_LENGTH) return null;
  if (!LOCAL_PART_CHARS.test(localPart)) return null;
  if (localPart.startsWith(".") || localPart.endsWith(".")) return null;
  if (localPart.includes("..")) return null;

  return {
    address: `${localPart}@${domain}`,
    localPart,
    baseLocalPart: stripSubAddress(localPart),
    domain,
  };
}

/**
 * Pull the addr-spec out of a possibly display-name-decorated value.
 *
 * Returns `null` for anything ambiguous rather than picking a winner.
 */
function extractAddrSpec(value: string): string | null {
  const opens = countOf(value, "<");
  const closes = countOf(value, ">");
  if (opens === 0 && closes === 0) return value;
  if (opens !== 1 || closes !== 1) return null;

  const open = value.indexOf("<");
  const close = value.indexOf(">");
  if (close < open) return null;
  // Anything after the closing bracket (a second address, an RFC comment) makes
  // the header ambiguous.
  if (value.slice(close + 1).trim().length > 0) return null;

  return value.slice(open + 1, close).trim();
}

function countOf(value: string, character: string): number {
  let count = 0;
  for (const candidate of value) if (candidate === character) count += 1;
  return count;
}

/**
 * Lowercase a domain, strip **one** trailing dot, and validate it label by
 * label.
 *
 * The trailing dot is the fully-qualified form: `example.test.` and
 * `example.test` are the same name, and a matcher that treats them as
 * different is one bypass away from an allowlist that never fires. Exactly one
 * is stripped — `example.test..` is malformed and stays refused, because the
 * empty label it leaves behind fails `DNS_LABEL`.
 */
function normalizeDomain(raw: string): string | null {
  let domain = raw.trim().toLowerCase();
  if (domain.endsWith(".")) domain = domain.slice(0, -1);
  if (domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH) return null;
  if (FORBIDDEN_CHARS.test(domain)) return null;

  const labels = domain.split(".");
  // A single label is `localhost` or an internal name. Mail from one cannot be
  // meaningfully allowlisted, and admitting it would let a hostile receiver
  // configuration match a bare word.
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) return null;
    if (!DNS_LABEL.test(label)) return null;
  }
  return domain;
}

/**
 * `seyi+newsletter` → `seyi`.
 *
 * **Sub-address tags are stripped for matching, deliberately.** Forwarding
 * rules and mailing lists rewrite the local part constantly, and an allowlist
 * that only matched the bare address would silently fail on exactly the mail
 * people set this up for. The widening this implies is bounded: `+tag` routing
 * is delivered to the same mailbox by every provider that supports it, so
 * anyone who can send as `seyi+anything@x.test` can already send as
 * `seyi@x.test`.
 *
 * Note what is NOT done: Gmail also ignores dots in the local part, and we do
 * not. That rule is provider-specific, applying it universally would widen
 * matching on domains where `a.b@` and `ab@` are genuinely different people,
 * and this list must never admit somebody the owner did not name.
 *
 * A local part that is *only* a tag (`+tag@x.test`) has nothing to strip to,
 * so it is left intact rather than collapsed to the empty string.
 */
function stripSubAddress(localPart: string): string {
  const plus = localPart.indexOf("+");
  if (plus <= 0) return localPart;
  return localPart.slice(0, plus);
}

/**
 * Normalize a candidate allowlist entry, or `null` if it is not an address.
 *
 * Same parser the evaluator uses, so an entry that stores cannot fail to
 * match its own spelling.
 */
export function normalizeSenderEntry(raw: unknown): string | null {
  return parseEmailAddress(raw)?.address ?? null;
}

/**
 * Normalize a candidate allowlist domain, or `null`.
 *
 * Accepts `example.test`, `@example.test` (what people paste), and
 * `EXAMPLE.TEST.`. Refuses anything with a local part — `seyi@example.test` in
 * the *domain* list is a mistake worth an error, not a silent reinterpretation
 * as "everyone at example.test".
 */
export function normalizeDomainEntry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_INPUT_LENGTH) return null;
  if (FORBIDDEN_CHARS.test(raw)) return null;
  const trimmed = raw.trim().replace(/^@/, "");
  if (trimmed.includes("@")) return null;
  if (/[\s,;<>"()[\]\\/]/.test(trimmed)) return null;
  return normalizeDomain(trimmed);
}

/* -------------------------------------------------------------------------- */
/*                                   policy                                   */
/* -------------------------------------------------------------------------- */

/**
 * The stored settings, as the evaluator sees them.
 *
 * `targetFolder` is not here on purpose: where a message lands is not part of
 * whether it is accepted, and a policy type that carried both would invite a
 * caller to check one and use the other.
 */
export interface IngestionPolicy {
  allowedSenders: readonly string[];
  allowedDomains: readonly string[];
  /** Explicit opt-in to accept from anyone. Never a default, never implied. */
  allowAnySender: boolean;
}

/**
 * May this sender post into this context?
 *
 * The whole decision, in one pure function. `false` means the message is
 * dropped. There is no third answer and no "probably".
 *
 * Order matters and is deliberate:
 *
 *  1. **Parse first, always.** Even `allowAnySender: true` requires a
 *     well-formed address, so "anyone" means "any real sender", not "any
 *     bytes". An unparseable `From:` is a broken or hostile message and there
 *     is nothing useful to do with it.
 *  2. Then the explicit opt-in.
 *  3. Then the address list, then the domain list.
 *
 * An empty policy with `allowAnySender: false` accepts nothing. That is the
 * fail-closed floor, and it is a *reachable* state — an owner who clears both
 * lists has switched ingestion off, and that must not quietly become "accept
 * everything".
 */
export function senderIsAllowed(from: string, policy: IngestionPolicy): boolean {
  const parsed = parseEmailAddress(from);
  if (parsed === null) return false;

  if (policy?.allowAnySender === true) return true;

  const senders = Array.isArray(policy?.allowedSenders)
    ? policy.allowedSenders.slice(0, MAX_ALLOWED_SENDERS)
    : [];
  for (const raw of senders) {
    const entry = parseEmailAddress(raw);
    if (entry === null) continue; // a junk row matches nothing; it never widens
    if (entry.address === parsed.address) return true;
    // An entry with no tag of its own admits any tag on the same mailbox
    // (`seyi@x.test` matches `seyi+news@x.test`). An entry that *does* carry a
    // tag is taken literally: an owner who wrote `seyi+news@x.test` asked for
    // that tag, and quietly admitting `seyi+anything@x.test` would widen a list
    // they wrote narrowly.
    if (
      entry.localPart === entry.baseLocalPart &&
      entry.domain === parsed.domain &&
      entry.baseLocalPart === parsed.baseLocalPart
    ) {
      return true;
    }
  }

  const domains = Array.isArray(policy?.allowedDomains)
    ? policy.allowedDomains.slice(0, MAX_ALLOWED_DOMAINS)
    : [];
  for (const raw of domains) {
    const domain = normalizeDomainEntry(raw);
    if (domain === null) continue;
    // EXACT equality. Never `endsWith`, never a regex built from the entry.
    // `evil.publicworship.life` and `notpublicworship.life` are both strangers.
    if (domain === parsed.domain) return true;
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/*                                target folder                               */
/* -------------------------------------------------------------------------- */

export type FolderRejection =
  | "empty"
  | "too_long"
  | "invalid_characters"
  | "traversal"
  | "reserved";

export type FolderValidation =
  | { ok: true; folder: string }
  | { ok: false; reason: FolderRejection };

/**
 * Validate and canonicalize a target folder.
 *
 * The canonical form has no leading slash, no duplicate slashes, and exactly
 * one trailing slash (`0-inbox/`). A folder, not a file — the receiver appends
 * a generated filename, and a `targetFolder` without the trailing slash would
 * concatenate into `0-inboxmessage.md` in whichever implementation forgot.
 *
 * This is *syntactic* validation. It deliberately does not check that the
 * folder exists in the customer's bucket, and that is not laziness:
 *
 *  - Reading the bucket needs a decrypted credential, which lives behind the
 *    single enumerated barrier in `functions/files.ts` (CLAUDE.md, "Credential
 *    barriers are enumerated, never inferred"). Turning a settings mutation
 *    into a credential-touching action to check a prefix would add a second
 *    barrier for a cosmetic gain.
 *  - S3 has no folders. A "folder" is a shared key prefix, so "does it exist"
 *    has no answer until something is written there — the receiver creating
 *    `2-areas/mail/2026-08-26-subject.md` makes the folder real, exactly as
 *    `createFolder` in `lib/fileOps.ts` does.
 *
 * What it *does* refuse is anything that would escape or collide with the
 * on-bucket layout: `..`, and any dot-prefixed segment, which is the
 * `.history/` and `.audit/` plumbing (`isPlumbing` in `lib/privacy.ts` uses
 * the same rule). Mail landing in `.history/` would forge note history.
 */
export function normalizeTargetFolder(raw: unknown): FolderValidation {
  if (typeof raw !== "string") return { ok: false, reason: "invalid_characters" };
  if (raw.length > MAX_FOLDER_LENGTH * 2) return { ok: false, reason: "too_long" };
  if (FORBIDDEN_CHARS.test(raw)) return { ok: false, reason: "invalid_characters" };
  if (raw.includes("\\")) return { ok: false, reason: "invalid_characters" };

  const cleaned = raw
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");

  if (cleaned.length === 0) return { ok: false, reason: "empty" };

  const segments = cleaned.split("/");
  for (const segment of segments) {
    // `replace(/\/{2,}/g, "/")` already removed empty segments; this catches a
    // segment that is only whitespace, which S3 accepts and nobody can type.
    if (segment.trim().length === 0) return { ok: false, reason: "invalid_characters" };
    if (segment !== segment.trim()) return { ok: false, reason: "invalid_characters" };
    if (segment === "." || segment === "..") return { ok: false, reason: "traversal" };
    if (segment.startsWith(".")) return { ok: false, reason: "reserved" };
  }

  const folder = `${cleaned}/`;
  if (folder.length > MAX_FOLDER_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, folder };
}

/** Human-readable text for a folder rejection. Safe to show verbatim. */
export function describeFolderRejection(reason: FolderRejection): string {
  switch (reason) {
    case "empty":
      return "Pick a folder for incoming mail, for example 0-inbox/.";
    case "too_long":
      return `A folder path must be at most ${MAX_FOLDER_LENGTH} characters.`;
    case "invalid_characters":
      return "That folder path contains characters that are not allowed.";
    case "traversal":
      return 'A folder path cannot contain "." or ".." segments.';
    case "reserved":
      return "Folders beginning with a dot are reserved for history and audit.";
  }
}

/* -------------------------------------------------------------------------- */
/*                              capture address                              */
/* -------------------------------------------------------------------------- */

/**
 * A **personal** context's capture address, derived from its slug.
 *
 * Derived, never stored: the slug is already globally unique and immutable, so
 * a stored copy could only ever be a second source of truth that drifts.
 *
 * Takes a slug rather than a context, and therefore cannot check what it was
 * handed. Callers must only ask this about a context that
 * `resolvePersonalContextForIngestion` has admitted — a shared context has no
 * capture address, and rendering one for it tells a team they have an inbox
 * they do not have. `functions/ingestion.ts` is the only caller and it resolves
 * first.
 */
export function ingestionAddressFor(slug: string): string {
  return `${slug}@${INGESTION_DOMAIN}`;
}

/**
 * The environment variable a deployed receiver sets to announce itself.
 *
 * Named here rather than inlined so the one grep that matters — "what do I flip
 * when the Email Worker ships" — lands on this file and its header, which is
 * where the rest of the story is.
 */
export const INGESTION_RECEIVER_ENV = "INGESTION_RECEIVER";

/**
 * Is anything actually accepting mail at a capture address?
 *
 * **`false` in every environment today, and that is not a placeholder — it is
 * the truth.** There is no Email Worker deployed (see this file's header):
 * `context.lc` has no MX route to one, so a message sent to a capture address
 * is bounced by the receiving edge with `550 5.1.1 Address does not exist`.
 * The owner of this product found that out by mailing the address the console
 * told him to use.
 *
 * ## Why this is a function of the environment and not a constant
 *
 * A constant `false` would have to be *found and edited* by whoever ships the
 * receiver, and a constant `true` written a release too early is exactly the
 * bug this exists to prevent. Reading one environment variable makes the
 * answer a property of the deployment, which is what it actually is: staging
 * can have a receiver while production does not, and neither needs a code
 * change to say so.
 *
 * It is also **false by absence**. A deployment that has never heard of this
 * variable answers "not receiving", and the console draws that as "no delivery
 * claims". Getting it wrong in that direction costs a sentence that
 * understates a working feature; getting it wrong in the other direction is
 * the bug being fixed here.
 *
 * ## Flipping it
 *
 * When the Email Worker is live and routed, set `INGESTION_RECEIVER=live` on
 * the Convex deployment. Nothing else in this repository needs to change: the
 * console gates every sentence about mail landing on the value this returns,
 * so the delivery copy and the Copy button appear on their own.
 *
 * The receiver PR should replace the literal with whatever it genuinely knows
 * — a configured worker hostname, a gateway secret it authenticates with — so
 * that "deployed" cannot be asserted by a variable somebody set by hand. Until
 * there is such a fact to read, a variable somebody sets deliberately is
 * strictly better than a claim nobody has to set at all.
 */
export function ingestionIsReceiving(): boolean {
  return process.env[INGESTION_RECEIVER_ENV] === "live";
}
