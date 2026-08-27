import { useEffect } from "react";

import type { Command, Scope } from "./keymap";

/**
 * The keyboard binder — native.
 *
 * There is no keyboard here, and there is deliberately no fallback: every
 * command in `keymap.ts` is also reachable by touch (the long-press action
 * sheet on a tree row, the editor's bottom toolbar), which is the rule that
 * file's doc comment sets out. So the native half of this split does nothing at
 * all, and — just as importantly — imports nothing that touches the DOM. The
 * binding table itself is inert off the web; this is what keeps the listener
 * that reads it off the phone too.
 *
 * ## Why this is a hook and not an empty function
 *
 * `export function useKeymap() {}` would be smaller and would work today. It
 * would also make the hook count differ between the two platforms, and that is
 * a difference that bites later rather than now: a component that calls this
 * inside a condition, or above an early `return`, is legal on native and a
 * "rendered fewer hooks than expected" crash on web. Calling a real hook here
 * means the platforms agree about hook order, so React enforces the same rule
 * on both and a mistake shows up in the first place it is made.
 */
export interface KeymapOptions {
  /**
   * Which scope the keystroke lands in.
   *
   * A function rather than only a value, because scope is a property of *where
   * the caret is at the moment a key is pressed*, not of the last render. The
   * tree and the editor are two regions of one screen with one listener between
   * them, and re-rendering the whole console on every focus change to keep a
   * `scope` prop current would be both wasteful and racy — focus moves before
   * React hears about it. Passing a thunk lets the binder ask at the only
   * moment the answer is knowable.
   */
  scope: Scope | (() => Scope);
  /** Fired when a chord resolves. Return true if handled (suppresses default). */
  onCommand: (command: Command) => boolean | void;
  enabled?: boolean;
}

export function useKeymap(_options: KeymapOptions): void {
  // Intentionally empty: see above. The hook call is the point.
  useEffect(() => {}, []);
}
