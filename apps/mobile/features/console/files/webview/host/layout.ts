/**
 * The box the web view is laid out in, and how much of it something else is
 * covering — keyboard insets, the caret's overshoot past the keyboard, and
 * the estimated height before the guest's first `height` message. Split out
 * of `../host.ts` — see that facade for the file this used to be.
 */

/**
 * How many points of the editor something else is sitting on top of.
 *
 * Computed from where the editor actually is rather than from the keyboard's
 * height, because those are different numbers whenever anything above resizes
 * the editor for the keyboard already — a `KeyboardAvoidingView`,
 * `react-native-keyboard-controller`. Measuring the overlap means this is right
 * whether that happens or not, and goes to zero on its own if it does, rather
 * than padding the note twice.
 *
 * ## The accessory bar is added rather than measured, and that is the honest
 * shape of it
 *
 * `KeyboardSticky` positions the bar absolutely and translates it up by the
 * keyboard's height, so it is drawn *over* the editor and resizes nothing. The
 * overlap above cannot see it — there is nothing in the layout to measure — so
 * its height is added on top, from `ACCESSORY_HEIGHT`, whenever it is up.
 *
 * It is a constant rather than an `onLayout`, and the trade is worth stating:
 * a measured height would be right if the row ever grew a second line, and it
 * would also arrive a frame *after* the keyboard, which is the one frame in
 * which the caret is behind the bar and the person is watching. The row is a
 * fixed-height pill by construction — see `NoteAccessory`'s stylesheet, which
 * reads the same constant — so the number cannot drift without a test failing.
 */
export function coveredHeight(box: {
  /** The editor's top edge, in window coordinates. */
  top: number;
  height: number;
  windowHeight: number;
  /** What the keyboard occupies at the bottom of the window. 0 when hidden. */
  keyboardHeight: number;
  /** What the accessory bar occupies above the keyboard. 0 when it is not up. */
  accessoryHeight?: number;
}): number {
  if (box.keyboardHeight <= 0) return 0;
  const editorBottom = box.top + box.height;
  const keyboardTop = box.windowHeight - box.keyboardHeight;
  const overlap = Math.max(0, Math.round(editorBottom - keyboardTop));
  return overlap + Math.max(0, Math.round(box.accessoryHeight ?? 0));
}

/**
 * A line of breathing room between the caret and whatever is covering the note.
 *
 * A caret flush against the top of the keyboard is technically visible and
 * reads as clipped, and it leaves no sight of the line being typed after this
 * one. One reading line at compact — 16px on a 1.5 line box, from `themeVars` —
 * rounded to something that does not pretend to more precision than it has.
 */
export const CARET_MARGIN = 24;

/**
 * How far the surface holding the editor has to scroll to bring the caret out
 * from under the keyboard. Zero when it is already clear.
 *
 * **The counterpart of `coveredHeight`, for the density where CodeMirror cannot
 * do this itself.** At compact the web view is as tall as its document, so its
 * own scroller has nothing to scroll and `coveredBottom`'s scroll margin has
 * nothing to act on; the note's page scroller is the thing that moves. Every
 * input is a measurement — where the editor actually is, where the caret
 * actually is inside it — so this is arithmetic with no opinion about which
 * component holds the scroller, and is tested as such.
 */
export function caretOvershoot(box: {
  /** The editor's top edge, in window coordinates. Negative once scrolled past. */
  editorTop: number;
  /** The bottom of the caret, in pixels from the editor's own top edge. */
  caretBottom: number;
  windowHeight: number;
  /** What the keyboard occupies at the bottom of the window. 0 when hidden. */
  keyboardHeight: number;
  /** What the accessory bar occupies above the keyboard. 0 when it is not up. */
  accessoryHeight?: number;
}): number {
  if (box.keyboardHeight <= 0) return 0;
  const clear =
    box.windowHeight - box.keyboardHeight - Math.max(0, box.accessoryHeight ?? 0) - CARET_MARGIN;
  const caret = box.editorTop + box.caretBottom;
  return Math.max(0, Math.ceil(caret - clear));
}

/**
 * How tall the note is drawn while the guest is still measuring it, as a share
 * of the window.
 *
 * The first `height` message arrives a frame or two after the guest says
 * `ready`, and something has to be on the glass until it does. Three fifths of
 * the window is deliberately an under-estimate: a box that starts too short
 * grows into place, and one that starts too tall leaves the durability line
 * stranded below the fold and then jumps up to meet it.
 */
export const ESTIMATED_HEIGHT = 0.6;

/**
 * The box the web view is laid out in, at a given density.
 *
 * **This is the whole of the blank-editor bug, as a value.** On a phone the
 * note is one page scroller — the inline title, the Properties panel and the
 * durability line scroll with the text — and a `ScrollView`'s content container
 * has no height of its own: it is *defined* by what its children measure to. So
 * a `flex: 1` child of it has no free space to grow into and measures to zero,
 * and the note renders as a collapsed Properties row over a durability line
 * with nothing between them. It worked while the editor was a `TextInput`,
 * because a `TextInput` grows to its own content and does not need the space to
 * already exist.
 *
 * So at compact the web view **states a height**, and the only thing that knows
 * that height is the guest — see the `height` message. Given exactly its
 * document's height, the web view's own scroller has nothing to scroll and the
 * page scroller is the one scroller on the screen, which is what keeps
 * `NoteEditor`'s swipe guard and its content padding both working.
 *
 * `null` means "not sized here" — the pointer layout, where a region bounds the
 * editor and `flex: 1` from the stylesheet is right. Returning that rather than
 * a `{ flex: 1 }` keeps this a decision about *whether* to size, and leaves the
 * flexed case where it already lives.
 *
 * It is a function over numbers rather than a branch inside the component for
 * the reason the rest of this file exists: react-native-webview has no web
 * build, so a suite that renders through react-native-web cannot mount
 * `LiveEditor` without stubbing the one child under test. The deciding is here
 * so it can be pinned honestly; `nativeEditorBox.test.ts` then mounts the
 * component to prove it is this that reaches the view.
 */
export function editorBox(box: {
  compact: boolean;
  /** What the guest last measured, or `null` before its first `height`. */
  height: number | null;
  windowHeight: number;
}): { height: number } | null {
  if (!box.compact) return null;
  if (box.height !== null && Number.isFinite(box.height) && box.height > 0) {
    return { height: box.height };
  }
  return { height: Math.max(1, Math.round(box.windowHeight * ESTIMATED_HEIGHT)) };
}
