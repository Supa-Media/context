/**
 * HOW LONG EACH TEXT WAITED FOR ITS ANSWER, WHERE CLAUDE CAN READ IT (Dev2,
 * 2026-10-31: simple asks answered in under five seconds).
 *
 * The gateway's `tex_timing` sees a turn from the moment it reads the
 * request. What the person feels starts earlier, when their text reached this
 * Worker, and ends when the first bubble of the answer went out. So every
 * answered text writes one point to Workers Analytics Engine (`TEX_TEXTS`,
 * dataset `tex_text_timing`, read with the account's SQL API): its kind
 * ("one" or "group") and milliseconds only (`TEXT_COLUMNS`), never a phone
 * number, a chat or a word. Without the binding (self-hosting, tests) nothing
 * is written; a binding that throws never costs the reply.
 */

export type TimingDataset = { writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void };

/**
 * doubles, in order: from arrival to the turn starting (the queue, the
 * pause, decide), the gateway's answer, the work between the answer and the
 * first send, the sends, arrival to the first bubble out (what the person
 * waits), arrival to the last, the work after the sends, and how many parts
 * went. A step not reached, or a text whose arrival was not kept, is -1.
 */
export const TEXT_COLUMNS = ["queueMs", "gatewayMs", "beforeSendMs", "sendMs", "toFirstTextMs", "toLastTextMs", "afterSendMs", "parts"] as const;

export type TextTimingRow = Partial<Record<(typeof TEXT_COLUMNS)[number], number>>;

/** The point for one answered text: a missing or negative step is -1. */
export function textTimingPoint(kind: "one" | "group", row: TextTimingRow): { blobs: string[]; doubles: number[]; indexes: string[] } {
  const doubles = TEXT_COLUMNS.map((name) => {
    const value = row[name];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : -1;
  });
  return { blobs: [kind], doubles, indexes: [kind] };
}

/** Writes the point, best effort. False without a binding. */
export function writeTextTiming(dataset: TimingDataset | undefined, kind: "one" | "group", row: TextTimingRow): boolean {
  if (!dataset || typeof dataset.writeDataPoint !== "function") return false;
  try {
    dataset.writeDataPoint(textTimingPoint(kind, row));
  } catch {
    // Diagnostics never fail a reply.
  }
  return true;
}
