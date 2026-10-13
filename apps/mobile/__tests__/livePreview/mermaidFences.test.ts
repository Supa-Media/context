/**
 * @jest-environment jsdom
 */
import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { decorationsFor, markdownLanguage } from "../../features/console/files/livePreview";
import {
  DIAGRAM_CHANNEL,
  DIAGRAM_FRAME_PATH,
  DIAGRAM_MAX_HEIGHT,
  MermaidWidget,
  diagramHost,
  isDarkGround,
  mermaidFences,
  readFrameMessage,
  redrawDiagrams,
} from "../../features/console/files/livePreview/diagram";

/**
 * ```` ```mermaid ```` FENCES ARE DRAWN AS DIAGRAMS, BY A FRAME THAT CANNOT
 * REACH THE CONSOLE.
 *
 * What jsdom can prove is here: which fences are drawn, that the caret gets the
 * source back, that a surface with no frame page leaves the fence alone, the
 * sandbox attribute, and that the console takes nothing from a frame but a
 * clamped height or a short complaint. That Mermaid really draws inside the
 * sandbox, under its CSP, is `e2e/webkit/mermaid.spec.ts`'s — jsdom loads no
 * frames.
 */

const HOST = { frameUrl: DIAGRAM_FRAME_PATH };

function stateFor(doc: string, cursor: number, host: typeof HOST | null = HOST): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor: Math.max(0, Math.min(cursor, doc.length)) },
    extensions: [markdownLanguage(), ...(host === null ? [] : [diagramHost.of(host)])],
  });
  if (ensureSyntaxTree(state, state.doc.length, 10_000) === null) throw new Error("did not parse");
  return state.update({}).state;
}

const CHART = ["# Org", "", "```mermaid", "flowchart TD", "  A --> B", "```", "", "after"].join("\n");

function widgetsIn(state: EditorState): MermaidWidget[] {
  const found: MermaidWidget[] = [];
  decorationsFor(state).between(0, state.doc.length, (_from, _to, value) => {
    const spec = value.spec as { widget?: unknown };
    if (spec.widget instanceof MermaidWidget) found.push(spec.widget);
  });
  return found;
}

describe("which mermaid fences are drawn", () => {
  test("the fence's body is what gets drawn, without its fence lines", () => {
    const fences = mermaidFences(stateFor(CHART, 10_000));
    expect(fences).toHaveLength(1);
    expect(fences[0]!.source).toBe("flowchart TD\n  A --> B");
    expect(widgetsIn(stateFor(CHART, 10_000))).toHaveLength(1);
  });

  test("the tag decides, case-insensitively, and nothing else is a diagram", () => {
    const fence = (tag: string) => ["```" + tag, "graph LR", "  a --> b", "```", "", "after"].join("\n");
    expect(mermaidFences(stateFor(fence("Mermaid"), 10_000))).toHaveLength(1);
    for (const tag of ["", "mmd", "mermaid-js", "js", "html-preview"]) {
      expect(mermaidFences(stateFor(fence(tag), 10_000))).toEqual([]);
    }
  });

  test("a surface with no frame page leaves the fence a code block", () => {
    // The phone's WebView editor: no host, so no widget that would wait forever.
    const state = stateFor(CHART, 10_000, null);
    expect(mermaidFences(state)).toEqual([]);
    expect(widgetsIn(state)).toEqual([]);
  });

  test("the caret entering the fence gives the source back", () => {
    const inside = CHART.indexOf("A --> B");
    expect(mermaidFences(stateFor(CHART, inside))).toEqual([]);
    expect(widgetsIn(stateFor(CHART, inside))).toEqual([]);
    // And on either boundary, which `selectionTouches` counts as inside.
    expect(mermaidFences(stateFor(CHART, CHART.indexOf("```mermaid")))).toEqual([]);
  });

  test("a fence inside a list item, or an empty one, stays text", () => {
    const nested = ["- item", "  ```mermaid", "  graph LR", "  ```", "", "after"].join("\n");
    expect(mermaidFences(stateFor(nested, 10_000))).toEqual([]);
    const empty = ["```mermaid", "   ", "```", "", "after"].join("\n");
    expect(mermaidFences(stateFor(empty, 10_000))).toEqual([]);
  });

  test("nothing else is decorated inside the range the diagram replaces", () => {
    const state = stateFor(CHART, 10_000);
    const fence = mermaidFences(state)[0]!;
    const inside: string[] = [];
    decorationsFor(state).between(fence.from, fence.to, (from, _to, value) => {
      const spec = value.spec as { class?: string; widget?: unknown };
      if (spec.widget instanceof MermaidWidget) return;
      if (from >= fence.from && from < fence.to) inside.push(spec.class ?? "replace");
    });
    expect(inside).toEqual([]);
  });
});

describe("what the console accepts from a frame", () => {
  const msg = (body: object) => ({ channel: DIAGRAM_CHANNEL, ...body });

  test("only the three shapes, on the right channel", () => {
    expect(readFrameMessage(msg({ type: "ready" }))).toEqual({ type: "ready" });
    expect(readFrameMessage({ type: "ready" })).toBeNull();
    expect(readFrameMessage(msg({ type: "navigate", to: "https://evil.example" }))).toBeNull();
    expect(readFrameMessage("ready")).toBeNull();
    expect(readFrameMessage(null)).toBeNull();
  });

  test("a height is a finite number, clamped", () => {
    expect(readFrameMessage(msg({ type: "rendered", height: 312.2 }))).toEqual({ type: "rendered", height: 313 });
    expect(readFrameMessage(msg({ type: "rendered", height: 1e9 }))).toEqual({
      type: "rendered",
      height: DIAGRAM_MAX_HEIGHT,
    });
    expect(readFrameMessage(msg({ type: "rendered", height: -5 }))).toEqual({ type: "rendered", height: 0 });
    expect(readFrameMessage(msg({ type: "rendered", height: "300px" }))).toBeNull();
    expect(readFrameMessage(msg({ type: "rendered", height: Number.NaN }))).toBeNull();
  });

  test("an error is one short line of text", () => {
    const long = `Parse error on line 2:\n...A -->\n-----^\n${"x".repeat(500)}`;
    expect(readFrameMessage(msg({ type: "error", message: long }))).toEqual({
      type: "error",
      message: "Parse error on line 2:",
    });
    expect(readFrameMessage(msg({ type: "error", message: "y".repeat(500) }))!).toEqual({
      type: "error",
      message: "y".repeat(200),
    });
    expect(readFrameMessage(msg({ type: "error", message: { html: "<b>" } }))).toEqual({ type: "error", message: "" });
  });

  test("a dark ground is told from a light one", () => {
    expect(isDarkGround("#191715")).toBe(true);
    expect(isDarkGround("#FFFDF9")).toBe(false);
    expect(isDarkGround("rgb(0,0,0)")).toBe(false);
  });
});

describe("the frame", () => {
  test("is sandboxed with scripts and never with the console's origin", () => {
    const dom = new MermaidWidget("graph LR\n a-->b", DIAGRAM_FRAME_PATH).toDOM();
    const frame = dom.querySelector("iframe")!;
    expect(dom.className).toBe("cm-lp-diagram-block");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe(DIAGRAM_FRAME_PATH);
  });

  /** Mount a widget and hand back its block and a way to speak as its frame. */
  function mounted(source = "graph LR\n a-->b") {
    const widget = new MermaidWidget(source, DIAGRAM_FRAME_PATH);
    const dom = widget.toDOM();
    document.body.append(dom);
    const frame = dom.querySelector("iframe")!;
    const sent: unknown[] = [];
    const frameWindow = frame.contentWindow!;
    frameWindow.postMessage = ((data: unknown) => sent.push(data)) as typeof frameWindow.postMessage;
    const say = (data: object, source: unknown = frameWindow) =>
      window.dispatchEvent(new MessageEvent("message", { data: { channel: DIAGRAM_CHANNEL, ...data }, source: source as Window }));
    return { widget, dom, frame, sent, say };
  }

  test("answers ready with the source, and sizes itself to what the frame drew", () => {
    const { widget, dom, frame, sent, say } = mounted();
    say({ type: "ready" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: DIAGRAM_CHANNEL, type: "render", source: "graph LR\n a-->b" });
    say({ type: "rendered", height: 240 });
    expect(frame.style.height).toBe("240px");
    expect(frame.classList.contains("cm-lp-diagram-drawn")).toBe(true);
    // A palette change redraws it.
    redrawDiagrams();
    expect(sent).toHaveLength(2);
    widget.destroy(dom);
    redrawDiagrams();
    expect(sent).toHaveLength(2);
    dom.remove();
  });

  test("ignores a message from any window but its own frame", () => {
    const { widget, dom, frame, sent, say } = mounted();
    say({ type: "ready" }, window);
    say({ type: "rendered", height: 999 }, window);
    expect(sent).toEqual([]);
    expect(frame.style.height).toBe("");
    widget.destroy(dom);
    dom.remove();
  });

  test("a source Mermaid refuses is shown as text, with why", () => {
    const { widget, dom, say } = mounted("flowchart TD\n  A -->");
    say({ type: "error", message: "Parse error on line 2:\n..." });
    expect(dom.querySelector("iframe")).toBeNull();
    expect(dom.querySelector(".cm-lp-diagram-source")!.textContent).toBe("flowchart TD\n  A -->");
    expect(dom.querySelector(".cm-lp-diagram-note")!.textContent).toBe(
      "This diagram could not be drawn: Parse error on line 2:",
    );
    widget.destroy(dom);
    dom.remove();
  });

  test("a frame that never answers falls back to the source", () => {
    jest.useFakeTimers();
    try {
      const { widget, dom } = mounted();
      jest.advanceTimersByTime(20_000);
      expect(dom.querySelector("iframe")).toBeNull();
      expect(dom.querySelector(".cm-lp-diagram-source")).not.toBeNull();
      expect(dom.querySelector(".cm-lp-diagram-note")).toBeNull();
      widget.destroy(dom);
      dom.remove();
    } finally {
      jest.useRealTimers();
    }
  });
});
