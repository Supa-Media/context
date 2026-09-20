/**
 * The five messages between the console and the drawing editor.
 *
 * ## Why there is a bridge at all
 *
 * The first version of this imported `@excalidraw/excalidraw` straight into the
 * console behind a dynamic `import()`, on the reasoning that a dynamic import
 * is a lazy chunk. **Measured, it is not** — not under Expo's Metro. Exporting
 * the web build put Excalidraw in a `__common` chunk that `index.html` loads
 * with a plain blocking `<script src>`, taking the console's total JavaScript
 * from 5.7MB to 14.6MB on *every* page load, for a feature most sessions never
 * open. The numbers are in `docs/decisions/plugins.md`.
 *
 * So the editor is not part of this application. It is a standalone page, built
 * separately by `scripts/build-drawing-editor.mjs` and served from our own
 * origin, which the console loads in an `<iframe>` on web and a `WebView` on
 * native — the same page, the same messages, both platforms. The console's
 * bundle is unchanged, the editor is fetched the first time somebody opens a
 * drawing, and the native half stops being a limitation to apologise for.
 *
 * That is also why this file has no imports. It is the one thing both sides
 * agree about, and it has to be readable by a bundle that shares nothing else
 * with the app.
 *
 * ## The messages
 *
 * Console → editor:
 *   `load`   — here are the elements to edit, and the theme to draw them in.
 *   `remote` — somebody else changed these elements; reconcile them in.
 *   `peers`  — who else is on this canvas and where their pointers are.
 *
 * Editor → console:
 *   `ready`  — the page booted and is waiting for `load`.
 *   `change` — the elements changed; here they are.
 *   `share`  — these elements changed *locally*; put them on the wire.
 *   `point`  — this person's pointer moved on the canvas.
 *   `error`  — the editor could not start. The console falls back to the view.
 *
 * `share` is separate from `change` and the split is the point. `change` is
 * "the drawing is now this, save it", fired for every reason including a
 * remote element arriving; `share` is "this person did this, tell the others",
 * and it carries only what they changed. Collapsing them would echo every
 * incoming element straight back to the room it came from, which is a loop
 * that ends when somebody closes the tab.
 *
 * `change` carries elements rather than a file, and that is deliberate: the
 * editor never sees the customer's Markdown. Splicing the elements back into
 * the file is `serializeDrawing`'s job, on the console side, where the original
 * bytes are — so a page loaded in an iframe cannot produce a file body at all,
 * let alone a wrong one.
 */

/** Every message the editor page may send. Anything else is ignored. */
export type FromEditor =
  | { type: "ready" }
  | { type: "change"; elements: unknown[] }
  /** Elements this person just changed, for the room. Never remote ones. */
  | { type: "share"; elements: unknown[] }
  /** Where this person's pointer is, in scene coordinates, and what they hold. */
  | { type: "point"; x: number; y: number; selected: string[] }
  | { type: "error"; reason: string };

/** Every message the console may send. */
export type ToEditor =
  | {
      type: "load";
      elements: unknown[];
      appState: Record<string, unknown> | null;
      theme: "light" | "dark";
      /** False for a reader: the canvas loads, and nothing can be changed. */
      editable: boolean;
      /**
       * Whether anybody else could be on this canvas.
       *
       * Passed to Excalidraw as `isCollaborating`, which is what makes its
       * undo stack behave: in a collaborative scene, undo reverts what *this*
       * person did rather than the last thing that happened to the document,
       * so undoing does not take back somebody else's rectangle.
       */
      collaborating: boolean;
    }
  /** Elements from somebody else, to reconcile into the local scene. */
  | { type: "remote"; elements: unknown[] }
  /** Who else is here, and where their pointers are. */
  | {
      type: "peers";
      peers: { id: string; name: string; color: string | null; x: number; y: number; selected: string[] }[];
    };

/**
 * The channel name, carried on every message in both directions.
 *
 * An iframe shares a `message` listener with every other thing that posts to
 * the window — an extension, an embed, another frame — so a handler that
 * trusted `event.data.type` alone would act on anybody's `{type:"change"}`.
 * Checking a fixed field first is the cheap half of not doing that; the origin
 * check in `readMessage` is the half that matters.
 */
export const DRAWING_CHANNEL = "context.drawing.v1";

type Envelope = { channel: string } & Record<string, unknown>;

/** Wrap a message for the wire. */
export function envelope<T extends object>(message: T): Envelope {
  return { channel: DRAWING_CHANNEL, ...message };
}

/**
 * Read a message from the editor, or `null` if it is not one.
 *
 * **`origin` is checked before anything else is read.** The editor page is
 * served from the console's own origin, so a message from anywhere else is
 * either another frame on the page or something injected — and in both cases
 * acting on it would let a stranger's `change` rewrite the customer's drawing.
 * `expectedOrigin` is passed in rather than read here so the caller can
 * establish it once from the URL it actually loaded.
 *
 * Shape is then checked rather than cast: `elements` must be an array, because
 * the next thing that happens to it is a splice into somebody's file.
 */
export function readFromEditor(
  data: unknown,
  origin: string,
  expectedOrigin: string
): FromEditor | null {
  if (origin !== expectedOrigin) return null;
  if (!data || typeof data !== "object") return null;

  const message = data as Envelope;
  if (message.channel !== DRAWING_CHANNEL) return null;

  switch (message.type) {
    case "ready":
      return { type: "ready" };
    case "change":
      return Array.isArray(message.elements) ? { type: "change", elements: message.elements } : null;
    case "share":
      return Array.isArray(message.elements) ? { type: "share", elements: message.elements } : null;
    case "point": {
      const x = Number(message.x);
      const y = Number(message.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const selected = Array.isArray(message.selected)
        ? message.selected.filter((id): id is string => typeof id === "string").slice(0, 64)
        : [];
      return { type: "point", x, y, selected };
    }
    case "error":
      return { type: "error", reason: typeof message.reason === "string" ? message.reason : "unknown" };
    default:
      return null;
  }
}

/** Read the console's message inside the editor page. Same rules, other way. */
export function readToEditor(data: unknown, origin: string, expectedOrigin: string): ToEditor | null {
  if (origin !== expectedOrigin) return null;
  if (!data || typeof data !== "object") return null;

  const message = data as Envelope;
  if (message.channel !== DRAWING_CHANNEL) return null;

  if (message.type === "remote") {
    return Array.isArray(message.elements) ? { type: "remote", elements: message.elements } : null;
  }

  if (message.type === "peers") {
    if (!Array.isArray(message.peers)) return null;
    const peers = [];
    for (const raw of message.peers) {
      if (!raw || typeof raw !== "object") continue;
      const peer = raw as Record<string, unknown>;
      if (typeof peer.id !== "string" || peer.id.length === 0) continue;
      const x = Number(peer.x);
      const y = Number(peer.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      peers.push({
        id: peer.id,
        name: typeof peer.name === "string" ? peer.name : "Someone",
        // A colour is drawn into somebody's canvas, so it is checked here for
        // the same reason `protocol.ts` checks one: `null` lets the page pick.
        color: typeof peer.color === "string" && /^#[0-9a-fA-F]{6}$/.test(peer.color)
          ? peer.color
          : null,
        x,
        y,
        selected: Array.isArray(peer.selected)
          ? peer.selected.filter((id): id is string => typeof id === "string").slice(0, 64)
          : [],
      });
    }
    return { type: "peers", peers };
  }

  if (message.type !== "load") return null;
  if (!Array.isArray(message.elements)) return null;

  return {
    type: "load",
    elements: message.elements,
    appState:
      message.appState && typeof message.appState === "object"
        ? (message.appState as Record<string, unknown>)
        : null,
    theme: message.theme === "dark" ? "dark" : "light",
    editable: message.editable === true,
    collaborating: message.collaborating === true,
  };
}

/**
 * Did this message come from the page we loaded?
 *
 * The web half has `event.origin`, which the browser fills in and nothing can
 * forge. The native half has `event.nativeEvent.url`, and the check built on it
 * used to distil an origin out of that with a regex and compare origins, with
 * `?? origin` behind it — so **a url the regex could not read counted as ours**.
 * Fail-open, in the one check between an arbitrary page and a splice into
 * somebody's file.
 *
 * `file:///…` is the case that makes it concrete: the host is empty, the regex
 * matches nothing, the fallback fires, and a page we never loaded is trusted.
 * That is the shape a downloaded offline copy would introduce, which is how it
 * was found — see `docs/decisions/plugins.md`.
 *
 * So the whole url is compared rather than an origin distilled from it, and an
 * unreadable one is refused. The hash and the query are dropped because a
 * `WebView` reports what it actually loaded and Excalidraw puts view state in
 * the hash; everything before them must match exactly, so a prefix like
 * `…/index.html.evil` is not the page.
 */
export function isEditorPageUrl(url: string | undefined | null, expected: string): boolean {
  if (typeof url !== "string" || url === "") return false;
  const bare = (value: string) => value.split("#")[0]!.split("?")[0];
  const seen = bare(url);
  const want = bare(expected);
  // A url with no scheme-and-host is not something to compare loosely: an
  // empty `want` would otherwise match everything.
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/]/i.test(seen) || !/^[a-z][a-z0-9+.-]*:\/\/[^/]/i.test(want)) {
    return false;
  }
  return seen === want;
}

/**
 * Where the editor page lives.
 *
 * Root-relative for the reason `drawingAssets.ts` gives about the fonts: a
 * self-hosted deployment must serve its own, and a browser that reached back to
 * our domain for somebody else's console would be both a bug and a leak.
 */
export const DRAWING_EDITOR_PATH = "/drawing-assets/editor/index.html";
