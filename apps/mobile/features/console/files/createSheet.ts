/**
 * WHAT THE PHONE'S `+` OFFERS, AND WHETHER IT IS DRAWN AT ALL.
 *
 * The console has two `+`s. The one in the corner at a pointer density
 * (`CreateButton`) is mounted only where every row applies — the layout draws it
 * on no read-only console and on no demo one — so its list is a literal, with
 * the grouping argument in its own comments.
 *
 * The phone's is the bottom row's one key, and **its list varies**: a read-only
 * context has no files to make, a surface with no meetings controller has
 * nothing to record with, and a context with no model key has nothing to answer
 * a conversation. That is three conditions, and the key itself has to ask a
 * fourth question before it is drawn — *is there anything here at all?* A `+`
 * that opens a sheet containing nothing but Cancel is worse than no `+`.
 *
 * So the varying list is a function, asked by the sheet that draws the rows and
 * by the key that decides whether to offer them. Two answers computed in two
 * places is how a `+` that offers nothing gets drawn.
 *
 * The order is `CreateButton`'s, so the two surfaces teach the same thing: a
 * meeting first, because it starts a *recording* rather than a file; the three
 * files together, because they share a destination; the conversation last,
 * because it makes nothing at all.
 */

/** One row of the phone's `+`. */
export type CreateRow = "new-meeting" | "new-note" | "new-drawing" | "new-folder" | "new-chat";

export interface CreateOffer {
  /**
   * May this person write to this context?
   *
   * A read-only browser carries every mutating method and they are inert
   * (`browser.ts`), so a row that reached one would look like it worked and do
   * nothing — which is `menu.ts`'s rule: read-only means the control is *gone*,
   * not present and refusing.
   */
  canEdit: boolean;
  /**
   * Somewhere for the answer to appear, an engine behind it, and a model key on
   * this context.
   *
   * "Somewhere" is the panel at a pointer density and a `Modal` on a phone —
   * `startNewChat` in the console layout picks between them, so this flag is the
   * same question on both and is no longer false just for being a phone.
   */
  chat: boolean;
  /** A meetings controller behind the microphone. */
  meeting: boolean;
}

export function createRows(offer: CreateOffer): CreateRow[] {
  const rows: CreateRow[] = [];
  if (offer.meeting) rows.push("new-meeting");
  if (offer.canEdit) rows.push("new-note", "new-drawing", "new-folder");
  if (offer.chat) rows.push("new-chat");
  return rows;
}

/**
 * Whether to draw the key.
 *
 * The bottom row used to gate it on `canEdit` alone, which was right while the
 * key meant *note*. It means everything now, including a meeting — something a
 * member of somebody else's context can still start — so `canEdit` would have
 * taken meeting capture off every shared context somebody reads, which is the
 * one thing `docs/decisions/meetings.md` says that key existed to guarantee.
 */
export function canCreateAnything(offer: CreateOffer): boolean {
  return createRows(offer).length > 0;
}
