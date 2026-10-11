/**
 * ```` ```mermaid ```` fences: which ones are drawn, and the frame that draws
 * them.
 *
 * Mermaid is the diagram syntax GitHub, GitLab and Obsidian all draw, so a note
 * written in any of them arrives here with its charts as plain fences. This
 * draws them, under the rule every folded block in this editor follows: **the
 * diagram becomes its own fence again the moment the caret enters it**, because
 * the text is the only place the diagram can be changed.
 *
 * ## Why a frame, and why that frame
 *
 * Mermaid is 3.5MB of script, and the source it reads may have been written by
 * a stranger — anyone can email `<name>@context.lc`. So it runs neither in the
 * console's bundle nor in its document. `scripts/build-drawing-editor.mjs`
 * builds `diagram-frame/entry.js` into a page of its own beside the drawing
 * editor, and each fence is drawn by that page in an `<iframe>` with
 * `sandbox="allow-scripts"` and **never `allow-same-origin`**: Mermaid runs, in
 * an opaque origin that cannot reach the console's DOM, cookies or storage, and
 * the page's own CSP refuses every request but its one script. This is the one
 * place `allow-scripts` is right where `html-preview` forbids it: there the
 * script would be the note's; here it is ours, and the note is data handed to it
 * by `postMessage`.
 *
 * ## Only where a host says so
 *
 * The frame is a page on the console's origin, so a surface with no such page —
 * the phone's `WebView` editor, whose document is `about:blank` behind a
 * `default-src 'none'` CSP — configures no `diagramHost`, and the fence stays
 * the code block it always was. An absent capability is a plain fence, never a
 * box that waits forever.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade.
 */

import { Facet, type EditorState } from "@codemirror/state";
import { WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { revealSelection } from "./engagement";
import { fenceBody, fenceTag } from "./htmlPreview";
import { selectionTouches } from "./reveal";

/** The fence tag that is drawn. Only this one: ```` ```mmd ```` is not a convention anybody shares. */
export const MERMAID_TAG = "mermaid";

/** The page that draws one diagram; built by `scripts/build-drawing-editor.mjs`. */
export const DIAGRAM_FRAME_PATH = "/drawing-assets/diagram/index.html";

/** The `channel` every message to and from the frame carries; see `diagram-frame/entry.js`. */
export const DIAGRAM_CHANNEL = "context-diagram";

/** What a surface that can draw diagrams provides: where the frame page is. */
export interface DiagramHost {
  readonly frameUrl: string;
}

/**
 * The one host for the whole editor, or `null` where none was configured.
 * A facet so `decorationsFor` stays a pure function of the state — see `formHost`.
 */
export const diagramHost = Facet.define<DiagramHost, DiagramHost | null>({
  combine: (values) => values[0] ?? null,
});

export interface MermaidFence {
  readonly from: number;
  readonly to: number;
  /** The fence's body, exactly as the file holds it. */
  readonly source: string;
}

/**
 * Every ```` ```mermaid ```` fence that should be drawn right now.
 *
 * Refused, and so left as text, for the reasons `htmlPreviews` gives: a fence
 * that does not occupy whole lines (one inside a list item), one with nothing in
 * it, and one the selection touches. And refused outright where no host is
 * configured.
 */
export function mermaidFences(state: EditorState, frontEnd = 0): MermaidFence[] {
  if (state.facet(diagramHost) === null) return [];
  const found: MermaidFence[] = [];
  const selection = revealSelection(state);
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name !== "FencedCode") return;
      const fence = node.node;
      if (fenceTag(state.doc, fence) !== MERMAID_TAG) return false;
      if (
        state.doc.lineAt(fence.from).from !== fence.from ||
        state.doc.lineAt(fence.to).to !== fence.to
      ) {
        return false;
      }
      if (selectionTouches({ from: fence.from, to: fence.to }, selection)) return false;
      const source = fenceBody(state.doc, fence);
      if (source.trim() === "") return false;
      found.push({ from: fence.from, to: fence.to, source });
      return false;
    },
  });
  return found;
}

/* ------------------------------- the frame -------------------------------- */

/** The tallest a diagram may report itself, in CSS pixels; anything above is clipped. */
export const DIAGRAM_MAX_HEIGHT = 4000;

/** How long a frame has to say it is alive before the fence is shown as text: long enough for a first, uncached 1MB (gzipped) load on a slow phone connection. */
const READY_TIMEOUT_MS = 20_000;

/**
 * Heights diagrams last drew at, by source. A diagram is redrawn from scratch
 * every time the caret leaves it, and starting the new frame at the old height
 * is what keeps the note below it from jumping twice.
 */
const lastHeights = new Map<string, number>();

/** A message from a frame, accepted only if it is exactly one of the three shapes. */
export type FrameMessage =
  | { type: "ready" }
  | { type: "rendered"; height: number }
  | { type: "error"; message: string };

/**
 * Read a message that claims to come from a diagram frame.
 *
 * The caller has already checked that it came from *its* frame's window; this
 * checks the shape, because that window runs Mermaid on a stranger's text, and
 * the console takes nothing from it but a clamped number or a short string.
 */
export function readFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as { channel?: unknown; type?: unknown; height?: unknown; message?: unknown };
  if (message.channel !== DIAGRAM_CHANNEL) return null;
  if (message.type === "ready") return { type: "ready" };
  if (message.type === "rendered") {
    if (typeof message.height !== "number" || !Number.isFinite(message.height)) return null;
    return { type: "rendered", height: Math.min(DIAGRAM_MAX_HEIGHT, Math.max(0, Math.ceil(message.height))) };
  }
  if (message.type === "error") {
    const text = typeof message.message === "string" ? message.message : "";
    // Mermaid's parse errors run to several lines of caret art; the first says what is wrong.
    const first = text.split("\n").find((line) => line.trim() !== "") ?? "";
    return { type: "error", message: first.trim().slice(0, 200) };
  }
  return null;
}

/** The palette a diagram is drawn in, read off the editor's own `--lp-*` tokens. */
export interface DiagramTheme {
  readonly dark: boolean;
  readonly colorScheme: string;
  readonly background: string;
  readonly raised: string;
  readonly text: string;
  readonly muted: string;
  readonly line: string;
  readonly fontFamily: string;
}

/** Whether a `#rrggbb` ground is dark. Anything unreadable counts as light. */
export function isDarkGround(color: string): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex === null) return false;
  const value = parseInt(hex[1]!, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

/*
  No fallback colours here: a token the editor did not declare is sent empty,
  and the frame leaves that variable to Mermaid's own theme.
*/
function themeFor(element: HTMLElement): DiagramTheme {
  const style = getComputedStyle(element);
  const token = (name: string): string => style.getPropertyValue(name).trim();
  const background = token("--lp-bg");
  return {
    dark: isDarkGround(background),
    colorScheme: style.colorScheme || "normal",
    background,
    raised: token("--lp-raised"),
    text: token("--lp-content"),
    muted: token("--lp-muted"),
    line: token("--lp-line-strong"),
    fontFamily: "system-ui, -apple-system, sans-serif",
  };
}

/**
 * Every diagram on screen, so a palette change can redraw them in the new ink.
 * The editor's colours change by rewriting one stylesheet, not by rebuilding the
 * editor, so nothing else would tell a frame the note just went dark.
 */
const liveFrames = new Set<() => void>();

/*
  Keyed by the DOM rather than held on the widget: when an equal widget replaces
  this one, CodeMirror keeps the old DOM and later calls `destroy` on the *new*
  instance, so per-instance state would never be torn down.
*/
const teardowns = new WeakMap<HTMLElement, () => void>();

/** Redraw every diagram on screen in the current palette. Called by the web editor when it changes. */
export function redrawDiagrams(): void {
  for (const redraw of liveFrames) redraw();
}

/**
 * One diagram, drawn by the sandboxed frame.
 *
 * Until the frame reports a drawing the block holds the height the diagram last
 * had (or nothing), and the frame itself is laid out but invisible — Mermaid
 * measures its labels, and a `display: none` frame measures every one as zero.
 * If the frame says the source is wrong, or never answers (offline, a blocked
 * page), the fence is shown as the text it is, with Mermaid's complaint under it
 * when there is one: a diagram that cannot be drawn is still a note somebody can
 * read and fix.
 *
 * `pointer-events: none` on the frame, for the reason `HtmlPreviewWidget`
 * gives: a click has to reach the editor to place the caret, which is what
 * brings the source back.
 */
export class MermaidWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly frameUrl: string,
  ) {
    super();
  }

  /* Compared on the source: a widget that reported itself new on every keystroke would reload its frame each time. */
  eq(other: MermaidWidget): boolean {
    return other.source === this.source && other.frameUrl === this.frameUrl;
  }

  get estimatedHeight(): number {
    return lastHeights.get(this.source) ?? -1;
  }

  toDOM(): HTMLElement {
    const source = this.source;
    // Spaced by the block's padding, never a margin — see `BLOCK_WIDGET_ROOTS`.
    const block = document.createElement("div");
    block.className = "cm-lp-diagram-block";
    const known = lastHeights.get(source);
    if (known !== undefined) block.style.minHeight = `${known}px`;

    const frame = document.createElement("iframe");
    frame.className = "cm-lp-diagram-frame";
    /*
      `allow-scripts` and nothing else. Never `allow-same-origin`: with both, the
      frame would be the console's origin running Mermaid on a stranger's text,
      able to reach `parent.document` and remove this attribute.
    */
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("title", "Diagram");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("src", this.frameUrl);
    block.append(frame);

    let settled = false;
    const showSource = (complaint: string | null): void => {
      settled = true;
      frame.remove();
      block.style.minHeight = "";
      const text = document.createElement("pre");
      text.className = "cm-lp-diagram-source";
      text.textContent = source;
      block.append(text);
      if (complaint !== null) {
        const note = document.createElement("div");
        note.className = "cm-lp-diagram-note";
        note.textContent = complaint === "" ? "This diagram could not be drawn." : `This diagram could not be drawn: ${complaint}`;
        block.append(note);
      }
    };

    const render = (): void => {
      frame.contentWindow?.postMessage(
        { channel: DIAGRAM_CHANNEL, type: "render", source, theme: themeFor(block) },
        "*",
      );
    };

    const onMessage = (event: MessageEvent): void => {
      // The window is the check: the frame's origin is opaque, so there is no origin to compare.
      if (event.source !== frame.contentWindow || frame.contentWindow === null) return;
      const message = readFrameMessage(event.data);
      if (message === null) return;
      if (message.type === "ready") {
        clearTimeout(timer);
        render();
      } else if (message.type === "rendered") {
        settled = true;
        lastHeights.set(source, message.height);
        frame.style.height = `${message.height}px`;
        frame.classList.add("cm-lp-diagram-drawn");
        block.style.minHeight = "";
      } else if (!settled) {
        showSource(message.message);
      }
    };

    const timer = setTimeout(() => {
      if (!settled) showSource(null);
    }, READY_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    const redraw = (): void => {
      if (frame.isConnected) render();
    };
    liveFrames.add(redraw);
    teardowns.set(block, () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      liveFrames.delete(redraw);
    });
    return block;
  }

  destroy(dom: HTMLElement): void {
    teardowns.get(dom)?.();
    teardowns.delete(dom);
  }

  /* A click on the diagram should place the caret, which is what reveals it. */
  ignoreEvent(): boolean {
    return false;
  }
}
