/**
 * The address, as a person reads it before agreeing to leave the app.
 *
 * ## Why this string is not the string that opens
 *
 * `webUrl` decides what *may* open, and it is right to allow what it allows:
 * whitespace and C0 are refused, but a bidi override in a path is legal, and
 * the address handed to `Linking` has to be the address that was written. So
 * the target arrives here exactly as somebody typed it into a note — and in a
 * shared workspace that is any editor, writing for a reader who is not them.
 *
 * **The dialog is the whole of the control.** The `open-url` case in
 * `webview/host.ts` allows this one message out of the web view precisely
 * because the person is asked first: *"a script that should not exist cannot
 * post a note's contents to a URL without someone reading that URL and
 * agreeing to it."* A control whose mechanism is **reading** is defeated by an
 * address that renders as something other than itself, which is what one
 * U+202E does to everything drawn after it — including the app's own
 * "Open this link?" beside it.
 *
 * So the address is contained for the question and left alone for the answer.
 * That split is `displayText.cjs`'s own rule applied to a value that is both:
 * contain it where it is read, never where it is used, because a container
 * inside a URL handed to the system would be a different URL.
 *
 * ## Why a module rather than two lines in `LiveEditor.tsx`
 *
 * So the rule can be *checked*. `LiveEditor.tsx` pulls in React Native and the
 * web view; this function is the part with a property, and it is the part
 * `displayContainment.test.ts` enumerates beside every other boundary that
 * draws a string Context did not choose.
 */

import { isolateForDisplay } from "@context/shared/src/displayText.cjs";

/** The address, contained, so nothing in it can reach the question around it. */
export function linkPromptMessage(url: string): string {
  return isolateForDisplay(url);
}
