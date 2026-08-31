/**
 * The Live Preview editor's native half: a plain markdown textarea.
 *
 * CodeMirror is a DOM library. There is no React Native build of it, and the
 * two ways of pretending otherwise are both worse than this file:
 *
 *  - A **WebView** would put the note's text — and an auth-bearing surface —
 *    inside a second rendering context with its own keyboard handling, its own
 *    scroll physics, and a bridge to marshal every keystroke across. On a
 *    document editor that is a worse experience than a native text input, not a
 *    better one.
 *  - **Reimplementing the decorations against `TextInput`** is not possible in
 *    the way that matters: React Native's `TextInput` cannot hide a range of
 *    its own value while keeping it in the buffer, which is the entire
 *    behaviour.
 *
 * So the native app keeps the editor it already had, and the console — which is
 * a web surface, on a laptop, where this editing actually happens — gets Live
 * Preview. That gap is deliberate and is the "document deliberate gaps" the
 * handoff asked for rather than an omission to be fixed later.
 *
 * The props are identical to the web component's on purpose: `NoteEditor` does
 * not branch on platform, Metro picks the file, and neither half can drift from
 * the other's contract without failing typecheck.
 *
 * ## A phone reads the note; it does not inspect it
 *
 * On a pointer layout this is the mockup's `.note pre`: 12.5px mono in a
 * bordered well. That is a *source view*, and it is the right one beside a file
 * tree, a tab strip and a keyboard.
 *
 * It is the wrong one on a phone, where the note is the entire screen and the
 * person holding it is reading. 12.5px mono at arm's length is unreadable, the
 * border draws a box around the only thing on the glass, and a monospaced
 * measure wraps a sentence about every six words — which is the effect visible
 * in the before/after in the pull request. So at `compact` the same buffer is
 * drawn at reading size in the body face, unboxed, on the ground it already
 * sits on.
 *
 * **The buffer is untouched.** This is a type scale, not a renderer: what is on
 * screen is still exactly the markdown in the file, which is the property
 * `NoteEditor` exists to protect and the reason this app has no WYSIWYG.
 *
 * ## Two notes for whoever replaces this with a WebView
 *
 * There is work in flight to run CodeMirror inside `react-native-webview` here,
 * which would make native and web one editor. Two things about the keyboard
 * change with it, and both are easy to miss:
 *
 *  - **`hideKeyboardAccessoryView` must be set to `true` on the `WebView`.**
 *    WebKit draws its own accessory bar with a *Done* key, and `NoteAccessory`
 *    now draws ours. Leaving WebKit's on is two stacked bars saying different
 *    things.
 *  - **Drag-to-dismiss goes away with the `TextInput`.** A WebView's outer
 *    scroll view is `scrollEnabled={false}` so CodeMirror's own scroller is the
 *    only one, and `keyboardDismissMode` lives on a `ScrollView`. That makes
 *    `NoteAccessory`'s dismiss key the *only* way out of the keyboard, which
 *    raises its importance rather than lowering it.
 *
 * Neither applies to the file as it stands: there is no `WebView` here yet, and
 * `keyboardDismissMode` is not a `TextInput` prop in the first place — it is
 * declared on `ScrollViewProps` alone and implemented in `RCTScrollView`, so
 * writing it here would fail typecheck and be dropped by the native view even
 * if it did not. This is written down so the flip is made deliberately rather
 * than discovered on a device.
 *
 * ## The undo history here is a stack of whole documents, and that is a gap
 *
 * `EditorControls` promises `undo`/`redo`, and on web those are CodeMirror's
 * own commands over the same history ⌘Z drives. **React Native's `TextInput`
 * exposes no undo API at all** — iOS has a shake-to-undo stack inside UIKit
 * that JavaScript cannot read, enumerate or push onto, and Android has nothing.
 * So this file keeps its own: the previous whole value is pushed on every
 * change that leaves here, and undo emits the top of that stack.
 *
 * Three consequences, stated rather than discovered:
 *
 *  - **It is coarse.** One press steps back one `onChange`, which for typing is
 *    one character. CodeMirror coalesces a burst of keystrokes into one history
 *    event; this does not, and cannot, because it never sees a keystroke — only
 *    the value afterwards.
 *  - **It is bounded** at `HISTORY_DEPTH` entries. A long note is a few hundred
 *    kilobytes of string per entry and an unbounded stack is a memory leak that
 *    grows with how much somebody wrote today.
 *  - **It is dropped whenever the document changes underneath us.** A different
 *    note opened, a draft discarded, a conflict resolved with somebody else's
 *    version: an incoming `value` this component did not produce is a different
 *    document, and undoing across that boundary would paste one note's text
 *    into another. That is the same comparison the web half's `latestValue`
 *    guard makes, for a related reason.
 *
 * ## Dragging the note down does not put the keyboard away here
 *
 * It should — it is the gesture people try first, and the accessory bar exists
 * for when they do not. `keyboardDismissMode="interactive"` is how React Native
 * spells it, and it is a **`ScrollView` prop**: it is not on `TextInputProps`,
 * and iOS's text-input view manager does not implement it, so writing it here
 * would typecheck-fail and then be dropped by the native view. The editable
 * surface on a phone *is* this `TextInput` — there is no scroller around it —
 * so there is nowhere honest to put it without wrapping the input in a
 * `ScrollView` and taking `scrollEnabled={false}`, which costs the caret
 * following the cursor down a long note. Left as a stated gap rather than a
 * prop that looks like the feature and is not; the accessory bar's dismiss key
 * is the working route.
 */

import { useCallback, useEffect, useRef } from "react";
import {
  StyleSheet,
  TextInput,
  useWindowDimensions,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from "react-native";
import { densityFor } from "../../app/frame";
import { fonts, layout, leading, radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { EditorControls, LiveEditorProps } from "./LiveEditor.web";

export type { EditorControls, LiveEditorProps };

/** See the file comment: whole documents, so the stack is short on purpose. */
const HISTORY_DEPTH = 100;

interface Range {
  start: number;
  end: number;
}

/**
 * A selection that is inside the text it is about.
 *
 * `onSelectionChange` reports against the value the input held when the event
 * fired, and a command can run after the parent has replaced that value with a
 * shorter one — a discard, a conflict resolved. Slicing with a stale offset
 * silently drops the tail of somebody's note, so every command clamps first.
 */
function clampRange(range: Range, length: number): Range {
  const start = Math.max(0, Math.min(range.start, length));
  return { start, end: Math.max(start, Math.min(range.end, length)) };
}

/** Where the caret's line begins. `-1 + 1` is 0, which is what a first line wants. */
function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

export function LiveEditor({
  value,
  editable,
  onChange,
  controls,
  onFocus,
  onBlur,
  accessibilityLabel,
}: LiveEditorProps) {
  const styles = useThemedStyles(makeStyles);
  const reading = densityFor(useWindowDimensions().width) === "compact";

  const input = useRef<TextInput | null>(null);
  const selection = useRef<Range>({ start: 0, end: 0 });
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);

  /**
   * The last text this component sent upward.
   *
   * Its only job is to tell our own echo apart from a genuinely new document:
   * the parent re-renders with what we just emitted on every keystroke, and
   * that must not look like the note changing. Exactly the question the web
   * half asks with `latestValue`.
   */
  const emitted = useRef(value);

  /**
   * The props, read at call time. The imperative handle below is built once,
   * so closing over `value` and `onChange` directly would send every command
   * after the first keystroke to a stale reducer with a stale document.
   */
  const live = useRef({ value, onChange });
  live.current = { value, onChange };

  if (value !== emitted.current) {
    // A different document arrived from outside. See the file comment: the
    // history belongs to the note it was recorded against, so it goes with it.
    emitted.current = value;
    past.current = [];
    future.current = [];
  }

  /**
   * The one way text leaves this component — typing and every command alike.
   *
   * Everything goes out through the ordinary `onChange` so that `NoteEditor`'s
   * frontmatter concatenation applies to a command exactly as it applies to a
   * keystroke. A command that wrote by some other route would drop the YAML
   * block of every captured note on a phone.
   */
  const emit = useCallback((next: string) => {
    const { value: current, onChange: send } = live.current;
    if (next === current) return;
    past.current.push(current);
    if (past.current.length > HISTORY_DEPTH) past.current.shift();
    future.current = [];
    emitted.current = next;
    send(next);
  }, []);

  /**
   * Built on the first render and never rebuilt, so the handle handed to
   * `NoteAccessory` stays the same object for the life of the editor.
   *
   * **It does not move the caret.** Every command is string surgery followed by
   * `onChange`, and React Native offers no supported way to place a cursor
   * without making the input controlled — which would fight typing on every
   * keystroke for the sake of two characters. The tracked selection is advanced
   * so a second command lands where the first left off; where the platform puts
   * the visible caret is the platform's business. It is the honest gap, not the
   * intended behaviour, and it is the reason the web half — which can do this
   * properly — is the one whose selection handling is worth reading.
   */
  const api = useRef<EditorControls | null>(null);
  if (api.current === null) {
    api.current = {
      wrap(before, after) {
        const text = live.current.value;
        const { start, end } = clampRange(selection.current, text.length);
        emit(text.slice(0, start) + before + text.slice(start, end) + after + text.slice(end));
        selection.current = { start: start + before.length, end: end + before.length };
      },
      toggleLinePrefix(prefix) {
        const text = live.current.value;
        const { start, end } = clampRange(selection.current, text.length);
        const from = lineStart(text, start);
        const present = text.startsWith(prefix, from);
        emit(
          present
            ? text.slice(0, from) + text.slice(from + prefix.length)
            : text.slice(0, from) + prefix + text.slice(from),
        );
        const shift = present ? -prefix.length : prefix.length;
        selection.current = {
          start: Math.max(from, start + shift),
          end: Math.max(from, end + shift),
        };
      },
      undo() {
        const previous = past.current.pop();
        if (previous === undefined) return;
        future.current.push(live.current.value);
        emitted.current = previous;
        live.current.onChange(previous);
      },
      redo() {
        const next = future.current.pop();
        if (next === undefined) return;
        past.current.push(live.current.value);
        emitted.current = next;
        live.current.onChange(next);
      },
      blur() {
        input.current?.blur();
      },
    };
  }

  /**
   * Hand the handle over, and take it back on unmount.
   *
   * `controls` is read off a ref and the effect runs once, so a parent that
   * passes a fresh arrow on every render — which is the normal way to write it
   * — does not re-hand the same object over and over.
   */
  const handlers = useRef({ controls });
  handlers.current = { controls };
  useEffect(() => {
    handlers.current.controls?.(api.current);
    return () => handlers.current.controls?.(null);
    // Mount and unmount only. `controls` is read off the ref above, so a parent
    // passing a fresh arrow every render — the normal way to write it — does
    // not re-hand the same object over and over, and the teardown still uses
    // the latest callback rather than the first render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <TextInput
      ref={input}
      multiline
      editable={editable}
      value={value}
      onChangeText={emit}
      onSelectionChange={(event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        selection.current = event.nativeEvent.selection;
      }}
      onFocus={onFocus}
      onBlur={onBlur}
      /*
        On a phone this input does not scroll: it grows to the note's height
        inside the one `ScrollView` `NoteEditor` owns, so the inline title and
        the Properties panel above it scroll with the text rather than being
        pinned over a box that scrolls separately. `scrollEnabled={false}` is
        the half of that RN needs told explicitly — a multiline `TextInput`
        scrolls itself otherwise, and two nested scrollers under one thumb is a
        gesture nobody can aim.

        **The cost, stated rather than discovered on a device:** RN does not
        reliably scroll an *outer* `ScrollView` to follow the caret, so typing
        past the bottom of the glass in a long note can put the caret under the
        keyboard. The web half has no such gap (CodeMirror grows in place and
        the browser keeps the caret visible), and the fix here is the WebView
        this file's header already anticipates. It is a real gap and it is
        smaller than the one it replaces, which was the note's own name being
        chrome.
      */
      scrollEnabled={!reading}
      style={[styles.editor, reading && styles.reading]}
      accessibilityLabel={accessibilityLabel}
      spellCheck={false}
      autoCapitalize="none"
      autoCorrect={false}
    />
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  /**
   * `.note pre`, made editable — the same surface the mockup specifies, and the
   * same one this editor had before Live Preview existed on web.
   */
  editor: {
    flex: 1,
    minHeight: 160,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.well,
    color: colors.text2,
    fontFamily: fonts.mono,
    fontSize: 12.5,
    lineHeight: leading(12.5, 1.7),
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  /**
   * See the file comment: the phone reads, it does not inspect.
   *
   * 16 on a 24 line box in `layout.readingMargin` of side padding, measured
   * off Obsidian mobile — and the same three numbers the web half sets in CSS,
   * because a note that reflows differently on the two platforms is two
   * documents. The margin is a token because four other bands have to line up
   * with the first character of this text; see `readingMargin`.
   */
  reading: {
    /*
      `flex: 0` with no `minHeight`: this is a block inside somebody else's
      scroller now and has to be exactly as tall as the note. A `flex: 1` here
      would fill the scroller's content box — which is the note's own height —
      and a `minHeight` would leave a short note with a tail of dead space
      between its last line and the toolbar.
    */
    flex: 0,
    minHeight: undefined,
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 16,
    lineHeight: leading(16, 1.5),
    /*
      No vertical padding. The room the floating chrome takes at each end is
      content padding on the `ScrollView` above — one payment, by the surface
      that scrolls — and the same three numbers the web half sets in CSS, so a
      note does not reflow differently on the two platforms.
    */
    paddingVertical: 0,
    paddingHorizontal: layout.readingMargin,
  },
});
