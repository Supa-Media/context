/**
 * Where a meeting lives on the device.
 *
 * The shape and the reasoning are `features/offline/keys.ts`'s, applied to a
 * different kind of thing, and the three segments it argues for are here for
 * the same reasons:
 *
 * **The version segment.** A change to `MeetingRecord` bumps it, and the old
 * keys become unreachable rather than being fed to a parser that no longer
 * understands them. Unlike the offline cache there is no sweep that deletes
 * them, and that is deliberate — a meeting that has not reached the bucket is
 * somebody's typing, and this feature never evicts one.
 *
 * **The workspace segment.** A person belongs to many contexts, and a meeting
 * belongs to exactly one. Non-negotiable #4 makes that a tenancy question:
 * a meeting recorded into a shared workspace must not surface under a brain.
 *
 * **The separator.** `U+001F`, which cannot appear in a bucket path or in a
 * meeting id (`mtg_` plus twenty lowercase base32 characters), so a key cannot
 * be forged by a value inside it. Spelled as an escape, not typed as a raw
 * byte, so the file stays greppable and the diffs stay readable.
 *
 * ## There is no scope segment, and that is a decision
 *
 * A cached note is a copy of an answer the gateway already filtered by the
 * reader's clearance, which is why `features/offline/keys.ts` files it under
 * that clearance. A meeting is not a copy of anything: it is the notes this
 * person typed and the transcript their own device produced, before either has
 * reached the gateway. Nothing filtered it, so filing it under a clearance
 * would be inventing one — and it would orphan a meeting on a role change,
 * exactly as that file says keying a *draft* by clearance would.
 *
 * ## The namespace is its own, and what that costs
 *
 * `context.lc.meetings`, not `context.lc.offline`. Reusing the offline
 * namespace would have been tempting — sign-out clears everything under it —
 * and it is wrong in a way that loses data: `sweep()` deletes every key under
 * that namespace whose version segment it does not recognise, on the first
 * mount after an upgrade, and a meeting that has not reached the bucket is not
 * a disposable copy.
 *
 * **`forgetLocalCopies` clears these keys**, since 2026-09-06. It clears
 * `ownedKeys` (the offline namespace) and then, explicitly and by name, the
 * last-place keys from `console/lastPlace.ts` and this namespace — a feature
 * with its own namespace is named in that function rather than swept up by
 * accident, and a clear that module does not measure is the silent half-clear
 * its own "never silently" stance exists to prevent.
 *
 * This paragraph used to say the opposite, and a "PINNED GAP" test asserted
 * the gap so it was a red line rather than a comment nobody reads. That test
 * carried its own instruction — when it fails, replace it with the opposite
 * assertion — and `__tests__/offlineForget.test.ts` now holds it, driving the
 * real `forgetLocalCopies` rather than the namespace sweeper directly.
 *
 * The other barrier, unchanged, is the epoch: every write goes through
 * `features/offline/epoch.ts`, so nothing lands after a session has ended.
 */

const NAMESPACE = "context.lc.meetings";
const VERSION = "v1";
/** ASCII unit separator. Not a space, not a slash — see the file comment. */
const SEP = "\u001f";

const PREFIX = `${NAMESPACE}${SEP}${VERSION}${SEP}`;

/** One meeting's record. */
export function meetingKey(workspaceId: string, meetingId: string): string {
  return `${PREFIX}meeting${SEP}${workspaceId}${SEP}${meetingId}`;
}

/**
 * The destination this device chose last time the sheet was opened.
 *
 * Under this feature's namespace and this feature's separator, deliberately:
 * the value is a context slug and the name of one of somebody's folders, which
 * is exactly the kind of thing `console/lastPlace.ts` says must leave a device
 * on sign-out. `meetingKeys` already names everything under this namespace, so
 * putting it here means one list rather than two to keep in step.
 *
 * **It does not follow that sign-out takes it, and this comment used to say it
 * did.** `forgetLocalCopies` clears the offline namespace and the last-place
 * keys by name, and `meetingKeys` is not on that list yet — which the file
 * header thirty lines up states correctly and this paragraph contradicted. The
 * On a shared device this would otherwise be a previous person's context slug
 * and folder name surviving their sign-out and preselecting a row for the next,
 * which is why `forgetLocalCopies` names this namespace explicitly.
 * `__tests__/offlineForget.test.ts` holds that, driving the real sign-out.
 *
 * It carries **no workspace segment**, unlike a meeting. A meeting belongs to
 * one context; this is a preference of the person holding the phone, and filing
 * it per workspace would mean a choice made in one context silently failing to
 * apply in the next — which is the opposite of "the last choice is remembered".
 *
 * `parseMeetingKey` answers `null` for it, which is what keeps it out of
 * `loadMeetings`: a key that does not name a meeting is not counted as a
 * meeting this build could not read.
 */
export function destinationKey(): string {
  return `${PREFIX}destination`;
}

export interface ParsedMeetingKey {
  workspaceId: string;
  meetingId: string;
}

/** `null` for anything this version did not write — another feature's key, or v0's. */
export function parseMeetingKey(key: string): ParsedMeetingKey | null {
  if (!key.startsWith(PREFIX)) return null;
  const parts = key.slice(PREFIX.length).split(SEP);
  if (parts.length !== 3) return null;
  const [kind, workspaceId, meetingId] = parts as [string, string, string];
  if (kind !== "meeting") return null;
  if (workspaceId === "" || meetingId === "") return null;
  return { workspaceId, meetingId };
}

/**
 * Every key this feature owns, current version or not.
 *
 * For sign-out, and for the test that pins what sign-out does not do yet. It is
 * the whole namespace rather than `parseMeetingKey` succeeding, for the reason
 * `ownedKeys` gives: a key from a version this build cannot parse is still this
 * feature's to clear, and leaving it behind leaves note text on the device.
 */
export function meetingKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => key.startsWith(`${NAMESPACE}${SEP}`));
}

/** This version's keys for one workspace. For leaving a context. */
export function meetingKeysForWorkspace(
  keys: readonly string[],
  workspaceId: string,
): string[] {
  return keys.filter((key) => parseMeetingKey(key)?.workspaceId === workspaceId);
}
