import type { MirrorStatus } from "./mirrorStatus";
import { formatCount } from "../console/format";
import { formatBytes } from "../console/files/paths";
import { relativeTime } from "../console/files/status";

/**
 * What a person is told about how much of a context is on their device.
 *
 * Pure, and beside `copy.ts` rather than inside it, for the reason `copy.ts`
 * gives for itself: the rules are about *what somebody is told*, and the suite
 * runs in plain node. Paths never appear here, and never note text — counts,
 * sizes and ages only.
 *
 * **Quiet unless it changes what somebody can do.** A mirror that is complete,
 * or downloading, is the ordinary case: it is a fact in the desktop strip and a
 * line in the phone's sheet, and it never raises the phone's pill on its own —
 * a pill that sat in the header of every synced phone would be a pill people
 * stop seeing, which is `connectionLine`'s argument about "Offline". It turns
 * `warn` only while the device is **offline** and the mirror is not whole,
 * because that is the moment a note somebody reaches for may not be there.
 * Online, "only part of this fits offline" is still said — quietly — so a
 * context too large to list in full is not a permanent alarm.
 */

export interface MirrorLine {
  /** The whole sentence: the phone's sheet, a tooltip. */
  text: string;
  /** The same fact in a few words, for a segment in the desktop strip. */
  short: string;
  /** What it means for the person, one or two sentences. */
  detail: string;
  tone: "quiet" | "warn";
}

function notes(n: number): string {
  return `${formatCount(n)} ${n === 1 ? "note" : "notes"}`;
}

/**
 * The line for one context's mirror.
 *
 * `offline` is whether the device says it is offline right now — `unknown` is
 * not offline, for `connectionLine`'s reason: a warning that flashes on every
 * cold load is one people learn to ignore.
 */
export function mirrorLine(
  status: MirrorStatus,
  options: { now: number; offline: boolean },
): MirrorLine {
  const { now, offline } = options;
  const attention = offline && status.state !== "synced" && status.state !== "syncing";
  const tone: MirrorLine["tone"] = attention ? "warn" : "quiet";
  const size = status.bytes > 0 ? ` (${formatBytes(status.bytes)})` : "";

  switch (status.state) {
    case "syncing": {
      const total = status.total ?? status.notes + (status.remaining ?? 0);
      const done = Math.max(0, total - (status.remaining ?? 0));
      return {
        text: `Downloading ${formatCount(done)} of ${notes(total)}…`,
        short: `Downloading ${formatCount(done)} of ${formatCount(total)}`,
        detail:
          "Every note you can see in this context is being put on this device, so it opens with no connection. You can keep working while it runs.",
        tone,
      };
    }
    case "synced": {
      const age = status.lastSyncedAt === null ? null : relativeTime(status.lastSyncedAt, now);
      const all = status.notes === 1 ? "Your 1 note is" : `All ${notes(status.notes)} are`;
      return {
        text:
          status.notes === 0
            ? `Nothing to download in this context${age === null ? "" : ` · checked ${age}`}`
            : `${status.notes === 1 ? "Your 1 note" : `All ${notes(status.notes)}`} on this device${age === null ? "" : ` · synced ${age}`}`,
        short: `${notes(status.notes)} offline`,
        detail: `${all} on this device${size} and open${status.notes === 1 ? "s" : ""} with no connection. Edits made offline are queued and sent when you are back.`,
        tone,
      };
    }
    case "partial": {
      if (status.truncatedReason === "manifest-truncated") {
        return {
          text: "Only part of this context fits offline — it is too large to list in full",
          short: "Partly offline",
          detail: `${notes(status.notes)} are on this device${size}. Some notes in this context could not be listed, so they may not open without a connection.`,
          tone,
        };
      }
      const missing = status.remaining ?? 0;
      const why =
        status.truncatedReason === "interrupted"
          ? "The last download stopped part-way — the connection went, or the app closed. The rest comes down the next time you are connected."
          : "Some notes could not be read from your bucket. They are tried again on the next sync.";
      return {
        text:
          missing > 0
            ? `Only part of this context is on this device — ${notes(missing)} not downloaded`
            : "Only part of this context is on this device",
        short: missing > 0 ? `${formatCount(missing)} not offline` : "Partly offline",
        detail: `${notes(status.notes)} are on this device${size}. ${why}`,
        tone,
      };
    }
    case "never":
      return status.notes > 0
        ? {
            text: "Only notes you have opened are on this device — connect to download the rest",
            short: "Not downloaded yet",
            detail:
              "This context has not been downloaded to this device yet. The notes you opened are here; the rest come down the first time you are connected.",
            tone,
          }
        : {
            text: "Not yet downloaded — connect once to put this context on this device",
            short: "Not downloaded yet",
            detail:
              "Nothing from this context is on this device yet. Open the app once with a connection and every note you can see is downloaded.",
            tone,
          };
    case "unavailable":
      return {
        text: "This browser is not keeping an offline copy — only notes you open are saved here",
        short: "No offline copy",
        detail:
          "This browser will not let the app store a full copy of your notes (private browsing, or site data turned off), so only the notes you open are kept for offline reading, and only for a while.",
        tone,
      };
  }
}
