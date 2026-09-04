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
 * text out, an `editable` flag, a save, the caret taken and let go, and the
 * handful of commands a *button* can run. Nothing above `LiveEditor` reads a
 * selection, an undo depth or a scroll position, so none of those cross. A
 * selection *is* preserved — that is what `echoes` below exists for — but it is
 * preserved by never being written over, not by being marshalled back and
 * forth. A protocol carrying state nobody consumes is state that can go wrong.
 *
 * ## Why a command crosses as a name and not as text
 *
 * `NoteAccessory` presses Bold. The obvious implementation is string surgery on
 * the host — slice the note, insert two asterisks, send the result back as a
 * `doc` — and it is wrong twice over. The host does not have the selection (see
 * above, and it must not, or the caret starts jumping), and a `doc` message is
 * *authoritative text*, which is the one write a read-only note still accepts.
 * A bar built that way would edit `privacy.md`.
 *
 * So a command crosses as `{ name: "wrap", before, after }` and is run **by the
 * guest, against the real editor state**, through the same CodeMirror commands
 * the desktop's keymap runs. The selection stays where it is, the undo history
 * is one history rather than two, and every one of these is an ordinary
 * transaction that `editability`'s `changeFilter` refuses on a note the viewer
 * may not write.
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

/**
 * What a button can ask the editor to do.
 *
 * The same five verbs `EditorControls` declares, as data rather than as
 * methods, because on iOS they have to survive a JSON round trip. The web half
 * never encodes one — it holds the `EditorView` — but it runs the *same*
 * `runCommand` against it, so a command is defined once and behaves once.
 *
 * **Deliberately five verbs and not a command registry.** Everything here is
 * something the accessory bar actually does; a sixth added speculatively is a
 * verb one of the two surfaces will get wrong quietly, because only one of them
 * is exercised by any given run.
 */
export type EditorCommand =
  /** Wrap the selection, or insert the pair at the caret with it between them. */
  | { name: "wrap"; before: string; after: string }
  /** Put `prefix` at the start of the caret's line, or take it off again. */
  | { name: "toggleLinePrefix"; prefix: string }
  | { name: "undo" }
  | { name: "redo" }
  /**
   * Let go of the editing surface.
   *
   * The only one of the five that does not touch the document, which is why
   * `writesDocument` exists rather than a flat "commands need `editable`": the
   * dismiss key has to work on a note somebody is only reading, and it is the
   * one control on the bar that must never be the one that is refused.
   */
  | { name: "blur" };

/**
 * Read a command off the wire.
 *
 * `decode` proves a message is one of ours and says nothing about its payload,
 * and this payload is the one that becomes an *edit*. A `wrap` whose `before`
 * arrived as an object would be inserted into somebody's note as
 * `[object Object]`, so the shape is checked here rather than assumed — same
 * rule as `decode` itself, one level in.
 */
export function decodeCommand(value: unknown): EditorCommand | null {
  if (typeof value !== "object" || value === null) return null;
  const command = value as { name?: unknown; before?: unknown; after?: unknown; prefix?: unknown };
  switch (command.name) {
    case "wrap":
      if (typeof command.before !== "string" || typeof command.after !== "string") return null;
      return { name: "wrap", before: command.before, after: command.after };
    case "toggleLinePrefix":
      if (typeof command.prefix !== "string") return null;
      return { name: "toggleLinePrefix", prefix: command.prefix };
    case "undo":
      return { name: "undo" };
    case "redo":
      return { name: "redo" };
    case "blur":
      return { name: "blur" };
    default:
      return null;
  }
}

/** Would running this change the document? */
export function writesDocument(command: EditorCommand): boolean {
  return command.name !== "blur";
}

/**
 * May this command run for a viewer with this clearance?
 *
 * **Every key on the accessory bar except the last is a programmatic edit**,
 * and `EditorView.editable.of(false)` does not stop one — the whole point of
 * `editability`'s third facet. So a command is refused for the same reason and
 * in the same three places a `change` is: here on the host before it is sent,
 * here in the guest before it is run, and finally by the `changeFilter` inside
 * the transaction itself. The repetition is the design; see `acceptsChange`.
 */
export function acceptsCommand(editable: boolean, command: EditorCommand): boolean {
  return editable || !writesDocument(command);
}

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
   * be scrolled clear of it, and hands the same number to CodeMirror as a
   * scroll margin so "scroll the caret into view" means *above* the keyboard
   * rather than anywhere inside the web view's rectangle.
   */
  | { v: number; type: "inset"; bottom: number }
  /**
   * Which note is open, and which note paths the console happens to know.
   *
   * The guest needs the first to resolve a relative link — `[[../beta/notes]]`
   * means nothing without knowing where it was written — and the second only
   * for a bare `[[name]]`. Sent with the document rather than derived from it,
   * because a note's own path is not in its bytes.
   *
   * `paths` is capped by the host (`LINK_PATHS_CAP`) rather than sent whole: it
   * is a nice-to-have for one link style, and a bucket's entire key list across
   * a `postMessage` on every note open is not a trade worth making for it.
   */
  | { v: number; type: "links"; path: string | null; paths?: readonly string[] }
  /**
   * A key on the accessory bar was pressed. Run it against the real editor.
   *
   * `command` is typed rather than `unknown` because this is the host's own
   * message and the host builds it — but the guest still runs it through
   * `decodeCommand`, because the guest is a separate bundle that can be paired
   * with a host it does not know.
   */
  | { v: number; type: "command"; command: EditorCommand };

/** Guest → host. */
export type ToHost =
  /** The editor is mounted and listening. Nothing is sent to it before this. */
  | { v: number; type: "ready" }
  /** The document changed because a person changed it. */
  | { v: number; type: "change"; text: string }
  /** `Mod-s`, which only a hardware keyboard can produce on iOS. */
  | { v: number; type: "save" }
  /**
   * A link to another note was followed with the modifier held. Navigate.
   */
  | { v: number; type: "open-link"; path: string }
  /**
   * A link to another note was long-pressed. **Ask, do not navigate.**
   *
   * A press is an ambiguous gesture — it is also how somebody starts a
   * selection — and acting on one by replacing the note being edited is the
   * worst available reading of it. The host puts a confirmation in front of the
   * person; see `noteLinks.ts`.
   */
  | { v: number; type: "press-link"; path: string }
  /** Focus, so the host can tell the keyboard layer the note is being typed into. */
  | { v: number; type: "focus"; focused: boolean }
  /**
   * How tall the document laid out, in CSS pixels, including the scroller's own
   * padding.
   *
   * **This is what stops the editor measuring to nothing on a phone.** At
   * compact the note is one page scroller — the inline title, the Properties
   * panel and the durability line scroll with the text — and a `flex: 1` child
   * of a scroll view's content container has no free space to grow into, so it
   * measures to zero height. That is not a styling slip that a `flexGrow` on
   * the content container would fix: a scroller's content is *defined* by its
   * children's own heights, so the editor has to state one.
   *
   * A web view cannot be measured from the outside — react-native-webview has
   * no content-size callback, and the host cannot know how markdown wrapped —
   * so the only thing that knows this number is the guest, and it says so.
   * `LiveEditor` gives its host view exactly this height, which leaves
   * CodeMirror's own scroller with nothing to scroll and the note with exactly
   * one scroller, which is the whole point.
   */
  | { v: number; type: "height"; height: number }
  /**
   * Where the caret is, in CSS pixels from the top of the editor.
   *
   * The other half of "the editor is as tall as its document". CodeMirror keeps
   * the caret off the keyboard by scrolling its own scroller — see
   * `coveredBottom` — and a scroller with nothing to scroll cannot. Worse, its
   * idea of "visible" is that scroller's client rectangle, which at this
   * density is the whole note, so it is satisfied by a caret anywhere in a
   * document that runs several screens past the bottom of the glass.
   *
   * So the guest reports where the caret is and the surface the editor is laid
   * out *inside* does the scrolling. Sent on focus, on a selection change and
   * on an edit — coalesced to one message a frame, like every other.
   */
  | { v: number; type: "caret"; top: number; bottom: number }
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
  "command",
  "links",
] as const);

export const TO_HOST_TYPES: ReadonlySet<ToHost["type"]> = new Set([
  "ready",
  "change",
  "save",
  "focus",
  "height",
  "caret",
  "failed",
  "open-link",
  "press-link",
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
