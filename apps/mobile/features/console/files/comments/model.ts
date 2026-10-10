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

/** One thing the margin draws, wanting to sit level with its line (`want`). */
export interface MarginItem {
  id: string;
  want: number;
  height: number;
  /**
   * Whether it may fold into a "more here" row. Threads may; the draft being
   * typed and the Show resolved toggle may not.
   */
  foldable: boolean;
}

/**
 * A row standing in for threads there was no room to show beside their words:
 * "3 more here". `key` is its first thread's id. Open, its threads are drawn
 * one under another below it.
 */
export interface Fold {
  key: string;
  ids: string[];
  top: number;
  open: boolean;
}

/** How far (px) below its line a card may sit before it folds instead. */
export const FOLD_SLACK = 48;
/** The fold row's height; `styles.ts` draws it exactly this tall. */
export const FOLD_HEIGHT = 30;

/**
 * Where every card in the margin goes (Dev2, 2026-10-10, option C of
 * https://claude.ai/artifact/EUFVCFb6J84JdsncMfGyC5).
 *
 * A card sits level with its line, or a little below it when the card above
 * reaches that far, never more than `FOLD_SLACK` below. A thread that would be
 * pushed further joins a "N more here" row at that spot instead, so a busy
 * paragraph's cards neither drift down beside the next paragraph nor land on
 * each other. Nothing ever moves up: the old rule pushed the cards above the
 * active one up past the top of the note, where they were stopped at the edge
 * on top of each other.
 *
 * When the active thread is folded, its row is open and its threads are drawn
 * under it. A card that only lands too far from its line because an open row
 * pushed it folds into a row of its own, so opening a row never changes what
 * that row holds.
 */
export function layoutMargin(
  items: readonly MarginItem[],
  active: string | null,
  gap = 8,
): { placed: Placed[]; folds: Fold[] } {
  const sorted = [...items].sort((a, b) => a.want - b.want || a.id.localeCompare(b.id));
  const run = (open: ReadonlySet<string>) => {
    const placed: Placed[] = [];
    const folds: Fold[] = [];
    let floor = -Infinity;
    let fold: Fold | null = null;
    for (const item of sorted) {
      const top = Math.max(item.want, floor);
      if (!item.foldable || top - item.want <= FOLD_SLACK) {
        fold = null;
        placed.push({ id: item.id, top });
        floor = top + item.height + gap;
        continue;
      }
      // An open row takes only its own threads; anything else starts a new one.
      if (fold !== null && fold.open && !open.has(item.id)) fold = null;
      if (fold === null) {
        fold = { key: item.id, ids: [], top: floor, open: open.has(item.id) };
        folds.push(fold);
        floor = fold.top + FOLD_HEIGHT + gap;
      }
      fold.ids.push(item.id);
      if (fold.open) {
        placed.push({ id: item.id, top: floor });
        floor += item.height + gap;
      }
    }
    return { placed, folds };
  };
  const closed = run(new Set());
  const holding = active === null ? undefined : closed.folds.find((fold) => fold.ids.includes(active));
  // Everything above the row lays out the same either way, so the second run
  // folds the same threads into it and only opens it.
  return holding ? run(new Set(holding.ids)) : closed;
}

/**
 * Lift what would run past the bottom of the screen, so a thread on one of the
 * last lines is read whole instead of cut off (Dev2, 2026-09-30, in the cast
 * studio). The lowest box whose line is on screen may rise above its own line
 * to fit; a box above it moves up only to stay clear of it, and never above its
 * own line (Dev2, 2026-10-10: comments stay beside what they are about) or the
 * top of the note. When that is not enough room, the whole lift gives way and
 * the lowest box is cut off instead. A box whose line is below the screen keeps
 * its place, to be met when the note is scrolled there.
 */
export function keepInView(
  boxes: readonly (Placed & { want: number; height: number })[],
  view: { top: number; bottom: number },
  gap = 8,
): Placed[] {
  const lifted = new Map<string, number>();
  let ceiling = view.bottom;
  let giveWay = 0;
  const candidates = boxes.filter((box) => box.want < view.bottom).sort((a, b) => b.top - a.top);
  for (const box of candidates) {
    const onScreen = box.want >= view.top;
    const top = onScreen || box.top + box.height > ceiling ? Math.min(box.top, ceiling - box.height) : box.top;
    if (top !== box.top) {
      const lead = lifted.size === 0;
      lifted.set(box.id, top);
      const highest = lead ? 0 : Math.max(0, Math.min(box.top, box.want));
      giveWay = Math.max(giveWay, highest - top);
    }
    ceiling = top - gap;
  }
  return boxes.map((box) => {
    const top = lifted.get(box.id);
    return { id: box.id, top: top === undefined ? box.top : Math.min(box.top, top + giveWay) };
  });
}
