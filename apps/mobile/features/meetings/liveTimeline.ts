import { clock } from "./format";

/**
 * A running meeting's notes and transcript as one timeline, for the side
 * panel (owner, 2026-11-19, option B: "one timeline"). Typed notes are the
 * person's own and drawn in full ink; what was said is drawn quieter beside
 * them, in the order it happened.
 *
 * Notes are read from the `- [m:ss] text` lines `appendTypedNote` writes. A
 * line without a stamp (typed on the full screen's pad) keeps its place after
 * the stamped line above it, never jumps to the top.
 */

export interface TimelineRow {
  readonly key: string;
  readonly kind: "note" | "said";
  /** Milliseconds from the start of the meeting, for ordering. */
  readonly at: number;
  /** "3:12", or "" for an unstamped note line. */
  readonly label: string;
  readonly text: string;
}

const STAMPED = /^\s*[-*]\s*\[(\d+(?::\d{2}){1,2})\]\s*(.*)$/;

function parseClock(value: string): number {
  return value.split(":").reduce((total, part) => total * 60 + Number(part), 0) * 1000;
}

export function liveTimeline(
  notes: string,
  transcript: readonly { id: string; startMs: number; speaker: string | null; text: string }[],
  saidTail: number,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let last = 0;
  notes.split("\n").forEach((line, index) => {
    const stamped = STAMPED.exec(line);
    if (stamped !== null) {
      last = parseClock(stamped[1]);
      if (stamped[2].trim() !== "") {
        rows.push({ key: `n${index}`, kind: "note", at: last, label: stamped[1], text: stamped[2].trim() });
      }
      return;
    }
    const text = line.replace(/^\s*[-*]\s*/, "").trim();
    if (text !== "") rows.push({ key: `n${index}`, kind: "note", at: last, label: "", text });
  });
  for (const segment of transcript.slice(-saidTail)) {
    rows.push({
      key: `s${segment.id}`,
      kind: "said",
      at: segment.startMs,
      label: clock(segment.startMs),
      text: segment.speaker === null ? segment.text : `${segment.speaker}: ${segment.text}`,
    });
  }
  // Stable: two rows at one moment keep notes-then-transcript order.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.at - b.row.at || a.index - b.index)
    .map(({ row }) => row);
}
