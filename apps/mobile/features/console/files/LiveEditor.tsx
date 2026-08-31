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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keyboard, Platform, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { densityFor } from "../../app/frame";
import { Text } from "../../design/components/Text";
import { fonts, leading, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { EDITOR_HTML, coveredHeight, createHostBridge, themeVars } from "./webview/host";
import type { LiveEditorProps } from "./LiveEditor.web";

export type { LiveEditorProps };

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
   * The callbacks, held in a ref and read at call time.
   *
   * The bridge is built once — it holds the "what does the guest already have"
   * state that stops the caret jumping — so an extension of it that closed over
   * `onChange` directly would deliver every keystroke after the first state
   * change to a stale reducer. Exactly the trap `LiveEditor.web.tsx` documents.
   */
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  const bridge = useMemo(
    () =>
      createHostBridge(
        (raw) => web.current?.postMessage(raw),
        {
          onChange: (text) => handlers.current.onChange(text),
          onSave: () => handlers.current.onSave(),
          onFailed: (message) => setFailure(message),
        },
      ),
    [],
  );

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
   * How much of the note the keyboard is sitting on.
   *
   * Measured as an **overlap** rather than taken as the keyboard's height, so
   * it is right whether or not something above this has already resized the
   * editor to make room — a `KeyboardAvoidingView`, an accessory bar,
   * `react-native-keyboard-controller`. If the editor shrinks, the overlap goes
   * to zero on its own and the note is not padded twice. See `coveredHeight`.
   *
   * `keyboardWillShow` on iOS so the room is there before the keyboard is;
   * Android only emits the `Did` events.
   */
  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, (event) => {
      const keyboardHeight = event.endCoordinates.height;
      host.current?.measureInWindow((_x, top, _width, height) => {
        bridge.setInset(coveredHeight({ top, height, windowHeight, keyboardHeight }));
      });
    });
    const hide = Keyboard.addListener(hideEvent, () => bridge.setInset(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [bridge, windowHeight]);

  if (failure !== null) {
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
    <View ref={host} style={styles.wrap} accessibilityLabel={accessibilityLabel}>
      <WebView
        ref={web}
        source={SOURCE}
        originWhitelist={ORIGINS as unknown as string[]}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={allowInitialLoadOnly}
        onError={() => setFailure("the web view failed to load")}
        onContentProcessDidTerminate={() => setFailure("the web view was terminated")}
        // The editor's own scroller scrolls; WKWebView's must not, or the note
        // has two and reads as sticking and then lurching. `styles.ts` sets
        // `overflow: hidden` on the document for the same reason.
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
          WebKit's own accessory bar (the one with Done) stays, for now, because
          it is the only way to dismiss the keyboard from inside the note today.
          The moment the app grows its own accessory bar this must become
          `true`, or a phone gets two stacked bars — see the report.
        */
        hideKeyboardAccessoryView={false}
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
