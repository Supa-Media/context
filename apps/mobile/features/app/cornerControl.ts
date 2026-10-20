/**
 * Where the console's `+` is, for the one other control that floats beside it.
 *
 * ## Why a measurement and not two matching offsets
 *
 * The `+` and the dictation dock both say `right: 24` and stack from the same
 * `floatingStackBottom`, and they still did not line up: the `+` is mounted by
 * the layout in the frame's editor region, the dock by `NoteEditor` inside a
 * padded pane within it, so "24 from the right" meant two different edges. A
 * failure card lifted above the `+` by arithmetic sat 16pt in from its right
 * edge and 16pt higher than the gap it claimed. Matching the numbers again
 * would hold until the next layout changed the pane.
 *
 * So the `+` registers how to measure itself, and the dock asks at the moment
 * it needs an answer: when a card appears beside it. A measuring function
 * rather than a stored rectangle, because the `+` does not change size when
 * the window does — `onLayout` would not fire — and a remembered position is a
 * stale one (`CreateButton`'s menu anchor makes the same argument).
 */

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Measure = (answer: (rect: WindowRect) => void) => void;

let measure: Measure | null = null;

/** The `+` mounting. Returns the unregister, for its effect's cleanup. */
export function registerCornerControl(next: Measure): () => void {
  measure = next;
  return () => {
    if (measure === next) measure = null;
  };
}

/**
 * Ask where the `+` is, in window coordinates. Never answers when nothing is
 * registered, or when the host never answers (jsdom); callers keep their own
 * arithmetic for that case.
 */
export function measureCornerControl(answer: (rect: WindowRect) => void): void {
  measure?.(answer);
}
