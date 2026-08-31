/**
 * The wire between the native `LiveEditor` and the CodeMirror instance running
 * inside its `WebView`.
 *
 * This module is the *only* thing both halves import. It has no dependencies —
 * not React, not React Native, not CodeMirror — because one half of it is
 * compiled by Metro for Hermes and the other is compiled by esbuild for
 * WKWebView, and anything either bundler cannot see through would have to be
 * written twice.
 *
 * ## Why the message set is this small
 *
 * The editor's contract with the rest of the app is `LiveEditorProps`: text in,
 * text out, an `editable` flag and a save. Nothing above `LiveEditor` reads a
 * selection, an undo depth or a scroll position, so none of those cross. A
 * selection *is* preserved — that is what `echoes` below exists for — but it is
 * preserved by never being written over, not by being marshalled back and
 * forth. A protocol carrying state nobody consumes is state that can go wrong.
 *
 * ## Why everything is JSON over `postMessage`, and nothing is injected
 *
 * `WebView.injectJavaScript` would be the shorter route and it evaluates a
 * string as source in the page. The string would have to contain the note —
 * somebody's private markdown — escaped correctly for a JavaScript literal, on
 * every keystroke, forever. `ref.postMessage(json)` hands the same bytes across
 * as *data*, so there is no escaping to get wrong and no path by which note
 * content becomes note code.
 *
 * ## Versioned, because the two halves ship apart
 *
 * The guest bundle is generated and committed (`bundle.generated.ts`); the host
 * is ordinary app source. A stale bundle paired with a new host is a real
 * state, so every message carries `v` and the receivers drop anything they do
 * not recognise rather than acting on a half-understood message.
 */

export const PROTOCOL_VERSION = 1;

/** Host → guest. */
export type ToGuest =
  /**
   * Authoritative text. Sent when a different note is opened, a draft is
   * discarded, or a conflict is resolved — never as an echo of typing, which is
   * what would reset the selection. See `echoes`.
   */
  | { v: number; type: "doc"; text: string }
  /** `false` for `privacy.md`, and for a member who may read but not write. */
  | { v: number; type: "editable"; editable: boolean }
  /**
   * The palette, as CSS custom-property values. Sent on mount and whenever the
   * appearance changes — never by reloading the document, because a reload
   * would cost the caret and the undo history.
   */
  | { v: number; type: "theme"; vars: Readonly<Record<string, string>> }
  /**
   * How much of the editor is covered by something else — the iOS keyboard, an
   * accessory bar. The guest pads its scroller by this so the caret can always
   * be scrolled clear of it.
   */
  | { v: number; type: "inset"; bottom: number };

/** Guest → host. */
export type ToHost =
  /** The editor is mounted and listening. Nothing is sent to it before this. */
  | { v: number; type: "ready" }
  /** The document changed because a person changed it. */
  | { v: number; type: "change"; text: string }
  /** `Mod-s`, which only a hardware keyboard can produce on iOS. */
  | { v: number; type: "save" }
  /** Focus, so the host can tell the keyboard layer the note is being typed into. */
  | { v: number; type: "focus"; focused: boolean }
  /** The guest failed to start. Surfaced rather than left as a blank rectangle. */
  | { v: number; type: "failed"; message: string };

export function encode(message: ToGuest | ToHost): string {
  return JSON.stringify(message);
}

/**
 * Read a message off the wire.
 *
 * Returns `null` for anything that is not a message of the version this build
 * speaks. That covers a stale guest bundle, but it also covers the thing worth
 * being careful about: `onMessage` fires for **any** `postMessage` from the web
 * view, and the web view is rendering somebody's markdown. A note containing a
 * script cannot run one — the document sets no `<script>` beyond the bundle and
 * the guest never evaluates note text — but the host still refuses to act on a
 * shape it did not define, rather than trusting that.
 */
export function decode<T extends ToGuest | ToHost>(
  raw: string,
  types: ReadonlySet<T["type"]>,
): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as { v?: unknown; type?: unknown };
  if (message.v !== PROTOCOL_VERSION) return null;
  if (typeof message.type !== "string") return null;
  if (!types.has(message.type as T["type"])) return null;
  return parsed as T;
}

export const TO_GUEST_TYPES: ReadonlySet<ToGuest["type"]> = new Set([
  "doc",
  "editable",
  "theme",
  "inset",
] as const);

export const TO_HOST_TYPES: ReadonlySet<ToHost["type"]> = new Set([
  "ready",
  "change",
  "save",
  "focus",
  "failed",
] as const);

/**
 * Is this incoming `value` the echo of what the editor already holds?
 *
 * The single guard the whole bridge turns on, and the same one
 * `LiveEditor.web.tsx` documents at length: typing goes out through `onChange`,
 * the reducer re-renders with that same text, and if that round trip is written
 * back into the editor the document is replaced and the selection resets. On
 * screen that is the caret jumping to the end of the note on every keystroke.
 *
 * A function rather than an inline `!==` so it can be named, tested, and
 * pointed at from both halves.
 */
export function echoes(incoming: string, known: string): boolean {
  return incoming === known;
}

/**
 * Whether a `change` from the guest may be acted on.
 *
 * The guest already refuses to change a read-only document — `EditorState.readOnly`
 * is set, which is the facet that actually stops programmatic edits — but the
 * host refuses again, and the repetition is deliberate. The guest is a separate
 * bundle running separate code in a separate process; "the other side checked"
 * is exactly the assumption that made `EditorView.editable.of(false)` look
 * sufficient for a year. If a `change` ever arrives for a note this viewer may
 * not write, the answer is to drop it, not to reason about how it got here.
 */
export function acceptsChange(editable: boolean): boolean {
  return editable;
}
