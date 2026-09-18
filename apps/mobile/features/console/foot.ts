import { layout } from "../design/tokens";
import { stripOrder } from "./strip";
import type { ConsoleContext } from "./types";

/**
 * What goes on the foot of the file tree, and in what shape.
 *
 * ## Why there is a row here at all
 *
 * Switching workspaces was one control: the chip in the title bar, which opens
 * a menu. The owner's report of it is the specification for this file:
 *
 * > Right now, it's not super visible — all the workspaces that someone's in,
 * > you got to click on it and drop down… I want people to be able to switch
 * > more quickly.
 *
 * A menu is two presses and, worse, it is *invisible at rest*: nothing on the
 * screen says that `@supa` exists, so nothing reminds anybody it is there. The
 * answer chosen from five drawn options is a row at the foot of the panel that
 * is already on screen — where you are, spelled out, and the contexts you were
 * in last beside it. It costs no width from the note, which is the whole reason
 * the rail was folded away in the first place ("The rail folds into the
 * switcher, and the column it occupied goes to the note").
 *
 * ## The rules are here because the row has to answer a width
 *
 * The tree column is resizable — `layout.explorerMinWidth` to
 * `explorerMaxWidth`, 200 to 460 — and the owner's second instruction is that
 * the row spends the extra:
 *
 * > when people extend it, we should be able to accommodate more space and
 * > maybe even show some of the workspace name if we have enough space… if
 * > someone only has two workspaces and they're able to comfortably fit on
 * > that bottom panel without it being too crowded, then why not?
 *
 * So the shape of the row is a function of the measured width and the actual
 * names, and it lives in a `.ts` beside the component for the reason `strip.ts`
 * states about ordering: a rule decided from data is a rule with tests that run
 * in plain node with no renderer, and this one has an arithmetic that is very
 * easy to get quietly wrong.
 *
 * ## Named or marks, and never half a name
 *
 * **Nothing here truncates.** That is `ContextStrip`'s rule and it applies with
 * more force on a 24pt square: "`@acme-engineering` ellipsised to `@acme-eng…`
 * is two contexts that look identical, on the one control whose entire job is
 * telling them apart". A name is drawn whole or it is not drawn, and what is
 * left when it is not drawn is the mark — a letter, which does not pretend to
 * be a name.
 *
 * So the recents are **all named or all marks**, decided once for the row. The
 * obvious alternative is greedy — name the ones that fit, left to right — and
 * it was not taken: it makes widening the panel by ten points change the shape
 * of exactly one pill, and it draws a row whose items are two different objects
 * for no reason a reader could name. One flip point is predictable; three are a
 * layout that shudders under the drag handle.
 *
 * ## Three recents, whatever the width
 *
 * Extra width buys **names**, not a fourth workspace. The row is a fast path
 * back to the one or two places somebody is actually alternating between, and
 * the chevron behind it is the complete list; a row that grew towards a dozen
 * marks would be the rail coming back at the bottom of the panel, which is the
 * decision this one is careful not to reverse.
 */

/** How many contexts sit beside the current one. See the header. */
export const RECENT_SLOTS = 3;

/**
 * The advance of one character of the 12pt interface face, rounded up.
 *
 * `Menu.web.tsx` measures its own box the same way and says the same thing
 * about it: it is an estimate, and it is the only one here. The rounding is
 * deliberately **generous** — it is what decides whether the names are drawn at
 * all, and a guess that runs a little wide falls back to the marks, while a
 * guess that runs narrow clips a name against the chevron. One of those two
 * failures is a row that says less than it could; the other is the ellipsis
 * this file just spent a paragraph refusing.
 */
const CHAR_WIDTH = 7;

/** The row's own padding, left and right. */
const ROW_PADDING = 10;
/** Between the current pill, the recents and the chevron. */
const GROUP_GAP = 8;
/** Between two recents. */
const ITEM_GAP = 6;
/** The chevron's target. */
const CHEVRON = 24;
/** A mark on its own: an 18pt square in a 24pt target. */
const MARK = 24;
/**
 * What a pill adds around its name: the mark, the gap after it and the padding
 * either side. `WorkspaceMark` is 18 square — budgeted at its real size rather
 * than at the 16 an earlier draft guessed, because an estimate that runs under
 * is the one that clips a name.
 */
const PILL_CHROME = 18 + ITEM_GAP + 5 + 9;

/** The width a pill naming this context wants. `@` included — it is drawn. */
function namedWidth(slug: string): number {
  return PILL_CHROME + (slug.length + 1) * CHAR_WIDTH;
}

export interface FootPlan {
  /** The contexts beside the current one, most recently visited first. */
  recent: ConsoleContext[];
  /**
   * Whether those are drawn as named pills. `false` draws them as marks, which
   * is the narrow answer rather than a lesser one — see the header.
   */
  named: boolean;
}

/**
 * The row, or `null` where there should not be one.
 *
 * `null` when there is nowhere to go: one workspace and no others is a person
 * whose name is already in the title bar, and a 40pt band offering them a
 * choice of one is chrome that does nothing. `stripEntries` refuses to draw the
 * phone's strip on the same reasoning and for the same reason — the band goes
 * back to the thing it was taken from, which here is the tree.
 *
 * `width` is the row's own measured width, not the column's: the caller
 * measures, so nothing here has to know what padding the panel has today.
 * `null` before the first measurement, which is treated as the resting column
 * width — the common case by a long way, so assuming it is what keeps the row
 * from drawing marks for one frame and names for the next on every mount.
 */
export function footPlan({
  width,
  contexts,
  currentSlug,
  recent,
}: {
  width: number | null;
  contexts: readonly ConsoleContext[];
  currentSlug: string | null;
  /** The recency log from `lastPlace.ts`, most recently visited first. */
  recent: ReadonlyArray<{ slug: string }>;
}): FootPlan | null {
  const rest = stripOrder(contexts, currentSlug, recent).slice(0, RECENT_SLOTS);
  if (rest.length === 0) return null;

  const room = width ?? layout.explorerWidth;
  const chrome = ROW_PADDING * 2 + GROUP_GAP + CHEVRON;
  const gaps = ITEM_GAP * (rest.length - 1);

  /*
    **Names are all-or-nothing, and the current context's name is part of the
    all.** A row that drew three whole names beside a current one cut off at
    `@public-wor…` would be spending its width on the three places you are not
    and clipping the one you are, so the wide answer is only taken when every
    name on the row is whole.
  */
  const current = currentSlug === null ? 0 : namedWidth(currentSlug) + GROUP_GAP;
  const names = rest.reduce((sum, context) => sum + namedWidth(context.slug), gaps);
  if (chrome + current + names <= room) return { recent: rest, named: true };

  /*
    In the marks shape the current pill is the one thing on this row allowed to
    give, so it is budgeted at its mark and its padding and the label takes what
    is left (`flexShrink` in the component, `numberOfLines={1}` on the label).

    That looks like the ellipsis this file refuses two paragraphs above, and the
    difference is what the two pieces of text are *for*. A recent's name is how
    you tell one destination from another — `@acme-eng…` beside `@acme-ops…` is
    two buttons that look identical, which is the whole defect. The current one
    is a label for where you already are, said again in the breadcrumb at the top
    of the note and in the title bar's chip; it is the third copy, and the third
    copy is the one that can afford to be short.

    The alternative was tried and is worse: budgeting the current name whole made
    the entire row disappear at the 200pt floor for any context with a long name
    — the fast path vanishing exactly when the panel is narrow, which is when a
    menu costs most.
  */
  const minimum = currentSlug === null ? 0 : PILL_CHROME + GROUP_GAP;

  /*
    The marks do not always fit either, so the row sheds its least-recent
    entries until what is left does, and if nothing fits it is not drawn.

    **Shedding rather than scrolling.** A horizontally scrolling row was one of
    the five options drawn and is the one this replaced — a scroll gesture on a
    pointer is the worst way to reach something that was meant to be one click
    away. A row that quietly holds two workspaces instead of three is still a
    fast path; a row that hides the third behind a drag is a menu with extra
    steps, and the chevron is already a better menu.
  */
  let fit = rest.length;
  while (fit > 0 && chrome + minimum + MARK * fit + ITEM_GAP * (fit - 1) > room) fit -= 1;
  if (fit === 0) return null;
  return { recent: rest.slice(0, fit), named: false };
}
