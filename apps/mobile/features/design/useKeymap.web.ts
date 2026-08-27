import { useEffect, useRef } from "react";

import { resolve, type Command, type Scope } from "./keymap";

/**
 * The keyboard binder — web.
 *
 * `keymap.ts` decides what a chord means; this attaches the one `keydown`
 * listener that feeds it and turns the answer into a call. Everything here is
 * the part that needs a real DOM event, and it is the part where a keyboard
 * layer actually goes wrong:
 *
 *  - `inTextField` is read off `event.target`, never inferred from focus state
 *    the app happens to be tracking. That single line is what stops `F2` inside
 *    a textarea from renaming the note somebody is writing.
 *  - An IME composition is not a keystroke. See below.
 *  - A held key is one intent for a destructive command, and many for a
 *    navigational one.
 *  - `preventDefault` is the caller's decision, not ours.
 *
 * The listener is on `document` rather than on a container, because the
 * commands here are global affordances — ⌘K has to work with focus on the body,
 * on a row, or nowhere. `scope` is what narrows that back down, and it is the
 * caller's to set.
 */

export interface KeymapOptions {
  scope: Scope;
  /** Fired when a chord resolves. Return true if handled (suppresses default). */
  onCommand: (command: Command) => boolean | void;
  enabled?: boolean;
}

/**
 * `navigator.userAgentData.platform` on Chromium, `navigator.platform`
 * everywhere else. The values are not the same vocabulary — the modern API says
 * `"macOS"`, the deprecated one says `"MacIntel"` — so both spellings are
 * listed rather than normalized.
 */
const APPLE_PLATFORMS: ReadonlySet<string> = new Set([
  "macOS",
  "MacIntel",
  "iPhone",
  "iPad",
  "iPod",
]);

interface UserAgentData {
  platform?: unknown;
}

/**
 * Which modifier `mod` means here.
 *
 * Every access is guarded, and the whole thing is wrapped: `userAgentData` does
 * not exist in Safari or Firefox, `navigator.platform` is deprecated (and empty
 * in a few embedded webviews), and a hostile or unusual embedder can make
 * either one throw. This runs on the first keystroke of the session, so a throw
 * would not be a wrong shortcut — it would be an uncaught error out of a
 * listener on `document`, on every key the person presses. Unknown degrades to
 * "not Apple", which is the Ctrl-shaped majority of the web.
 */
function detectApple(): boolean {
  if (typeof navigator === "undefined") return false;
  try {
    const modern = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
    const reported = modern?.platform;
    // An empty string is "no answer", not an answer, so fall through to the
    // deprecated property rather than concluding non-Apple from it.
    if (typeof reported === "string" && reported !== "") return APPLE_PLATFORMS.has(reported);
    const legacy = navigator.platform;
    return typeof legacy === "string" && APPLE_PLATFORMS.has(legacy);
  } catch {
    return false;
  }
}

/**
 * Commands a held key must not run twice.
 *
 * Auto-repeat is a real keystroke stream — the browser sends one `keydown` per
 * repeat with `event.repeat` true — and most of this table wants that: holding
 * Down walks a list, which is the whole reason arrows are bound. What must not
 * repeat is anything a person cannot casually take back. Both entries here are
 * one modifier apart from each other by design (see `keymap.ts`), and a
 * fumbled key held a beat too long must not turn one archive into six or one
 * permanent delete into a swept folder.
 *
 * This is an explicit list rather than a rule inferred from the command name,
 * so adding a destructive command is a decision somebody makes on purpose.
 */
const NON_REPEATABLE: ReadonlySet<Command> = new Set<Command>(["archive", "deleteForever"]);

/**
 * Whether the keystroke landed in something the person is typing into.
 *
 * Read from the event's own target, because that is the only source that is
 * true at the moment the key was pressed. Anything else — a focus flag in
 * state, a "the editor is open" boolean — is a guess that is wrong exactly when
 * it matters, and being wrong here means a keystroke meant for prose runs a
 * command on the file the prose is in.
 */
function isTextField(target: EventTarget | null): boolean {
  if (target === null) return false;
  const node = target as { tagName?: unknown; isContentEditable?: unknown };
  if (node.isContentEditable === true) return true;
  if (typeof node.tagName !== "string") return false;
  const tag = node.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

export function useKeymap(options: KeymapOptions): void {
  const { scope, onCommand, enabled = true } = options;

  /**
   * The handler goes through a ref so the listener does not depend on it.
   * Callers pass an inline arrow — `onCommand={(c) => run(c)}` is the natural
   * thing to write — which is a new function identity on every render. In the
   * dependency array that would tear the listener off `document` and put a new
   * one back after every keystroke the app re-renders on, which is most of
   * them. The ref keeps one registration for the life of the scope while still
   * calling the newest handler.
   */
  const handlerRef = useRef(onCommand);
  handlerRef.current = onCommand;

  useEffect(() => {
    if (!enabled) return;
    if (typeof document === "undefined") return;

    // Once per registration, not once per keystroke: the platform cannot change
    // under a mounted listener, and a module-level cache would be a global that
    // no test could reset and no page could recover from.
    const apple = detectApple();

    const onKeyDown = (event: KeyboardEvent) => {
      /**
       * An IME composition is not a command. While composing, Enter commits the
       * candidate and Escape cancels it, and both arrive here as ordinary
       * keydowns; firing on them makes the app unusable in Japanese, Chinese
       * and Korean while looking perfect to anyone typing Latin. `isComposing`
       * is the modern signal and `keyCode === 229` the legacy sentinel that
       * older WebKit and Chromium send *instead* of it, so both are checked.
       */
      if (event.isComposing || event.keyCode === 229) return;

      const command = resolve(
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          inTextField: isTextField(event.target),
        },
        scope,
        apple,
      );
      if (command === null) return;

      // Resolution happens first, so the rule is about the command and not
      // about the chord: a held key is still allowed to move a selection.
      if (event.repeat && NON_REPEATABLE.has(command)) return;

      // Only the caller knows whether anything happened. Swallowing ⌘S when
      // nothing saved takes the browser's own Save away and gives nothing back.
      if (handlerRef.current(command) === true) event.preventDefault();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [scope, enabled]);
}
