import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, useTheme, type Colors } from "../../design/theme";
import { parseDrawing, serializeDrawing } from "@context/drawings";
import { DrawingView } from "./DrawingView";
import {
  DRAWING_CHANNEL,
  DRAWING_EDITOR_PATH,
  readFromEditor,
  type FromEditor,
} from "./drawingBridge";

/**
 * The drawing editor — web, as an iframe around a page of its own.
 *
 * ## Why an iframe and not an import
 *
 * This was written first as `import("@excalidraw/excalidraw")` inside the
 * console, on the reasoning that a dynamic import is a lazy chunk. It is not,
 * under Expo's Metro: `expo export --platform web` put the editor in a
 * `__common` chunk that `index.html` loads with a plain blocking `<script>`,
 * taking the console's total JavaScript from **5.7MB to 14.6MB on every page
 * load** — measured, for a feature most sessions never open.
 *
 * So the editor is a separate page (`apps/mobile/drawing-editor/`), built by
 * `scripts/build-drawing-editor.mjs` and served from our own origin. The
 * console's bundle is unchanged and the editor is fetched the first time
 * somebody opens a drawing. The same page runs in a `WebView` on native, which
 * is what makes this feature exist on phones at all.
 *
 * ## What crosses the boundary, and what does not
 *
 * Elements go in, elements come back. **The page never sees the customer's
 * Markdown**, and it cannot produce a file body — `serializeDrawing` does that
 * here, where the original bytes are, so the frontmatter and links survive and
 * a bug on the far side cannot corrupt the file. `drawingBridge.ts` is the
 * whole protocol and checks the origin of every message before reading it.
 *
 * ## It degrades to the view, never to an error
 *
 * A reader, a drawing whose payload will not parse, a file the serializer
 * refuses to splice, or a page that fails to boot all fall back to
 * `DrawingView` with a line saying which. A drawing we cannot edit is still a
 * drawing somebody can look at.
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
  /** Called with the complete new file body. The caller owns the write. */
  onChange: (next: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { scheme } = useTheme();
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  const drawing = useMemo(() => parseDrawing(source, path), [source, path]);
  /*
    Whether a save could land is decided from the file, before the editor is
    offered — so an un-splicable drawing is a view with a reason rather than a
    canvas whose saves silently fail after somebody has drawn on it.
  */
  const splicable = serializeDrawing(source, drawing.elements ?? []) !== null;
  const show = splicable && !failed;

  /*
    The file as the caller holds it, in a ref: `change` arrives on every pointer
    move, and making the handler depend on `source` would rebuild the listener
    constantly. Every splice is against the newest bytes either way.
  */
  const latest = useRef(source);
  useEffect(() => {
    latest.current = source;
  }, [source]);

  const send = useCallback(() => {
    const target = frame.current?.contentWindow;
    if (!target) return;
    target.postMessage(
      {
        channel: DRAWING_CHANNEL,
        type: "load",
        elements: drawing.elements ?? [],
        appState: drawing.appState,
        theme: scheme,
        editable: canEdit,
      },
      window.location.origin
    );
  }, [drawing, scheme, canEdit]);

  useEffect(() => {
    if (!show) return;
    const expected = window.location.origin;

    function onMessage(event: MessageEvent) {
      const message: FromEditor | null = readFromEditor(event.data, event.origin, expected);
      if (!message) return;
      switch (message.type) {
        case "ready":
          setReady(true);
          send();
          break;
        case "change": {
          const next = serializeDrawing(latest.current, message.elements as never[]);
          // A null here means the file stopped being splicable under us. Dropping
          // the change is the safe half of that choice.
          if (next !== null && next !== latest.current) onChange(next);
          break;
        }
        case "error":
          setFailed(true);
          break;
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [show, send, onChange]);

  // Re-send when the theme or the caller's write access changes: the page holds
  // what it was given and has no way to ask again.
  useEffect(() => {
    if (ready) send();
  }, [ready, send]);

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
      {/*
        `iframe` directly rather than through a React Native primitive: this
        file is the web half by construction, and there is no RN element that
        maps to one. The sandbox allows scripts and same-origin because the
        page is ours and has to run React; it does **not** allow top-level
        navigation, forms, popups or downloads, so the editor cannot take the
        console somewhere else or write a file to the customer's machine.
      */}
      <iframe
        ref={frame}
        src={DRAWING_EDITOR_PATH}
        title={`Drawing: ${drawing.name}`}
        sandbox="allow-scripts allow-same-origin"
        onError={() => setFailed(true)}
        style={{ border: "none", width: "100%", height: "100%", display: "block" }}
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
  if (failed) return "The drawing editor could not be loaded. The file is unchanged.";
  if (drawing.unreadable !== null) {
    return "This drawing cannot be edited here because its data could not be read. Open it in Excalidraw or Obsidian — the file is untouched.";
  }
  return "This file cannot be edited here without risking its contents. Open it in Excalidraw or Obsidian.";
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    frame: { gap: space.x2 },
    /*
      A real height, because the page inside measures its canvas from this box
      and a zero-height parent renders a zero-pixel canvas that looks like a
      failure to load.
    */
    canvas: {
      height: 560,
      minHeight: 320,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      overflow: "hidden",
    },
  });
