/**
 * @jest-environment jsdom
 */

/**
 * The read preview, in the editor it ships in.
 *
 * `pluginPreview.test.ts` holds the gate, the routing and the link scanner as
 * pure functions. This drives the extension against a real `EditorView`,
 * mounted through `editorExtensions` — the lesson from the crash #553 fixed,
 * where every test for a new extension built an editor nobody uses and the
 * composition failed in production instead.
 *
 * What only a mounted editor can prove: that the links are asked about without
 * anybody hovering, that a hover over a link draws the plugin's text, that a
 * hover anywhere else draws nothing, and that the tooltip is **Context's DOM
 * built from a string** rather than anything the plugin sent.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorExtensions } from "../features/console/files/editorSetup";
import {
  PREVIEW_SETTLE_MS,
  pluginLinkPreview,
  pluginPreviewTheme,
  previewDom,
  previewTooltipAt,
  type PluginPreviewRef,
} from "../features/console/files/pluginPreview";

const JOHN = "https://www.bible.com/bible/1/JHN.3.16";
const VERSE = "For God so loved the world\nJohn 3:16 NIV";

const views: EditorView[] = [];
afterEach(() => {
  while (views.length > 0) views.pop()!.destroy();
  document.body.innerHTML = "";
  jest.useRealTimers();
});

/** Past the settle debounce, then let the ask resolve. */
const settled = async () => {
  await new Promise((resolve) => setTimeout(resolve, PREVIEW_SETTLE_MS + 60));
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
};

function editor(doc: string, ref: PluginPreviewRef): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        ...editorExtensions({
          editable: true,
          editableCompartment: new Compartment(),
          handlers: { current: { onChange: () => {}, onSave: () => {} } },
        }),
        pluginLinkPreview(ref),
        pluginPreviewTheme,
      ],
    }),
  });
  views.push(view);
  return view;
}

function refWith(
  ask: (links: { href: string; text: string }[]) => Promise<{ href: string; text: string }[]>,
): PluginPreviewRef {
  return { ask, previews: new Map(), note: "1-projects/john-3.md" };
}

describe("the note's links are asked about without anybody hovering", () => {
  test("a note with an external link asks once it settles", async () => {
    const asked: { href: string; text: string }[][] = [];
    const ref = refWith(async (links) => {
      asked.push(links);
      return [{ href: JOHN, text: VERSE }];
    });
    editor(`see [John 3:16](${JOHN}) now`, ref);
    await settled();
    expect(asked).toEqual([[{ href: JOHN, text: "John 3:16" }]]);
    expect(ref.previews.get(JOHN)).toBe(VERSE);
  });

  test("a note with no external link asks nothing at all", async () => {
    const asked: unknown[] = [];
    const ref = refWith(async (links) => {
      asked.push(links);
      return [];
    });
    editor("just prose, and a [[wiki link]]", ref);
    await settled();
    expect(asked).toEqual([]);
  });

  /*
    The demo console and the native guest hand no `ask` at all, and the console
    hands none until the runtime query answers. The extension is installed
    either way — the crash's other lesson — so it has to be inert rather than
    throwing when there is nobody to ask.
  */
  test("with nobody to ask, the editor still opens and nothing happens", async () => {
    const ref: PluginPreviewRef = { previews: new Map(), note: "1-projects/john-3.md" };
    const view = editor(`see [John 3:16](${JOHN})`, ref);
    await settled();
    expect(view.state.doc.toString()).toBe(`see [John 3:16](${JOHN})`);
    expect(ref.previews.size).toBe(0);
  });

  /*
    A plugin enabled while the note is open. The same fact the suggestion source
    had to be fixed for, on the read side — and it works here for the same
    reason: the extension reads `ref.ask` when it runs rather than holding the
    one it was built with.
  */
  test("a plugin enabled after the note was open is asked on the next edit", async () => {
    const ref: PluginPreviewRef = { previews: new Map(), note: "1-projects/john-3.md" };
    const view = editor(`see [John 3:16](${JOHN})`, ref);
    await settled();
    expect(ref.previews.size).toBe(0);

    ref.ask = async () => [{ href: JOHN, text: VERSE }];
    view.dispatch({ changes: { from: view.state.doc.length, insert: " now" } });
    await settled();
    expect(ref.previews.get(JOHN)).toBe(VERSE);
  });

  /*
    The note the reader closed. The editor is rebuilt per note, but the ref
    survives long enough for an answer to land after the generation moved, and
    an identical link in the next note would then wear the last note's verse.
  */
  test("an answer that lands after the reader opened another note is thrown away", async () => {
    let release: (value: { href: string; text: string }[]) => void = () => {};
    const ref = refWith(() => new Promise((resolve) => { release = resolve; }));
    editor(`see [John 3:16](${JOHN})`, ref);
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_SETTLE_MS + 60));
    // What `LiveEditor.web.tsx` assigns on the render that swaps the document.
    ref.note = "1-projects/romans-8.md";
    release([{ href: JOHN, text: VERSE }]);
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    expect(ref.previews.size).toBe(0);
  });

  /*
    And the other half of the same fact, which is the one the counter version
    could not have: opening a different note re-asks even when its links are
    identical, because the answer is about that note's links in that note.
  */
  test("another note with the same link is asked about again", async () => {
    const asked: string[] = [];
    const ref = refWith(async () => {
      asked.push(ref.note ?? "");
      return [{ href: JOHN, text: VERSE }];
    });
    const view = editor(`see [John 3:16](${JOHN})`, ref);
    await settled();
    expect(asked).toEqual(["1-projects/john-3.md"]);

    ref.note = "1-projects/romans-8.md";
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: `also [John 3:16](${JOHN})` } });
    await settled();
    expect(asked).toEqual(["1-projects/john-3.md", "1-projects/romans-8.md"]);
  });
});

/* -------------------------------------------------------------------------- */

/*
  WHAT THE READER SEES, AND WHAT THEY CANNOT BE MADE TO SEE.

  The tooltip is built by `previewDom` from a string. A plugin that reports
  markup reports those characters, and a reader sees those characters — which
  is the entire reason the wire carries text instead of elements.
*/
describe("the tooltip is Context's, built from the plugin's string", () => {
  /** Where the caret sits inside `[John 3:16](…)` in the fixture below. */
  const INSIDE_LINK = 8;
  const DOC = `see [John 3:16](${JOHN}) now`;

  test("hovering the link offers the plugin's text over the whole link", async () => {
    const ref = refWith(async () => [{ href: JOHN, text: VERSE }]);
    const view = editor(DOC, ref);
    await settled();
    const tooltip = previewTooltipAt(ref, view.state, INSIDE_LINK);
    expect(tooltip).not.toBeNull();
    expect(tooltip!.pos).toBe(4);
    expect(tooltip!.end).toBe(4 + `[John 3:16](${JOHN})`.length);
    expect(tooltip!.create(view).dom.textContent).toBe("For God so loved the worldJohn 3:16 NIV");
  });

  test("hovering the prose beside it offers nothing", async () => {
    const ref = refWith(async () => [{ href: JOHN, text: VERSE }]);
    const view = editor(DOC, ref);
    await settled();
    expect(previewTooltipAt(ref, view.state, 1)).toBeNull();
  });

  test("a link no plugin previewed has no tooltip, rather than an empty one", async () => {
    const ref = refWith(async () => []);
    const view = editor(DOC, ref);
    await settled();
    expect(previewTooltipAt(ref, view.state, INSIDE_LINK)).toBeNull();
  });

  /*
    THE GUARD THIS PAIR IS MOST WORTH WRITING FOR.

    The string came out of a sandbox. `previewDom` puts it in `textContent`, one
    element per line, and never parses it — which is the entire reason the wire
    carries text instead of elements. A plugin that reports markup gets its
    characters drawn.
  */
  test("markup in a preview is drawn as characters, never as elements", () => {
    const dom = previewDom('<img src=x onerror="alert(1)">');
    expect(dom.querySelector("img")).toBeNull();
    expect(dom.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  test("a multi-line preview keeps the plugin's own lines, one element each", () => {
    const dom = previewDom(VERSE);
    expect([...dom.children].map((one) => one.textContent)).toEqual([
      "For God so loved the world",
      "John 3:16 NIV",
    ]);
  });
});
