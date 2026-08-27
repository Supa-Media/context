/**
 * Which of a provider's links can be handed to `window.open`, and which cannot.
 *
 * Split out from the two `open` halves so the rule is one testable function
 * rather than a condition written twice and allowed to disagree.
 *
 * Whether a link is *safe* to follow at all is deliberately not decided here:
 * that is `isSafeRedirect` in `features/consent/redirectSafety.ts`, and this
 * module having its own copy was the mistake. Two spellings of "is this URL
 * dangerous" is one spelling too many, and the copy that lived here was already
 * the weaker of the two — no `vbscript:`, no `about:`, and no parse.
 */

/**
 * True for a link that leaves the browser entirely — `cursor://`, `vscode:`.
 *
 * These must be navigated to in place, not opened in a tab. `window.open` on a
 * custom scheme leaves a blank tab behind after the handler fires, and in a few
 * browsers the popup blocker eats it outright, which reads as a dead button.
 * Assigning `location` instead hands the URL to the OS handler and leaves the
 * console exactly where it was.
 *
 * Says nothing about safety — `javascript:` is an app scheme by this test, and
 * is refused before either opener reaches it.
 */
export function isAppScheme(href: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (scheme === undefined) return false;
  return scheme !== "http" && scheme !== "https";
}
