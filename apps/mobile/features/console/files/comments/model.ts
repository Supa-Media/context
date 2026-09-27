/**
 * The comment margin's pure half: who wrote a line, how to label it, and
 * where each card goes.
 *
 * The format itself is `packages/shared/src/comments.cjs`, shared with the
 * gateway and the renderers that strip comments from anything published. This
 * file only decides how the console draws what that parser reads, and it has no
 * DOM and no CodeMirror in it so the rules below are checkable in plain node
 * (`__tests__/commentsModel.test.ts`).
 */

import type { CommentEvent, CommentThread } from "@context/shared/src/comments.cjs";
import { agentName } from "../../presence/agentName";

/**
 * A person or an agent, told apart by the name alone.
 *
 * The console writes a person as their `@handle`; the gateway writes an agent
 * as its connection's client name ("Codex", "Claude") and never with an `@`,
 * because `sanitizeAuthor` there is fed the client name and nothing else. So
 * the `@` is the whole test, and a hand-typed line without one reads as an
 * agent's, which is the cautious direction: nobody is shown as a person who
 * might not be one. Somebody's agent, `@jon's Claude` (as presence names it),
 * is an agent too, although it starts with an `@`.
 */
export function isPerson(author: string): boolean {
  return author.startsWith("@") && agentName(author).owner === null;
}

/** Two letters for an agent's square, one for a person's circle. */
export function initialsFor(author: string): string {
  const name = (isPerson(author) ? author : agentName(author).agent).replace(/^@/, "").trim();
  if (!name) return "?";
  if (isPerson(author)) return name[0]!.toUpperCase();
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length > 1) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name[0]!.toUpperCase() + (name[1] ?? "").toLowerCase();
}

/** "now", "4m", "3h", "Tue", or "Sep 26": short enough for a card's header. */
export function whenLabel(at: string, now: number = Date.now()): string {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  const date = new Date(time);
  if (seconds < 6 * 86400) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Below this pane width there is no margin for cards: a thread opens in a
 * bottom sheet instead (`sheet.ts`), and a selection offers a Comment chip.
 */
export const WIDE_MIN = 780;

/** Whether a pane this wide keeps a margin of cards beside the text. */
export function hasMargin(width: number): boolean {
  return width >= WIDE_MIN;
}

/** What the sheet's header quotes: the words on one line, cut at a word near `max`. */
export function quoteLabel(quote: string, max = 60): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The comments in a thread, without its resolve and reopen lines. */
export function messages(thread: CommentThread): CommentEvent[] {
  return thread.events.filter((event) => event.kind === "comment");
}

/** The resolve line a resolved thread shows, from its last status event. */
export function resolvedBy(thread: CommentThread): CommentEvent | null {
  if (thread.status !== "resolved") return null;
  for (let i = thread.events.length - 1; i >= 0; i -= 1) {
    if (thread.events[i]!.kind === "resolved") return thread.events[i]!;
  }
  return null;
}

/** The threads the margin shows: open ones, plus resolved ones when asked. */
export function visibleThreads(threads: readonly CommentThread[], showResolved: boolean): CommentThread[] {
  return threads.filter((thread) => thread.status === "open" || showResolved);
}

export interface Placed {
  id: string;
  top: number;
}

/**
 * Stack cards down the margin without overlap.
 *
 * Each card wants to sit level with its line (`want`). Cards are taken in the
 * order they want to be, and a card that would overlap the one above is pushed
 * down just far enough. The active card is the exception: it gets exactly its
 * line, and the cards above it are pushed *up* to make room, so the thread
 * somebody clicked is always beside the words they clicked. That is Google
 * Docs' behaviour and the reason a margin beats a list.
 */
export function stackCards(
  cards: readonly { id: string; want: number; height: number }[],
  active: string | null,
  gap = 8,
): Placed[] {
  const sorted = [...cards].sort((a, b) => a.want - b.want || a.id.localeCompare(b.id));
  const tops = new Map<string, number>();
  const pivot = active === null ? -1 : sorted.findIndex((card) => card.id === active);
  if (pivot === -1) {
    let floor = -Infinity;
    for (const card of sorted) {
      const top = Math.max(card.want, floor);
      tops.set(card.id, top);
      floor = top + card.height + gap;
    }
  } else {
    const anchor = sorted[pivot]!;
    tops.set(anchor.id, anchor.want);
    let floor = anchor.want + anchor.height + gap;
    for (const card of sorted.slice(pivot + 1)) {
      const top = Math.max(card.want, floor);
      tops.set(card.id, top);
      floor = top + card.height + gap;
    }
    let ceiling = anchor.want - gap;
    for (const card of sorted.slice(0, pivot).reverse()) {
      const top = Math.min(card.want, ceiling - card.height);
      tops.set(card.id, top);
      ceiling = top - gap;
    }
  }
  return sorted.map((card) => ({ id: card.id, top: tops.get(card.id)! }));
}
