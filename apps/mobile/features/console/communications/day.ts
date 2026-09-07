/**
 * The Channel-day view's data shaping: one day's split parts, stitched into
 * one threaded view in part order.
 */

import { parseChannelDayMessages } from "@context/communications";
import type { ChannelDayView, DayMessageView, DayThreadView } from "./types";

/** One part as fetched: its number and text, or `null` if it failed to load. */
export interface DayPartSource {
  part: number;
  text: string | null;
}

/**
 * Stitch every part of one day into a single view, in part order.
 *
 * Threads are matched **across parts by their subject text**, which is the
 * same "presentation, not identity" grouping `groupIntoThreads` uses inside
 * one file — a thread that spans a split re-emits its `## Thread — ` heading
 * in every part it touches, and matching on that text is what puts its
 * messages back in one bucket rather than one per part. The residual cost is
 * named rather than hidden: two genuinely different threads that happen to
 * share a rendered subject merge into one bucket here, exactly as they would
 * inside a single un-split file — this view does not know more than the note
 * itself does.
 *
 * `partial` is `true` when any part is `null` — a part that failed to load,
 * or one this view has not been given yet — so the caller can say so rather
 * than presenting an incomplete day as a complete one.
 */
export function shapeChannelDay(
  channel: string,
  account: string,
  date: string,
  parts: readonly DayPartSource[],
): ChannelDayView {
  const ordered = [...parts].sort((a, b) => a.part - b.part);

  const threads: DayThreadView[] = [];
  const byThread = new Map<string, DayThreadView>();

  for (const { text } of ordered) {
    if (text === null) continue;
    const parsed = parseChannelDayMessages(text);
    for (const message of parsed.messages) {
      let bucket = byThread.get(message.thread);
      if (bucket === undefined) {
        bucket = { thread: message.thread, messages: [] };
        byThread.set(message.thread, bucket);
        threads.push(bucket);
      }
      const view: DayMessageView = {
        anchor: message.anchor,
        thread: message.thread,
        time: message.time,
        sender: message.sender,
        subject: message.subject,
        body: message.body,
        attachments: message.attachments.map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.size,
        })),
      };
      bucket.messages.push(view);
    }
  }

  return {
    channel,
    account,
    date,
    threads,
    partial: ordered.length === 0 || ordered.some((entry) => entry.text === null),
  };
}

/** Every message across every thread, in the order the day places them — for the anchor scroll. */
export function flattenDayMessages(view: ChannelDayView): DayMessageView[] {
  return view.threads.flatMap((thread) => thread.messages);
}

/** The message at one anchor, or `null` if this day does not have it (a sibling part might). */
export function messageAt(view: ChannelDayView, anchor: string): DayMessageView | null {
  return flattenDayMessages(view).find((message) => message.anchor === anchor) ?? null;
}
