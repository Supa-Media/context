import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, useTheme, type Colors } from "../../design/theme";
import { parseDrawing, serializeDrawing } from "@context/drawings";
import { DrawingView } from "./DrawingView";
import { keepDrawingEditorOffline } from "./drawingOffline";
import {
  DRAWING_CHANNEL,
  DRAWING_EDITOR_PATH,
  readFromEditor,
  type FromEditor,
} from "./drawingBridge";
import type { DrawingCollaboration } from "./drawingCollaboration";

/**
 * How many messages are held for a page that has not booted yet.
 *
 * Generous, because the whole point is not to lose the replay of a busy
 * canvas, and small enough that a page which never boots cannot grow a queue
 * without bound.
 */
const PENDING_CAP = 500;

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
  collaboration,
}: {
  path: string;
  source: string;
  canEdit: boolean;
  /** Called with the complete new file body. The caller owns the write. */
  onChange: (next: string) => void;
  /**
   * The room this canvas is shared with, when there is one.
   *
   * Absent on every surface with no gateway — the landing page's demo console,
   * a native `WebView`, a drawing nobody else has open — and the editor then
   * behaves exactly as it did before any of this, which is the property that
   * makes collaboration safe to switch off.
   */
  collaboration?: DrawingCollaboration;
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

  /*
    Ask for the editor to be kept, so the next drawing opens without a network.

    Here rather than at app start because most sessions never open a drawing,
    and a worker installed for all of them is an install lifecycle nobody asked
    for. Mounting this component is the moment somebody is looking at one, so
    the load that pays for the 2.4MB is the load that caches it.

    Fire and forget, and no dependency: registering twice is a no-op in the
    browser, and every way it can fail leaves the editor working exactly as it
    did before — fetched each time. See `drawingOffline.web.ts`.
  */
  useEffect(() => {
    keepDrawingEditorOffline();
  }, []);

  /*
    The room, in a ref for the same reason `latest` is: every handler below is
    registered once and must reach the current one, and rebuilding the message
    listener on each roster change would drop frames mid-drag.
  */
  const room = useRef(collaboration);
  room.current = collaboration;

  /*
    **Nothing is posted at the page until it says it is listening.**

    The editor is a 2.4MB page fetched on demand; the socket is open long
    before it has booted. A `postMessage` to a frame whose listener is not
    registered yet is not queued by the browser, it is *gone* — and the frames
    that arrive in that window are the room's replay, which is to say the
    drawing everybody else can already see. Losing those is a second person
    opening a shared canvas and finding it blank, which is exactly what two
    browsers showed.

    So messages are held until `ready` and then flushed in order. Bounded,
    because a page that never boots must not turn a busy canvas into an
    unbounded queue: past the cap the *oldest* are dropped, since a later
    element supersedes an earlier one by version and the newest state is the
    one worth keeping.
  */
  const queued = useRef<Record<string, unknown>[]>([]);
  const listening = useRef(false);

  const post = useCallback((message: Record<string, unknown>) => {
    const target = frame.current?.contentWindow;
    if (!target || !listening.current) {
      queued.current.push(message);
      if (queued.current.length > PENDING_CAP) queued.current.splice(0, queued.current.length - PENDING_CAP);
      return;
    }
    target.postMessage({ channel: DRAWING_CHANNEL, ...message }, window.location.origin);
  }, []);

  const flush = useCallback(() => {
    const target = frame.current?.contentWindow;
    if (!target) return;
    listening.current = true;
    const held = queued.current;
    queued.current = [];
    for (const message of held) {
      target.postMessage({ channel: DRAWING_CHANNEL, ...message }, window.location.origin);
    }
  }, []);

  /*
    Elements from a peer, straight into the canvas.

    This console never merges them and holds no second copy of the scene: the
    reconciliation is Excalidraw's `reconcileElements`, which lives in the page
    because Excalidraw does. What arrives here is relayed and forgotten.
  */
  useEffect(() => {
    if (!collaboration) return;
    return collaboration.onRemoteElements((elements) => {
      if (elements.length > 0) post({ type: "remote", elements });
    });
  }, [collaboration, post]);

  useEffect(() => {
    if (!collaboration) return;
    return collaboration.onPeers((peers) => post({ type: "peers", peers }));
  }, [collaboration, post]);

  /*
    The room asked for a compaction, which for a canvas means the whole scene —
    and the console does not have it as elements, only as file bytes. So the
    scene is read back out of the newest bytes the caller holds, which is what
    every save has already been spliced into.
  */
  useEffect(() => {
    if (!collaboration) return;
    return collaboration.onCompactRequest(() => {
      const scene = parseDrawing(latest.current, path);
      collaboration.compact(scene.elements ?? []);
    });
  }, [collaboration, path]);

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
        collaborating: collaboration !== undefined,
      },
      window.location.origin
    );
  }, [drawing, scheme, canEdit, collaboration]);

  useEffect(() => {
    if (!show) return;
    const expected = window.location.origin;

    function onMessage(event: MessageEvent) {
      /*
        The origin check keeps other sites out; it does not say *which* of our
        own windows sent this.

        The editor page is served from our own origin, so every same-origin
        window clears that bar — the console's own included, and
        `window.postMessage({...})` from anywhere in this bundle reached the
        branch below that splices elements into the customer's file. The frame
        is a ref this component already holds, so the identity costs nothing:
        anything that is not the contentWindow of the iframe we rendered is not
        the editor. Belt to the sandbox's braces, not a replacement for it.
      */
      if (event.source !== frame.current?.contentWindow) return;
      const message: FromEditor | null = readFromEditor(event.data, event.origin, expected);
      if (!message) return;
      switch (message.type) {
        case "ready":
          setReady(true);
          send();
          // Everything that arrived while the page was still loading, in the
          // order it arrived, now that there is something listening for it.
          flush();
          break;
        case "change": {
          const next = serializeDrawing(latest.current, message.elements as never[]);
          // A null here means the file stopped being splicable under us. Dropping
          // the change is the safe half of that choice.
          if (next !== null && next !== latest.current) onChange(next);
          break;
        }
        case "share":
          /*
            This person's own changed elements, on their way to the room.

            Separate from `change` on purpose: `change` is "the drawing is now
            this, save it" and fires for every reason, a peer's element
            included. Sharing that would send every incoming element straight
            back to the room it came from.
          */
          room.current?.share(message.elements);
          break;
        case "point":
          room.current?.point(message.x, message.y, message.selected);
          break;
        case "error":
          setFailed(true);
          break;
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [show, send, onChange, flush]);

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
