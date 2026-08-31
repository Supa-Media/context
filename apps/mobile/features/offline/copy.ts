import type { OutboxCounts } from "./outbox";

/**
 * What a person is told about the connection, the queue, and a conflict.
 *
 * Pure, and separate from every component that renders it, for the reason
 * `files/status.ts` gives for the same split: the rules here are about *what
 * somebody is told*, not about how it is painted, and the console's Jest suite
 * runs in plain node.
 *
 * Two rules run through all of it.
 *
 * **Never claim a durability the store does not have.** `localStorage` and
 * `AsyncStorage` survive the app closing; the in-memory fallback a browser with
 * site data blocked lands on does not. Those are different promises and the
 * sentence changes with the boolean rather than assuming the good case.
 * CLAUDE.md: an absent capability is reported honestly; it is never faked.
 *
 * **Never claim a conflict guarantee the bucket does not have.** The same
 * `conditionalWrite` capability that makes the status bar say "Read-compare
 * writes" applies to a queued write, because a queued write *is* an ordinary
 * conditional write made later. It is worth saying twice here because the delay
 * is the thing that makes a conflict likely: an edit typed on a train and sent
 * an hour later has had an hour in which somebody's Obsidian could sync.
 *
 * Nothing in this file may carry note text — the same rule that keeps note
 * content out of structured logs and out of the UI chrome. Paths and counts
 * only.
 */

/** What the app believes about reaching the network. */
export type Reachability = "online" | "offline" | "unknown";

export interface SyncFacts {
  reachability: Reachability;
  counts: OutboxCounts;
  /**
   * The notes waiting for a person, so the strip can name them.
   *
   * "2 notes need you" with no way to find out which two is a count that
   * cannot be acted on. Paths, never bodies — the same rule that keeps note
   * content out of structured logs, and a path is already drawn all over this
   * console.
   */
  stuckPaths?: readonly string[];
  /** From the store. `false` means the queue does not survive a restart. */
  durable: boolean;
  /**
   * From the storage binding's connect-time probe
   * (`StorageSummary.conditionalWrite`). `undefined` while it is loading.
   */
  conditionalWrite?: boolean;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The connection segment, or `null` when there is nothing to report.
 *
 * Absent while online *and* absent while `unknown`. "Unknown" is the state
 * before the first signal has arrived and on a platform that will not say; an
 * "Offline" chip that flashes on every cold load, or that sits there
 * permanently on a browser with no `navigator.onLine`, is a chip people learn
 * to ignore — and then it is not there on the day it is true.
 */
export function connectionLine(facts: SyncFacts): { text: string; detail: string } | null {
  if (facts.reachability !== "offline") return null;
  return {
    text: "Offline",
    detail: facts.durable
      ? "You can read notes you have opened before and keep editing them. Saves are queued here and sent when you are back."
      : "You can read notes you have opened before and keep editing them. Saves are queued for this session only — closing the app loses them.",
  };
}

/**
 * The queue segment, or `null` when nothing is waiting.
 *
 * Conflicts outrank pending writes, because they are the only half that needs
 * somebody: a pending write is going to sort itself out, and a conflicted one
 * never will.
 */
export function queueLine(
  facts: SyncFacts,
): { text: string; detail: string; tone: "warn" | "crit" } | null {
  const { pending, conflicted, rejected } = facts.counts;
  const stuck = conflicted + rejected;

  if (stuck > 0) {
    const why =
      conflicted > 0
        ? "Somebody else wrote to these while your edit was waiting. Nothing has been overwritten — open each one and choose."
        : "These could not be written to your bucket. Nothing has been lost — open each one to see why.";
    return {
      text: plural(stuck, "note needs you", "notes need you"),
      tone: "crit",
      detail: `${why}${namesOf(facts.stuckPaths)}`,
    };
  }

  if (pending === 0) return null;

  return {
    text: `${plural(pending, "note", "notes")} waiting to sync`,
    tone: "warn",
    detail: queuedDetail(facts),
  };
}

/**
 * " — a.md, b.md and 3 more." for a list, and nothing at all for none.
 *
 * Bounded at three, and a longer list says how many are left rather than
 * printing them: this is a single line in a fixed-height strip, and a sentence
 * that runs off the end is a sentence nobody reads. The same rule the note
 * census follows — a short list is never printed as a complete one.
 */
function namesOf(paths: readonly string[] | undefined): string {
  if (paths === undefined || paths.length === 0) return "";
  const shown = paths.slice(0, 3).join(", ");
  const rest = paths.length - 3;
  return rest > 0 ? ` — ${shown} and ${rest} more.` : ` — ${shown}.`;
}

function queuedDetail(facts: SyncFacts): string {
  const where = facts.durable
    ? "Held on this device until they reach your bucket."
    : "Held for this session only — closing the app loses them.";
  const check =
    facts.conditionalWrite === false
      ? " This bucket cannot do conditional writes, so a conflict is caught by re-reading just before the write — an edit that lands in that gap can still be missed."
      : "";
  return `${where}${check}`;
}

/**
 * What to say before signing out with writes still waiting.
 *
 * Sign-out wipes everything this feature holds — see `forgetEverything` — so
 * this is the last moment anybody can be told. Returned as a sentence rather
 * than raised as a confirm here, so the caller decides between a dialog and a
 * line, and the wording is pinned by a test rather than living inside a
 * component nobody renders in CI.
 */
export function signOutWarning(counts: OutboxCounts): string | null {
  const waiting = counts.pending + counts.conflicted + counts.rejected;
  if (waiting === 0) return null;
  return `${plural(waiting, "note has", "notes have")} edits that have not reached your bucket. Signing out discards them.`;
}

/**
 * How old a cached copy is, said plainly.
 *
 * The console never renders cached content without this beside it. A note that
 * reads as current and is four days behind the bucket is the console telling
 * somebody their context contains something it does not.
 */
export function cachedNotice(age: { cachedAt: number; now: number }): string {
  const elapsed = Math.max(0, age.now - age.cachedAt);
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "Showing the copy on this device, read moments ago.";
  if (minutes < 60) return `Showing the copy on this device, read ${plural(minutes, "minute", "minutes")} ago.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Showing the copy on this device, read ${plural(hours, "hour", "hours")} ago.`;
  const days = Math.floor(hours / 24);
  return `Showing the copy on this device, read ${plural(days, "day", "days")} ago.`;
}

/** Nothing cached, and no way to fetch it. */
export const NOT_CACHED =
  "You are offline and this note is not on this device. Open it once with a connection and it will be here next time.";
