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
 * open. The numbers are in `docs/decisions/obsidian-plugins.md`.
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
 *
 * Editor → console:
 *   `ready`  — the page booted and is waiting for `load`.
 *   `change` — the elements changed; here they are.
 *   `error`  — the editor could not start. The console falls back to the view.
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
  | { type: "error"; reason: string };

/** Every message the console may send. */
export type ToEditor = {
  type: "load";
  elements: unknown[];
  appState: Record<string, unknown> | null;
  theme: "light" | "dark";
  /** False for a reader: the canvas loads, and nothing can be changed. */
  editable: boolean;
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
  if (message.channel !== DRAWING_CHANNEL || message.type !== "load") return null;
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
  };
}

/**
 * Where the editor page lives.
 *
 * Root-relative for the reason `drawingAssets.ts` gives about the fonts: a
 * self-hosted deployment must serve its own, and a browser that reached back to
 * our domain for somebody else's console would be both a bug and a leak.
 */
export const DRAWING_EDITOR_PATH = "/drawing-assets/editor/index.html";
