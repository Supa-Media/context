import type { Scope } from "../design/keymap";

/**
 * Which region a keystroke belongs to.
 *
 * `keymap.ts` decides what a chord *means* inside a scope, and enforces the
 * rules that make a keyboard layer usable — a bare key does nothing in a text
 * field, nothing behind an overlay fires. What it cannot know is which scope
 * the caret is actually in, because that is a fact about the screen.
 *
 * ## Why this is a function of focus, and not of a React state
 *
 * The obvious design is a `focusedRegion` state that each region sets on focus,
 * read by the listener as a prop. It does not work: focus moves before React
 * hears about it, so a key pressed in the same tick as a click resolves against
 * the *previous* region — and every focus change would re-render the whole
 * console to keep the prop current. Asking the document at the moment the key
 * arrives is both cheaper and the only answer that cannot be stale.
 *
 * ## The regions
 *
 *  - **`overlay`** — the palette or a menu is open. Nothing behind it may fire;
 *    this is checked first and beats everything, including the editor.
 *  - **`editor`** — the caret is in the note. ⌘S saves, ⌘E toggles the preview.
 *  - **`tree`** — focus is inside the explorer. F2 renames, ⌘⌫ archives, the
 *    arrows walk the rows.
 *  - **`global`** — anywhere else. Only the frame-level chords.
 *
 * The order is not arbitrary and each swap is a bug: overlay after editor lets
 * ⌘S fire while a delete confirmation is open; tree before editor means typing
 * in a note that happens to sit inside a focused region runs file commands.
 */
export interface FocusFacts {
  /** The palette, a menu, or a dialog is on screen. */
  overlayOpen: boolean;
  /** Focus is inside the explorer region. */
  inTree: boolean;
  /** Focus is in the note's text area. */
  inEditor: boolean;
}

export function scopeForFocus(facts: FocusFacts): Scope {
  if (facts.overlayOpen) return "overlay";
  if (facts.inEditor) return "editor";
  if (facts.inTree) return "tree";
  return "global";
}

/**
 * `testID` on a React Native view becomes `data-testid` in the DOM, which makes
 * it the one stable hook a focus check can use — react-native-web generates
 * class names and renders everything as a `div`, so there is nothing else to
 * match on that survives a style change.
 *
 * Naming them here rather than inline keeps the two ends of that contract in
 * one place: if a region's `testID` is renamed, this file is what fails to find
 * it, and the tests below say so.
 */
export const TREE_REGION_TEST_ID = "explorer-tree";

/**
 * Read the facts off a live document.
 *
 * Web-only by nature and deliberately tiny — everything worth testing is in
 * `scopeForFocus`, and this is the part that cannot be tested without a DOM.
 * It is defensive because it runs on every keystroke: a detached or exotic
 * `activeElement` must degrade to `global`, never throw.
 */
export function readFocus(overlayOpen: boolean): FocusFacts {
  if (typeof document === "undefined") return { overlayOpen, inTree: false, inEditor: false };

  const active = document.activeElement as HTMLElement | null;
  if (active === null) return { overlayOpen, inTree: false, inEditor: false };

  const tag = active.tagName?.toLowerCase();
  const inEditor = tag === "textarea";
  const inTree =
    typeof active.closest === "function" &&
    active.closest(`[data-testid="${TREE_REGION_TEST_ID}"]`) !== null;

  return { overlayOpen, inTree, inEditor };
}
