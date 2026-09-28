/**
 * Whether the focus that just happened came from the keyboard.
 *
 * The browser answers this with `:focus-visible`, which RN-Web does not surface
 * to JS, so `FocusRing` used to draw on every focus, and a mouse press on a row
 * left a teal ring around it (Dev2, 2026-09-28). This keeps the same heuristic
 * the browser does: the last input decides. A key pressed means keyboard; a
 * pointer pressed means not. Listeners are on the capture phase of the
 * document, so they see the input before the focus it causes.
 *
 * With no input seen yet it answers yes, as `:focus-visible` does for focus a
 * page moves on its own. Off the web there is no pointer to exclude, and the
 * answer is always yes.
 */

let keyboard = true;
let listening = false;

function listen(): void {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("keydown", () => (keyboard = true), true);
  document.addEventListener("mousedown", () => (keyboard = false), true);
  document.addEventListener("pointerdown", () => (keyboard = false), true);
  document.addEventListener("touchstart", () => (keyboard = false), true);
}

listen();

export function focusFromKeyboard(): boolean {
  listen();
  return keyboard;
}
