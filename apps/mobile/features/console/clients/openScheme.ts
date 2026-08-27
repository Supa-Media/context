/**
 * Which of a provider's links can be handed to `window.open`, and which cannot.
 *
 * Split out from the two `open` halves so the rule is one testable function
 * rather than a condition written twice and allowed to disagree.
 */

/**
 * True for a link that leaves the browser entirely — `cursor://`, `vscode://`.
 *
 * These must be navigated to in place, not opened in a tab. `window.open` on a
 * custom scheme leaves a blank tab behind after the handler fires, and in a few
 * browsers the popup blocker eats it outright, which reads as a dead button.
 * Assigning `location` instead hands the URL to the OS handler and leaves the
 * console exactly where it was.
 */
export function isAppScheme(href: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (scheme === undefined) return false;
  return scheme !== "http" && scheme !== "https";
}

/**
 * Refuse anything that is not a URL we would have built.
 *
 * Nothing in this app takes a provider link from user input today — the
 * catalogue is a constant — so this is a guard against a future caller rather
 * than against a live attack. `javascript:` is the one that matters: it is a
 * scheme, so `isAppScheme` says yes to it, and `location.assign` would run it.
 */
export function isSafeProviderLink(href: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (scheme === undefined) return false;
  return scheme !== "javascript" && scheme !== "data" && scheme !== "file" && scheme !== "blob";
}
