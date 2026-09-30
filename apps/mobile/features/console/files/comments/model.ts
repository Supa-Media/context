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

/**
 * Who a viewer's comments are signed as, or null when they cannot comment.
 *
 * A signed-in person signs with their `@handle` (an email or "Signed in" is
 * not one). A homepage visitor comments as `@you`: their comments, like their
 * edits, stay in their own tab and are never saved, so the name only has to
 * read well to them. Without it the visitor saw no Comment option at all on a
 * page that is meant to show the real editor (Dev2, 2026-09-28).
 */
export const VISITOR_AUTHOR = "@you";

export function commenterFor(viewerName: string | null | undefined, visitor: boolean): string | null {
  if (viewerName?.startsWith("@")) return viewerName;
  return visitor ? VISITOR_AUTHOR : null;
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

/**
 * Whether `viewer` may delete a comment written by `author`: their own, or
 * anyone's when they may moderate the workspace (its owners). Deleting a
 * thread's first comment deletes the thread, replies included, so a person who
 * started a thread may take it back with the replies it drew. The note is
 * plain Markdown that anyone who may edit it could change by hand; this is the
 * rule the buttons follow, not a lock on the file.
 */
export function mayDelete(author: string, viewer: string | null, moderator: boolean): boolean {
  if (viewer === null) return false;
  return moderator || author === viewer;
}

/**
 * What a card is drawn from, without where its lines sit in the file: an edit
 * above the block moves every offset, and a card keyed on them would be
 * rebuilt on every keystroke.
 */
export function eventsKey(thread: CommentThread): [string, string, string, string][] {
  return thread.events.map((event) => [event.at, event.author, event.kind, event.text]);
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
