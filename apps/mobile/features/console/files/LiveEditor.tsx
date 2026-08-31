/**
 * The Live Preview editor's native half: the same CodeMirror, in a `WebView`.
 *
 * This file used to be a plain `TextInput` and used to argue, at length, that
 * it should stay one. Both of that argument's premises have since expired, and
 * it is worth saying which, because the shape of the decision has not changed —
 * only the facts under it.
 *
 *  - It said a WebView would need "a bridge to marshal every keystroke across".
 *    It does, and that turned out to be the easy half: `webview/protocol.ts` is
 *    five message types, the bridge coalesces to one message per frame, and
 *    `webview/host.ts` and `webview/guest.ts` are both testable in plain Jest.
 *  - It said the alternative was reimplementing the decorations against
 *    `TextInput`, which "is not possible in the way that matters" — a
 *    `TextInput` cannot hide a range of its own value while keeping it in the
 *    buffer. That is still true, and it is why this is a WebView rather than a
 *    second editor.
 *
 * What it got right, and what this file now has to keep true, is that the note
 * is somebody's private markdown and the app works offline. So: the bundle is
 * **local** — `bundle.generated.ts`, committed, no network at any point — and
 * the document's own Content-Security-Policy is `default-src 'none'`, which
 * makes that structural rather than a promise. Nothing is bearing auth in
 * there: the guest receives text and a palette and can reach nothing else.
 *
 * ## One editor, two hosts
 *
 * The editor is not written twice. `editorSetup.ts` builds the CodeMirror
 * configuration — the keymap, the read-only facets, the update listener — and
 * `LiveEditor.web.tsx` and `webview/guest.ts` are the two things that mount it.
 * A read-only rule fixed in one is fixed in both, which is the property that
 * made a WebView worth doing rather than a native reimplementation.
 *
 * ## And a fallback that is honest rather than pretty
 *
 * If the guest fails to start — a corrupt bundle, a WKWebView killed under
 * memory pressure — this falls back to the markdown textarea it used to be,
 * with a line saying so. "An absent capability is reported, never faked": the
 * one outcome that is not acceptable is a person who cannot edit their note and
 * is not told why.
 *
 * ## The keyboard, which is the half of this file that is not the editor
 *
 * `NoteAccessory` is a native row of keys riding above the soft keyboard, and
 * it is the only route on a phone to bold, to a heading, to undo — and to
 * putting the keyboard away at all. It talks to this file through
 * `EditorControls`, and there are three consequences for a `WebView` that a
 * `TextInput` did not have:
 *
 *  - **Every command is a bridge message**, not string surgery on the host.
 *    The host does not hold the selection and must not — see `protocol.ts` for
 *    why the caret depends on that — so `wrap` crosses as a *name* and the
 *    guest runs the real CodeMirror command against the real state.
 *  - **Focus crosses too.** A `WebView` has no `onFocus`; the CodeMirror
 *    surface inside it does, and the guest reports it. `LiveEditorProps` is
 *    unchanged, so `NoteEditor` cannot tell which half it has.
 *  - **The caret has to be kept above the keyboard by hand**, because nothing
 *    about a WKWebView shrinks when the keyboard opens. See the inset effect
 *    below and `coveredBottom` in `editorSetup.ts`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, Platform, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { densityFor } from "../../app/frame";
import { Text } from "../../design/components/Text";
import { fonts, leading, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import {
  EDITOR_HTML,
  caretOvershoot,
  coveredHeight,
  createHostBridge,
  editorBox,
  themeVars,
} from "./webview/host";
import { ACCESSORY_HEIGHT, accessoryUp } from "./accessory";
import type { EditorControls, LiveEditorProps } from "./LiveEditor.web";

export type { EditorControls, LiveEditorProps };

/**
 * Module constants, and the reason is not micro-optimisation.
 *
 * react-native-webview reloads whenever `source` is a new object, and a reload
 * is a fresh CodeMirror with no caret, no selection and no undo history. A
 * `source` built in the render body would do that on every keystroke.
 */
const SOURCE = { html: EDITOR_HTML } as const;
const ORIGINS = ["about:*"] as const;

/**
 * Nothing in this document navigates.
 *
 * The live-preview decorations draw a link as a styled `<span>`, not an
 * `<a href>`, so there is no in-page navigation to allow — and a web view
 * holding somebody's private note has no business following a URL that appeared
 * inside it. The initial `about:blank` load is the only thing permitted.
 */
function allowInitialLoadOnly(request: { url: string }): boolean {
  return request.url === "about:blank" || request.url.startsWith("about:");
}

export function LiveEditor({
  value,
  editable,
  onChange,
  onSave,
  controls,
  onFocus,
  onBlur,
  onScrollBy,
  accessibilityLabel,
}: LiveEditorProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const compact = densityFor(useWindowDimensions().width) === "compact";
  const windowHeight = useWindowDimensions().height;

  const web = useRef<WebView | null>(null);
  const host = useRef<View | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * Whether the note has the caret, kept here as well as reported upward.
   *
   * `NoteEditor` needs it to decide whether to render the accessory bar; this
   * file needs it to decide whether the bar is covering the bottom of the note.
   * The same three conditions in both places, from `accessoryUp`, rather than
   * two predicates that agree until somebody edits one.
   */
  const [focused, setFocused] = useState(false);
  /**
   * WHAT THE GUEST LAST MEASURED THE DOCUMENT AT, and why that is a state.
   *
   * `editorBox` in `host.ts` carries the whole argument for why a phone's
   * editor is given a height rather than a `flex`; the short version is that
   * the note is one page scroller and a `flex: 1` child of a scroll view's
   * content container measures to zero. This is the number that box is built
   * from, and the only thing that knows it is the guest — see the `height`
   * message in `protocol.ts`.
   *
   * `flexGrow: 1` on the content container is the fix that looks right and is
   * not: it makes the container a viewport-sized flex parent, so the editor
   * fills the screen, the title stops scrolling out from under the floating
   * chrome, the durability line becomes a strip pinned at the bottom, and
   * CodeMirror's scroller starts fighting the page scroller for the same drag.
   * Two nested scrollers is a different bug, not a fixed one.
   *
   * `null` until the guest has measured; `editorBox` draws an estimate until
   * then.
   */
  const [height, setHeight] = useState<number | null>(null);

  /**
   * The callbacks, held in a ref and read at call time.
   *
   * The bridge is built once — it holds the "what does the guest already have"
   * state that stops the caret jumping — so an extension of it that closed over
   * `onChange` directly would deliver every keystroke after the first state
   * change to a stale reducer. Exactly the trap `LiveEditor.web.tsx` documents.
   */
  const handlers = useRef({ onChange, onSave, controls, onFocus, onBlur, onScrollBy });
  handlers.current = { onChange, onSave, controls, onFocus, onBlur, onScrollBy };

  /**
   * What the keyboard is covering, and how much of that is our own bar.
   *
   * Refs rather than state because only callbacks read them, and the one that
   * reads them most — a `caret` message — arrives on every arrow key. The
   * accessory bar's height is written here as well as read by the effect below
   * so a `caret` that lands between the focus and the keyboard's own event
   * still subtracts the bar that is about to be over it.
   */
  const keyboardHeight = useRef(0);
  const covering = useRef({ windowHeight: 0, accessoryHeight: 0 });

  /**
   * Bring the caret out from under the keyboard by scrolling the surface this
   * editor is laid out inside.
   *
   * At compact the web view is as tall as its document, so CodeMirror's own
   * scroller has nothing to scroll and `coveredBottom`'s scroll margin has
   * nothing to act on — see the `caret` message in `protocol.ts`. The page
   * scroller in `NoteEditor` is what moves, through `onScrollBy`.
   *
   * A no-op on any surface that did not pass one, which is every surface where
   * the editor scrolls itself.
   */
  const keepCaretClear = useCallback((caret: { top: number; bottom: number }) => {
    const scrollBy = handlers.current.onScrollBy;
    if (scrollBy === undefined) return;
    if (keyboardHeight.current <= 0) return;
    host.current?.measureInWindow((_x, top) => {
      const overshoot = caretOvershoot({
        editorTop: top,
        caretBottom: caret.bottom,
        windowHeight: covering.current.windowHeight,
        keyboardHeight: keyboardHeight.current,
        accessoryHeight: covering.current.accessoryHeight,
      });
      if (overshoot > 0) scrollBy(overshoot);
    });
  }, []);

  const bridge = useMemo(
    () =>
      createHostBridge(
        (raw) => web.current?.postMessage(raw),
        {
          onChange: (text) => handlers.current.onChange(text),
          onSave: () => handlers.current.onSave(),
          /**
           * The focus contract, crossing back out of the web view.
           *
           * A `WebView` has neither `onFocus` nor `onBlur` — WKWebView is one
           * native view whose first responder is an implementation detail —
           * so the guest listens on CodeMirror's own `contentDOM`, exactly as
           * the web half does, and posts the result. Everything above this
           * file sees the same two props it saw when this was a `TextInput`.
           */
          onFocus: (next) => {
            setFocused(next);
            if (next) handlers.current.onFocus?.();
            else handlers.current.onBlur?.();
          },
          /*
            The measurement that keeps the note on the screen at all. See the
            `height` state above for why a phone's editor is sized and not
            flexed, and `protocol.ts` for why the guest is the only thing that
            can answer.
          */
          onHeight: (next) => setHeight(next),
          onCaret: (caret) => keepCaretClear(caret),
          onFailed: (message) => setFailure(message),
        },
      ),
    [keepCaretClear],
  );

  /**
   * The imperative handle, built once and aimed at the bridge rather than at an
   * editor — because on this platform there is no editor here to aim at.
   *
   * Each method is one message. What runs is `runCommand` in `editorSetup.ts`,
   * inside the guest, against the real `EditorView` — the same function the web
   * half calls directly. That is the whole reason `EditorControls` is five
   * verbs rather than "insert this text": a verb can be run against a state
   * that has a selection and an undo history, and a string cannot.
   */
  const api = useRef<EditorControls | null>(null);
  if (api.current === null) {
    api.current = {
      wrap: (before, after) => bridge.run({ name: "wrap", before, after }),
      toggleLinePrefix: (prefix) => bridge.run({ name: "toggleLinePrefix", prefix }),
      undo: () => bridge.run({ name: "undo" }),
      redo: () => bridge.run({ name: "redo" }),
      blur: () => bridge.run({ name: "blur" }),
    };
  }

  /**
   * Hand the handle over, and take it back on unmount.
   *
   * `controls` is read off the ref above and the effect runs once, so a parent
   * that passes a fresh arrow on every render — the normal way to write it —
   * does not re-hand the same object over and over, and the teardown still
   * calls the latest callback rather than the first render's.
   */
  useEffect(() => {
    handlers.current.controls?.(api.current);
    return () => handlers.current.controls?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => bridge.receive(event.nativeEvent.data),
    [bridge],
  );

  // Authoritative text: a different note opened, a draft discarded, a conflict
  // resolved. Never the echo of typing — `setDoc` drops that, which is the one
  // guard the whole bridge turns on.
  useEffect(() => {
    bridge.setDoc(value);
  }, [bridge, value]);

  useEffect(() => {
    bridge.setEditable(editable);
  }, [bridge, editable]);

  useEffect(() => {
    bridge.setTheme(themeVars(colors, fonts.mono, compact));
  }, [bridge, colors, compact]);

  /**
   * KEEPING THE CARET OFF THE KEYBOARD, and it is answered differently at the
   * two densities.
   *
   * The sharpest thing in this file, and the one a screenshot cannot show.
   * Nothing about a WKWebView shrinks when the keyboard opens: the web view
   * keeps its full height, the keyboard is drawn on top of it, and CodeMirror —
   * which measures its scroller's client rectangle — believes the whole note is
   * visible. Typing down a long note therefore puts the caret behind the keys
   * and CodeMirror is satisfied.
   *
   * **Where the editor scrolls itself** — a pointer layout, where it fills a
   * region with a real toolbar above it — three parts, and all three are needed:
   *
   *  1. **This effect** measures how much of the editor is covered and sends it
   *     as `inset`.
   *  2. The guest turns it into bottom padding on the scroller, so the last
   *     line *can* be scrolled clear — `styles.ts`.
   *  3. The guest also hands it to CodeMirror as a `scrollMargins` facet, which
   *     is what makes "scroll the caret into view" mean *above the keyboard*.
   *     That facet is consulted on every scroll, including the one CodeMirror
   *     performs for itself on every keystroke, which is why typing keeps
   *     working and not just the moment the keyboard opens. See `coveredBottom`.
   *
   * The overlap is **measured** rather than taken as the keyboard's height, so
   * it is right whether or not something above has already resized the editor to
   * make room — a `KeyboardAvoidingView`, `react-native-keyboard-controller`.
   * The accessory bar is the exception and is added rather than measured,
   * because it is positioned absolutely and resizes nothing; see
   * `coveredHeight`.
   *
   * **Where the note is the page** — compact, where the web view is exactly as
   * tall as its document — none of those three can work, and sending an `inset`
   * anyway would be actively wrong: the guest's padding would make the document
   * taller, which is a number this component then lays the web view out at, and
   * a scroller with slack in it is the second scroller the whole shape exists to
   * avoid. So the inset stays at zero and `keepCaretClear` does the job against
   * the page scroller instead, off the guest's `caret` messages. All this effect
   * owes that path is the keyboard's height, which is why it still runs.
   *
   * `keyboardWillShow` on iOS so the room is there before the keyboard is;
   * Android only emits the `Did` events.
   *
   * It re-runs when the bar appears or goes away, because the bar's height is
   * part of the answer and the keyboard does not move when it does.
   */
  const barUp = accessoryUp({ compact, editable, focused });
  covering.current = {
    windowHeight,
    accessoryHeight: barUp ? ACCESSORY_HEIGHT : 0,
  };
  useEffect(() => {
    const publish = () => {
      if (compact) return;
      if (keyboardHeight.current <= 0) {
        bridge.setInset(0);
        return;
      }
      host.current?.measureInWindow((_x, top, _width, height) => {
        bridge.setInset(
          coveredHeight({
            top,
            height,
            windowHeight,
            keyboardHeight: keyboardHeight.current,
            accessoryHeight: barUp ? ACCESSORY_HEIGHT : 0,
          }),
        );
      });
    };

    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, (event) => {
      keyboardHeight.current = event.endCoordinates.height;
      publish();
    });
    const hide = Keyboard.addListener(hideEvent, () => {
      keyboardHeight.current = 0;
      if (!compact) bridge.setInset(0);
    });
    // The bar can appear while the keyboard is already up — focus arrives over
    // the bridge a frame or two after the keys do — so the inset is republished
    // here rather than only from the keyboard's own events.
    publish();
    return () => {
      show.remove();
      hide.remove();
    };
  }, [bridge, windowHeight, barUp, compact]);

  if (failure !== null) {
    /*
      The degraded editor reports no focus, so the accessory bar never appears
      over it — and that is deliberate rather than an oversight.

      Five of the bar's six editing keys are CodeMirror commands that only exist
      inside the guest. Over a plain `TextInput` they would be present and do
      nothing, which is the defect this codebase keeps recording against itself.
      A `TextInput` also keeps iOS's own behaviour: tapping outside it resigns
      first responder, so the keyboard has a way out that the web view does not
      have. This state stays what it says it is — the markdown itself.
    */
    return (
      <View style={styles.wrap} accessibilityLabel={accessibilityLabel}>
        <Text variant="hint" style={styles.failure}>
          The formatted editor could not start, so this is the markdown itself.
          Your note is unchanged and still saves normally.
        </Text>
        <TextInput
          multiline
          editable={editable}
          value={value}
          onChangeText={onChange}
          style={[styles.fallback, compact && styles.fallbackReading]}
          accessibilityLabel={accessibilityLabel}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
    );
  }

  return (
    <View
      ref={host}
      /*
        Sized at compact, flexed everywhere else — `editorBox` is the whole
        argument, and `protocol.ts` says where the number comes from.

        The sized style is written on its own rather than layered over
        `styles.wrap`: `flex: 1` sets `flexBasis: 0`, which wins over a `height`
        on the main axis, so a style array carrying both would still collapse to
        nothing. That is why this reads as a choice between two styles and not
        as an override of one.
      */
      style={editorBox({ compact, height, windowHeight }) ?? styles.wrap}
      accessibilityLabel={accessibilityLabel}
    >
      <WebView
        ref={web}
        source={SOURCE}
        originWhitelist={ORIGINS as unknown as string[]}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={allowInitialLoadOnly}
        onError={() => setFailure("the web view failed to load")}
        onContentProcessDidTerminate={() => setFailure("the web view was terminated")}
        /*
          The editor's own scroller scrolls; WKWebView's must not, or the note
          has two and reads as sticking and then lurching. `styles.ts` sets
          `overflow: hidden` on the document for the same reason.

          **Do not reach for `keyboardDismissMode` here, and this is where you
          would.** Dragging the note down to put the keyboard away is the
          gesture people try first, and it cannot work: `keyboardDismissMode`
          is implemented by `RCTScrollView`, so it acts on the scroll view this
          prop has just switched off. CodeMirror's scroller is a `<div>` inside
          a web view and React Native cannot see it, let alone drive a keyboard
          from it. Turning the outer scroller back on to get the gesture would
          give the note two scrollers, which is the defect this line exists to
          prevent.

          So `NoteAccessory`'s dismiss key is the **only** way out of the
          keyboard on this surface. That raises its importance rather than
          lowering it: it is why the bar renders whenever the note has the
          caret, why the dismiss key is in its own object that cannot be the one
          that gets clipped on a narrow screen, and why `blur` is the one
          command `acceptsCommand` never refuses.
        */
        scrollEnabled={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        // Nothing in here needs storage, a cache, or a second window, and this
        // is somebody's private note. `incognito` puts WKWebView on a
        // non-persistent data store, so nothing survives the screen.
        incognito
        cacheEnabled={false}
        domStorageEnabled={false}
        allowFileAccess={false}
        allowsLinkPreview={false}
        javaScriptCanOpenWindowsAutomatically={false}
        setSupportMultipleWindows={false}
        // The guest calls `focus()` when a tap lands in the document, and
        // WebKit otherwise refuses to raise the keyboard for it.
        keyboardDisplayRequiresUserAction={false}
        /*
          WebKit draws its own accessory bar over the keyboard — the grey strip
          with *Done* on it — and this is the prop that takes it away.

          It was `false` because that bar's *Done* was the only way to dismiss
          the keyboard from inside the note. That is no longer the case:
          `NoteAccessory` is ours, it rides in the same place, and its rightmost
          key does the same job. Two stacked bars saying different things is
          worse than either, so WebKit's goes.

          Ours is now the only one, which is the sentence the `scrollEnabled`
          comment above turns on: there is no drag-to-dismiss on this surface, so
          if the accessory bar ever stops rendering while the keyboard is up, a
          person is trapped in the keyboard with no way out. That is what
          `noteAccessory.test.ts` pins when it asserts the bar appears on focus.
        */
        hideKeyboardAccessoryView
        style={styles.web}
        containerStyle={styles.webContainer}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { flex: 1, minHeight: 0 },
  /**
   * A `WebView` has an opaque white background of its own until it paints,
   * which on a dark note is a full-screen flash on every open. The document's
   * own ground is `--lp-bg`, from the same token.
   */
  web: { flex: 1, backgroundColor: colors.surface },
  webContainer: { flex: 1, backgroundColor: colors.surface },

  failure: { paddingHorizontal: space.x5, paddingTop: space.x2, color: colors.warnText },

  /** The editor this file used to be, kept as the fallback and nothing else. */
  fallback: {
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
  fallbackReading: {
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: 16,
    lineHeight: leading(16, 1.5),
    paddingTop: space.x2,
    paddingHorizontal: space.x6,
    paddingBottom: space.x8,
  },
});
