import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, useTheme, type Colors } from "../../design/theme";
import { parseDrawing, serializeDrawing } from "@context/drawings";
import { DrawingView } from "./DrawingView";
import { consoleOrigin } from "./shareOrigin";
import { useEffect } from "react";
import {
  DRAWING_CHANNEL,
  DRAWING_EDITOR_PATH,
  isEditorPageUrl,
  readFromEditor,
} from "./drawingBridge";
import type { DrawingCollaboration } from "./drawingCollaboration";

/** How many messages are held for a page that has not booted yet. */
const PENDING_CAP = 500;

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
  collaboration,
}: {
  path: string;
  source: string;
  canEdit: boolean;
  onChange: (next: string) => void;
  /**
   * The room this canvas is shared with, when there is one.
   *
   * The same page runs here as on web, so the same messages carry the same
   * collaboration — a phone in a shared drawing is not a second
   * implementation waiting to be written.
   */
  collaboration?: DrawingCollaboration;
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
        collaborating: collaboration !== undefined,
      })
    );
  }, [drawing, scheme, canEdit, collaboration]);

  const room = useRef(collaboration);
  room.current = collaboration;

  /*
    Held until the page says it is listening, for the reason the web half gives
    at length: the editor is fetched on demand and the socket is open long
    before it has booted, and a message posted into a frame with no listener is
    gone rather than queued. The frames lost in that window are the room's
    replay — the drawing everybody else can already see.
  */
  const queued = useRef<Record<string, unknown>[]>([]);
  const listening = useRef(false);

  const toPage = useCallback((message: Record<string, unknown>) => {
    if (!listening.current) {
      queued.current.push(message);
      if (queued.current.length > PENDING_CAP) {
        queued.current.splice(0, queued.current.length - PENDING_CAP);
      }
      return;
    }
    view.current?.postMessage(JSON.stringify({ channel: DRAWING_CHANNEL, ...message }));
  }, []);

  const flush = useCallback(() => {
    listening.current = true;
    const held = queued.current;
    queued.current = [];
    for (const message of held) {
      view.current?.postMessage(JSON.stringify({ channel: DRAWING_CHANNEL, ...message }));
    }
  }, []);

  // Relayed, never merged: the reconciliation is Excalidraw's and runs in the
  // page. See `DrawingEditor.web.tsx` for the argument in full.
  useEffect(() => {
    if (!collaboration) return;
    return collaboration.onRemoteElements((elements) => {
      if (elements.length > 0) toPage({ type: "remote", elements });
    });
  }, [collaboration, toPage]);

  useEffect(() => {
    if (!collaboration) return;
    return collaboration.onPeers((peers) => toPage({ type: "peers", peers }));
  }, [collaboration, toPage]);

  useEffect(() => {
    if (!collaboration) return;
    return collaboration.onCompactRequest(() => {
      const scene = parseDrawing(latest.current, path);
      collaboration.compact(scene.elements ?? []);
    });
  }, [collaboration, path]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      /*
        The url that actually loaded, compared with the page we asked for.

        This used to reduce both to an origin and compare those, with
        `?? origin` behind it — so a url the regex could not read was treated
        as ours, which is fail-open in the one check between an arbitrary page
        and a splice into somebody's file. `isEditorPageUrl` compares the whole
        url and refuses what it cannot read.
      */
      if (!isEditorPageUrl(event.nativeEvent.url, `${origin}${DRAWING_EDITOR_PATH}`)) return;
      const message = readFromEditor(data, origin, origin);
      if (!message) return;

      switch (message.type) {
        case "ready":
          send();
          flush();
          break;
        case "change": {
          const next = serializeDrawing(latest.current, message.elements as never[]);
          if (next !== null && next !== latest.current) onChange(next);
          break;
        }
        case "share":
          room.current?.share(message.elements);
          break;
        case "point":
          room.current?.point(message.x, message.y, message.selected);
          break;
        case "error":
          setFailed(true);
          break;
      }
    },
    [origin, send, onChange, flush]
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
        /*
          The editor is one page and never navigates. Refusing everything else
          means a redirect cannot turn this frame into a browser pointed at
          somebody else's site while wearing the console's chrome.

          **Through `isEditorPageUrl`, which is what "one page" means.** This
          was a `startsWith` on the same string, and a prefix is not a page: it
          admits every same-origin path that merely begins with the editor's —
          `…/index.html.other`, `…/index.htmlx`, `…/index.html/../elsewhere`.
          Nothing foreign was ever admissible, because the prefix carries the
          origin and `originWhitelist` sits behind it, so this is a tightening
          rather than a hole — but the sentence above already specified the
          stricter rule, and the strict comparison was already imported for the
          message gate a few lines up, where its own comment records the
          fail-open it was introduced to end.
        */
        onShouldStartLoadWithRequest={(request) =>
          isEditorPageUrl(request.url, `${origin}${DRAWING_EDITOR_PATH}`)
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
