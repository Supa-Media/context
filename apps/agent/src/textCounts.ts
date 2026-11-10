/**
 * HOW MANY TEXTS TEX TOOK IN AND SENT, AND HOW MANY PEOPLE TEXTED IT, FOR THE
 * STAFF DASHBOARD (tex.lc/admin, Dev2 2026-11-10: "DAUs, Tex messages sent and
 * received ... with a date filter").
 *
 * One Workers Analytics Engine point per text (`TEX_COUNTS`, dataset
 * `tex_text_counts`), read back by the control plane's `texStats` with the
 * account's SQL API:
 *
 * - blob1 `in` | `out`; blob2 `one` | `group`; blob3 what kind: for `in`,
 *   `text` (1:1), `for_tex` (a group message queued for Tex) or `heard` (a
 *   group message Tex only kept); for `out`, `text`, `media`, `card` or
 *   `carousel`.
 * - index1 the person, for an `in` point: the id of their own inbox object
 *   (`SENDER_INBOX.idFromName`), which Cloudflare derives with a key of its
 *   own, so it counts a person without naming them and can't be turned back
 *   into a phone number. An `out` point is indexed by its kind.
 *
 * Never a phone number, a chat id or a word. Without the binding (tests,
 * self-hosting) nothing is written, and a binding that throws never costs a
 * text.
 */

export type CountDataset = { writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void };

export type InKind = "text" | "for_tex" | "heard";
export type OutKind = "text" | "media" | "card" | "carousel";

/** The point for a text that came in from `person` (an inbox object's id). */
export function inboundPoint(kind: "one" | "group", what: InKind, person: string): { blobs: string[]; doubles: number[]; indexes: string[] } {
  return { blobs: ["in", kind, what], doubles: [1], indexes: [person.slice(0, 96)] };
}

/** The point for one message Tex sent. */
export function outboundPoint(kind: "one" | "group", what: OutKind): { blobs: string[]; doubles: number[]; indexes: string[] } {
  return { blobs: ["out", kind, what], doubles: [1], indexes: [`out:${kind}`] };
}

function write(dataset: CountDataset | undefined, point: { blobs: string[]; doubles: number[]; indexes: string[] }): void {
  if (!dataset || typeof dataset.writeDataPoint !== "function") return;
  try {
    dataset.writeDataPoint(point);
  } catch {
    // Counting never fails a text.
  }
}

/** A text that came in; `person` is the sender's inbox object id. */
export function countInbound(dataset: CountDataset | undefined, kind: "one" | "group", what: InKind, person: string): void {
  if (typeof person !== "string" || person === "") return;
  write(dataset, inboundPoint(kind, what, person));
}

/** A message Tex sent, counted once the line took it. */
export function countOutbound(dataset: CountDataset | undefined, kind: "one" | "group", what: OutKind): void {
  write(dataset, outboundPoint(kind, what));
}

/** Runs `send` and counts it once it resolved; a send that throws is not counted. */
export async function counted<T>(dataset: CountDataset | undefined, kind: "one" | "group", what: OutKind, send: () => Promise<T>): Promise<T> {
  const result = await send();
  countOutbound(dataset, kind, what);
  return result;
}
