/**
 * What a cached thing is filed under.
 *
 * Every key this feature writes goes through here, for three reasons that are
 * each a bug that would otherwise be found in production.
 *
 * **The version segment.** `v1` is in every key. A change to the shape of what
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
 */

const NAMESPACE = "context.lc.offline";
const VERSION = "v1";
/** ASCII unit separator. See the file comment — not a space, not a slash. */
const SEP = "\u001f";

/** What a key can be about. */
export type Kind =
  /** A note's body and etag as last read from the bucket. */
  | "note"
  /** One folder's listing. */
  | "listing"
  /** An unsaved draft, which is not the same thing as a queued write. */
  | "draft"
  /** The write queue. One record for the whole context, not one per note. */
  | "outbox";

export interface ParsedKey {
  kind: Kind;
  workspaceId: string;
  /** The bucket path, or `""` for a kind that has none (`outbox`). */
  path: string;
}

const PREFIX = `${NAMESPACE}${SEP}${VERSION}${SEP}`;

export function keyFor(kind: Kind, workspaceId: string, path = ""): string {
  return `${PREFIX}${kind}${SEP}${workspaceId}${SEP}${path}`;
}

/** `null` for anything this version did not write — another app's key, or v0's. */
export function parseKey(key: string): ParsedKey | null {
  if (!key.startsWith(PREFIX)) return null;
  const parts = key.slice(PREFIX.length).split(SEP);
  if (parts.length !== 3) return null;
  const [kind, workspaceId, path] = parts as [string, string, string];
  if (kind !== "note" && kind !== "listing" && kind !== "draft" && kind !== "outbox") return null;
  if (workspaceId === "") return null;
  return { kind, workspaceId, path };
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
