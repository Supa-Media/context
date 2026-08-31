/**
 * When the keyboard accessory bar is on screen, and how much of the note it
 * sits on.
 *
 * Two facts, in one pure module, because **three** components need them and
 * they must not disagree. `NoteEditor` renders the bar from the predicate,
 * `NoteAccessory` is drawn to the height, and `LiveEditor` — which never sees
 * the bar and never renders it — has to tell the editor inside its `WebView`
 * that something is lying over its bottom edge, or the caret ends up behind it.
 *
 * That last one is the reason this is not simply a constant inside
 * `NoteAccessory.tsx`. The bar covers the note; the note has to know; and a
 * number typed into two files is a number that is right in one of them.
 */

import { layout } from "../../design/tokens";

/**
 * Is the accessory bar up?
 *
 * Three conditions, each of which is a real bug if it inverts:
 *
 *  - **`compact`** — a pointer has a real keyboard and the chords that go with
 *    it, and there is no soft keyboard for a floating bar to ride above.
 *  - **`editable`** — every key on the bar but the last writes to the note. On
 *    `privacy.md`, or in a context somebody was invited into as a reader, they
 *    would all be refused; a row of controls that cannot do anything is worse
 *    than no row.
 *  - **`focused`** — the bar rides above the keyboard, and there is no keyboard
 *    until the editing surface has the caret. Taken from the editor's own
 *    focus rather than from the keyboard's visibility, because the keyboard can
 *    be up over a completely different screen.
 */
export function accessoryUp(state: {
  compact: boolean;
  editable: boolean;
  focused: boolean;
}): boolean {
  return state.compact && state.editable && state.focused;
}

/**
 * What the bar occupies above the top of the keyboard, in points.
 *
 * The row itself plus the gap under it. `floatingInset` rather than the frame's
 * own bottom-chrome gap: that gap exists to clear the home indicator, and while
 * the keyboard is up the home indicator is behind the keyboard. What is wanted
 * here is only the visible air between the bar and the keys.
 *
 * **This is a layout constant that `NoteAccessory`'s stylesheet must match**,
 * which is why the stylesheet reads it rather than restating the two numbers.
 */
export const ACCESSORY_HEIGHT = layout.minTouchTarget + layout.floatingInset;

/** The gap between the bar and the top of the keyboard. See `ACCESSORY_HEIGHT`. */
export const ACCESSORY_GAP = layout.floatingInset;
