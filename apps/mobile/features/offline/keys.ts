import type { VisibilityTier } from "../console/visibility";

/**
 * What a cached thing is filed under.
 *
 * Every key this feature writes goes through here, for four reasons that are
 * each a bug that would otherwise be found in production.
 *
 * **The version segment.** `v2` is in every key. A change to the shape of what
 * is stored bumps it, and the old keys are then unreachable rather than being
 * fed to a parser that no longer understands them — the difference between "an
 * update quietly starts with a cold cache" and "an update crashes on launch
 * reading a record it wrote last month". `sweep()` deletes them.
 *
 * **The workspace segment.** A person belongs to many contexts and the console
 * switches between them; a cache keyed only by path would show one context's
 * note under another's name. Non-negotiable #4 makes that a tenancy question
 * rather than a caching one, so the workspace id is not optional anywhere here.
 *
 * **The scope segment.** A copy of what the bucket said is a copy *filtered by
 * the clearance the reader had at the time*: `scopeForRole` in
 * `functions/files.ts` reads an owner at `private` and narrows everybody else
 * to `team` before a single object is listed or fetched. Membership is a row in
 * the control plane and an owner can change it from another machine, so a copy
 * taken at `private` outlives the clearance that produced it — and nothing on
 * this device hears about the demotion. `forgetContextCopies` fires when a
 * context *leaves* your list, which a demotion does not do.
 *
 * An offline cache cannot re-check authorization: there is nobody to ask. So
 * the clearance is part of the key rather than a field beside the value. A
 * team-level session looks under a key that does not exist and takes a round
 * trip; a stored field would need a comparison at every read, and a comparison
 * is something a later call site can forget. It is the same reason this file
 * already refuses to make the workspace optional.
 *
 * Only `note` and `listing` carry one — see `ScopedKind` below.
 *
 * **The separator.** `U+001F` cannot appear in a bucket path —
 * `assertSafePrefix` in the gateway's adapter rejects control characters, and
 * every key the product writes goes through it. A `/`, a `:` and a space can
 * and do, so a key built from any of those is a key two different notes can
 * collide on. `parseKey` therefore splits on something no path can contain, and
 * round-trips rather than pattern-matching.
 *
 * It is spelled as an escape rather than typed as a raw byte: a control
 * character sitting in a source file makes the file binary to `grep` and is
 * invisible in every diff it ever appears in.
 *
 * ## What a version bump costs, which is not nothing
 *
 * The version segment is shared by all four kinds, so bumping it orphans the
 * two that are somebody's **typing** — a draft and a queued write — alongside
 * the two that are disposable copies. `sweep()` then deletes them, silently, on
 * the first mount after the upgrade. This particular bump is free, because `v1`
 * was never released: the whole offline layer is unmerged. The next one will
 * not be. Anybody bumping this again should either land it before a release or
 * decide, deliberately, that a queue may be discarded — rather than find out
 * afterwards from somebody whose unsent edits went.
 */

const NAMESPACE = "context.lc.offline";
const VERSION = "v2";
/** ASCII unit separator. See the file comment — not a space, not a slash. */
const SEP = "\u001f";

/**
 * How much of a context a session could see when it took a copy.
 *
 * Derived from the console's own tier type rather than re-spelled, so there is
 * one vocabulary for this in the app: `visibilityTierForRole` is the single
 * place the console decides it, and `__tests__/consoleVisibility.test.ts`
 * already pins that against the control plane's `scopeForRole`.
 *
 * `unknown` is excluded because it is a *state*, not a clearance — the moment
 * before the context list has landed. There is no honest key for it: filing
 * under `private` would put a note behind a clearance nobody has established,
 * and filing under `team` would offer it to a team-level session. So a caller
 * that does not know yet writes nothing and reads nothing.
 */
export type CacheScope = Exclude<VisibilityTier, "unknown">;

/** A copy of what the bucket answered, and therefore filtered by a clearance. */
export type ScopedKind =
  /** A note's body and etag as last read from the bucket. */
  | "note"
  /** One folder's listing. */
  | "listing";

/**
 * The person's own typing, which no clearance produced.
 *
 * Deliberately *not* scoped. A draft and a queued write are the only copy of
 * something somebody wrote — the two things `sweep` is forbidden to touch — and
 * keying them by clearance would orphan them on a role change: `waitingOnDevice`
 * would still count them, so the console would warn about unsent work it could
 * then neither show nor drain. They are also not a disclosure route: a draft is
 * only ever restored *after* a note has been read (`openNote` calls `restoreFor`
 * with the note already in hand), so a body this session may not read takes its
 * draft with it, and a queued write is refused by the server like any other.
 */
export type UnscopedKind =
  /** An unsaved draft, which is not the same thing as a queued write. */
  | "draft"
  /** The write queue. One record for the whole context, not one per note. */
  | "outbox";

/** What a key can be about. */
export type Kind = ScopedKind | UnscopedKind;

/*
  Spelled as records rather than as arrays so that adding a member to `Kind` or
  to `CacheScope` without deciding which half it belongs to is a compile error
  rather than a key that silently parses the wrong way. The sets `parseKey`
  checks are derived from them, so the two representations cannot disagree.
*/
const SCOPED: Record<ScopedKind, true> = { note: true, listing: true };
const UNSCOPED: Record<UnscopedKind, true> = { draft: true, outbox: true };
const SCOPES: Record<CacheScope, true> = { private: true, team: true };

const SCOPED_KINDS: ReadonlySet<string> = new Set(Object.keys(SCOPED));
const UNSCOPED_KINDS: ReadonlySet<string> = new Set(Object.keys(UNSCOPED));
const KNOWN_SCOPES: ReadonlySet<string> = new Set(Object.keys(SCOPES));

export interface ParsedKey {
  kind: Kind;
  /** The clearance the copy was taken at; `null` for a kind that carries none. */
  scope: CacheScope | null;
  workspaceId: string;
  /** The bucket path, or `""` for a kind that has none (`outbox`). */
  path: string;
}

const PREFIX = `${NAMESPACE}${SEP}${VERSION}${SEP}`;

/**
 * A key for something that is not a copy of a bucket answer.
 *
 * Typed to `UnscopedKind` on purpose: `keyFor("note", …)` is a **compile
 * error**, so a call site cannot file a cached body under no clearance at all
 * by forgetting an argument. That is the whole reason the scope is in the key
 * rather than beside the value — a rule the compiler enforces beats a rule the
 * reviewer enforces.
 */
export function keyFor(kind: UnscopedKind, workspaceId: string, path = ""): string {
  return `${PREFIX}${kind}${SEP}${workspaceId}${SEP}${path}`;
}

/** A key for a copy of what the bucket said, filed under the clearance that read it. */
export function scopedKeyFor(
  kind: ScopedKind,
  scope: CacheScope,
  workspaceId: string,
  path: string,
): string {
  return `${PREFIX}${kind}${SEP}${scope}${SEP}${workspaceId}${SEP}${path}`;
}

/**
 * The clearances a session at `scope` may be served a copy from, best first.
 *
 * **This function is the direction, and the direction is the security
 * property.** `private` is a superset of `team` — everything a team-level
 * session may read, an owner may read too — so a copy taken at `team` may be
 * served to an owner, and a copy taken at `private` may never be served to a
 * team-level session. Adding `"private"` to the `team` answer is the one-line
 * way to put the leak back.
 *
 * Losing the widening fails the other way: an owner misses the copies they took
 * while they were a member, and pays a round trip. That is why this is a
 * widening applied at the read rather than a comparison applied to a record —
 * what forgetting it costs is a cache miss, not a disclosure.
 *
 * The order is by clearance and not by age, so an owner holding both copies of
 * one note gets the one their own reads keep refreshing. Either way the caller
 * is handed `cachedAt` and the console prints it, which is the rule that makes
 * "which copy" a question about staleness rather than about correctness. It
 * also means a session at `private` spends a second `get` only on a *miss*: a
 * hit answers on the first key.
 */
export function readableAt(scope: CacheScope): readonly CacheScope[] {
  return scope === "private" ? ["private", "team"] : ["team"];
}

/** `null` for anything this version did not write — another app's key, or v1's. */
export function parseKey(key: string): ParsedKey | null {
  if (!key.startsWith(PREFIX)) return null;
  const parts = key.slice(PREFIX.length).split(SEP);

  /*
    The arity is decided by the kind and checked against it, rather than read as
    "however many segments turned up". A `note` key with three segments is a key
    from a shape that has no clearance in it — impossible under this version's
    prefix today, and exactly what a half-finished migration would leave — and
    it is refused rather than parsed as though the clearance had been checked.
  */
  if (parts.length === 3) {
    const [kind, workspaceId, path] = parts as [string, string, string];
    if (!UNSCOPED_KINDS.has(kind)) return null;
    if (workspaceId === "") return null;
    return { kind: kind as UnscopedKind, scope: null, workspaceId, path };
  }
  if (parts.length === 4) {
    const [kind, scope, workspaceId, path] = parts as [string, string, string, string];
    if (!SCOPED_KINDS.has(kind)) return null;
    if (!KNOWN_SCOPES.has(scope)) return null;
    if (workspaceId === "") return null;
    return { kind: kind as ScopedKind, scope: scope as CacheScope, workspaceId, path };
  }
  return null;
}

/**
 * Keys this feature owns but this version cannot read.
 *
 * Anything under the namespace whose version segment is not the current one.
 * Deliberately *not* "everything that fails `parseKey`" — that set includes
 * every key belonging to some other part of the app, and a cache sweep that
 * deletes other people's data is a much worse bug than a stale record.
 */
export function isStaleVersion(key: string): boolean {
  return key.startsWith(`${NAMESPACE}${SEP}`) && !key.startsWith(PREFIX);
}

/** Every key this feature owns, current version or not. For sign-out. */
export function ownedKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => key.startsWith(`${NAMESPACE}${SEP}`));
}

/**
 * Everything a "forget this context" has to take.
 *
 * This version's keys for that workspace, **and every stale-version key**. The
 * second half is not sloppiness: a stale key cannot be attributed to a
 * workspace at all — its layout belongs to a shape this version does not parse
 * — so the choice is between taking them all and leaving a left context's note
 * bodies on the device until the age bound catches them thirty days later.
 * `sweep()` already deletes exactly that set unconditionally on the first mount
 * after an upgrade, so nothing goes here that was not already going; what
 * changes is that leaving a context stops depending on a sweep having run
 * first.
 *
 * It is a function because `forgetWorkspace` clears and `forget.ts` verifies,
 * and two copies of "which keys is this about" is how a clear ends up
 * reporting `cleared` over records it never looked at.
 */
export function keysForWorkspace(keys: readonly string[], workspaceId: string): string[] {
  return keys.filter((key) => isStaleVersion(key) || parseKey(key)?.workspaceId === workspaceId);
}
