import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, useTheme, type Colors } from "../../design/theme";
import { parseDrawing, serializeDrawing } from "@context/drawings";
import { DrawingView } from "./DrawingView";
import { consoleOrigin } from "./shareOrigin";
import { DRAWING_CHANNEL, DRAWING_EDITOR_PATH, readFromEditor } from "./drawingBridge";

/**
 * The drawing editor — native, and the same page the web half loads.
 *
 * Excalidraw is React DOM, so it cannot render in React Native. The console has
 * solved that before: `LiveEditor.tsx` runs CodeMirror in a `WebView` over a
 * small JSON bridge. This is the same move, with one difference that matters.
 *
 * **The page is fetched, not bundled.** `bundle.generated.ts` is committed and
 * ships over the air to every phone on every update; it is 600KB for the whole
 * CodeMirror editor. The drawing editor is 8MB (2.4MB gzipped), and folding it
 * in would put that on every OTA update for every user, including the ones who
 * never open a drawing. So the `WebView` loads the same page the web console
 * loads, from the console's own origin — built by
 * `scripts/build-drawing-editor.mjs`, served beside the web app, and reached
 * only when somebody opens a drawing.
 *
 * The honest cost is that **editing a drawing on a phone needs network**. A
 * drawing still *reads* offline, because `DrawingView` renders from the file
 * the console already has — so losing connectivity costs the editor, not the
 * content. That is the same trade the rest of the console makes and it is why
 * this falls back to the view rather than to an error.
 */
export function DrawingEditor({
  path,
  source,
  canEdit,
  onChange,
}: {
  path: string;
  source: string;
  canEdit: boolean;
  onChange: (next: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { scheme } = useTheme();
  const view = useRef<WebView | null>(null);
  const [failed, setFailed] = useState(false);

  const drawing = useMemo(() => parseDrawing(source, path), [source, path]);
  const splicable = serializeDrawing(source, drawing.elements ?? []) !== null;
  const origin = consoleOrigin();
  const show = splicable && !failed && origin !== "";

  const latest = useRef(source);
  latest.current = source;

  const send = useCallback(() => {
    view.current?.postMessage(
      JSON.stringify({
        channel: DRAWING_CHANNEL,
        type: "load",
        elements: drawing.elements ?? [],
        appState: drawing.appState,
        theme: scheme,
        editable: canEdit,
      })
    );
  }, [drawing, scheme, canEdit]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      /*
        `event.nativeEvent.url`'s origin is what actually loaded, checked
        against the origin we asked for — the same rule the web half applies,
        and the reason a redirected or injected page cannot drive this.
      */
      const from = originOf(event.nativeEvent.url) ?? origin;
      const message = readFromEditor(data, from, origin);
      if (!message) return;

      switch (message.type) {
        case "ready":
          send();
          break;
        case "change": {
          const next = serializeDrawing(latest.current, message.elements as never[]);
          if (next !== null && next !== latest.current) onChange(next);
          break;
        }
        case "error":
          setFailed(true);
          break;
      }
    },
    [origin, send, onChange]
  );

  if (!show) {
    return (
      <View style={styles.frame}>
        <DrawingView path={path} source={source} />
        <Text variant="rowSub">{reasonFor({ drawing, failed })}</Text>
      </View>
    );
  }

  return (
    <View style={styles.canvas} testID="drawing-editor">
      <WebView
        ref={view}
        source={{ uri: `${origin}${DRAWING_EDITOR_PATH}` }}
        onMessage={onMessage}
        onError={() => setFailed(true)}
        onHttpError={() => setFailed(true)}
        // The editor is one page and never navigates. Refusing everything else
        // means a redirect cannot turn this frame into a browser pointed at
        // somebody else's site while wearing the console's chrome.
        onShouldStartLoadWithRequest={(request) =>
          request.url.startsWith(`${origin}${DRAWING_EDITOR_PATH}`)
        }
        originWhitelist={[origin]}
        javaScriptEnabled
        // A drawing is the customer's content: nothing about it should outlive
        // this view in a shared web store.
        incognito
        style={styles.web}
      />
    </View>
  );
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.exec(url);
  return match ? match[0] : null;
}

function reasonFor({
  drawing,
  failed,
}: {
  drawing: ReturnType<typeof parseDrawing>;
  failed: boolean;
}): string {
  if (failed) {
    return "The drawing editor could not be loaded — editing a drawing on this device needs a connection. The file is unchanged.";
  }
  if (drawing.unreadable !== null) {
    return "This drawing cannot be edited here because its data could not be read. Open it in Excalidraw or Obsidian — the file is untouched.";
  }
  return "This file cannot be edited here without risking its contents. Open it in Excalidraw or Obsidian.";
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    frame: { gap: space.x2 },
    canvas: {
      height: 560,
      minHeight: 320,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      overflow: "hidden",
    },
    web: { flex: 1, backgroundColor: "transparent" },
  });
