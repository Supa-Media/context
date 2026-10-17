import { Keyboard, Platform } from "react-native";

/**
 * Whether a change on screen is the person's own hand (owner, 2026-10-17:
 * Recent tracks "what I physically did, not like one of my agents").
 *
 * Recent is written by the app, so an AI connection never reaches it. What
 * did reach it was everything that *changes the note on screen*: an agent's
 * edit merged into a note the person has open moves the draft exactly the way
 * typing does, and the collaboration room hands it to the editor as a draft.
 * So "the draft changed" is not evidence of typing. These are.
 *
 *  - **On the web**, a trusted keystroke, paste or drop in the last few
 *    seconds. A synthetic event (`isTrusted` false) is a script, never a person.
 *  - **On a phone**, the keyboard being up. The editor there is a web view the
 *    app cannot see keys in, and nobody types into a note with the keyboard
 *    down; an edit arriving while somebody only reads is not theirs.
 *
 * And a browser the page can tell is driven by automation (`navigator.webdriver`,
 * set by Playwright, Puppeteer and WebDriver) records nothing at all. An AI that
 * moves the person's own mouse and keyboard looks exactly like them; that gap is
 * said out loud in the design rather than guessed at.
 */

/** How long after a keystroke a change on screen still counts as typed. */
export const TYPED_WITHIN_MS = 5_000;

const INPUT_EVENTS = ["keydown", "beforeinput", "paste", "drop"] as const;

let lastInputAt = 0;
let listening = false;

function listen(): void {
  if (listening || typeof document === "undefined") return;
  listening = true;
  const stamp = (event: Event) => {
    if (event.isTrusted) lastInputAt = Date.now();
  };
  for (const type of INPUT_EVENTS) document.addEventListener(type, stamp, { capture: true, passive: true });
}

/** Start noticing keystrokes. Safe to call on every render; it listens once. */
export function watchPersonInput(): void {
  if (Platform.OS === "web") listen();
}

/** Whether the change seen now came from this person typing. */
export function personIsTyping(now: number = Date.now()): boolean {
  if (Platform.OS !== "web") return Keyboard.isVisible();
  return lastInputAt > 0 && now - lastInputAt < TYPED_WITHIN_MS;
}

/** Whether this page is run by automation it can detect. */
export function drivenByAutomation(): boolean {
  return Platform.OS === "web" && typeof navigator !== "undefined" && navigator.webdriver === true;
}

/** For tests: forget the last keystroke. */
export function resetPersonInput(): void {
  lastInputAt = 0;
}
