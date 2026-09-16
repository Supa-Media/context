/**
 * "Open the context menu", from the keyboard.
 *
 * A context menu reachable only by mouse makes every verb it holds mouse-only,
 * and several of this one's have no chord at all — "Copy @path", "Share…", the
 * whole Visibility submenu. `keymap.ts` binds the console's *commands*; this is
 * not one of them. It is the platform's own gesture for "the menu for the thing
 * I am on", it is answered by whichever element has focus rather than by a
 * global scope, and binding it centrally would mean the keymap deciding which
 * row a menu is about — which is exactly what focus already knows.
 *
 * Two spellings, because keyboards disagree: `Shift+F10` works everywhere, and
 * a PC keyboard usually has a dedicated Menu key beside the right Ctrl. A bare
 * `F10` is **not** it — that is the browser's own menu-bar focus on Windows,
 * and swallowing it would be this app taking a key it was not offered.
 */
export function isMenuKey(event: {
  key: string;
  shiftKey: boolean;
}): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

/**
 * Where a keyboard-opened menu goes: the bottom-left of the row itself.
 *
 * **Not the last pointer position**, which is the obvious shortcut and is
 * wrong twice over: the mouse may be resting over a completely different row,
 * and somebody driving this from the keyboard may not have moved it at all —
 * so the menu would open at whatever corner the page was loaded with, about a
 * row nobody is looking at.
 *
 * Under rather than over, so the menu does not cover the row it is about.
 * `Menu.web.tsx` flips it above when there is no room below, which is the same
 * decision it makes for a pointer.
 */
export function anchorUnder(element: {
  getBoundingClientRect: () => { left: number; bottom: number };
}): { x: number; y: number } {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.bottom };
}
