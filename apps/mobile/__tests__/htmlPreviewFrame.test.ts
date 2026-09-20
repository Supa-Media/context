/**
 * @jest-environment jsdom
 */

/**
 * THE FRAME A RENDERED `html-preview` FENCE IS DRAWN IN, AND THE ONE ATTRIBUTE
 * THAT MAKES IT SAFE.
 *
 * **Anyone can email `<name>@context.lc`.** That is the ingestion design rather
 * than a gap in it, so a note the console renders may have been written by a
 * stranger — and the console holds a live authenticated Convex connection. The
 * threat was never HTML or CSS. It is script execution inside that session.
 *
 * The mitigation is a `sandbox` attribute with an empty value, which denies
 * everything the frame could otherwise do. Not a sanitizer: filtering tags and
 * attributes ourselves is a list to maintain against everybody who has ever got
 * past one, and it buys nothing the browser is not already giving for free. So
 * this file asserts on the attribute, because the attribute *is* the security
 * model.
 *
 * ## What a green run here does and does not prove
 *
 * It proves the markup the console builds is the markup that was intended. It
 * does **not** prove a script fails to run: **jsdom does not enforce iframe
 * sandboxing at all** — it does not even load `srcdoc` — so a jsdom test
 * asserting "the script did not execute" would pass with `allow-scripts` set
 * and would be a false green of exactly the kind this repository keeps
 * producing. The execution case is in `e2e/webkit/htmlPreview.spec.ts`, against
 * a real engine.
 *
 * Under jsdom rather than in `livePreview.test.ts` because this is the one part
 * of that module that touches the DOM; everything else there is a pure function
 * over a document and a tree, and runs in plain node.
 */

import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import {
  decorationsFor,
  HtmlPreviewWidget,
  markdownLanguage,
  previewDocument,
} from "../features/console/files/livePreview";

const NOTE = [
  "# Map",
  "",
  "```html-preview",
  '<div class="box">drawn</div>',
  "```",
  "",
  "after",
].join("\n");

/** The preview widget the real decoration set carries, mounted. */
function frameFor(doc: string): HTMLIFrameElement {
  const state = EditorState.create({
    doc,
    extensions: [markdownLanguage()],
    selection: { anchor: doc.length },
  });
  let widget: HtmlPreviewWidget | null = null;
  decorationsFor(state).between(0, state.doc.length, (_from, _to, value) => {
    const spec = value.spec as { widget?: unknown };
    if (spec.widget instanceof HtmlPreviewWidget) widget = spec.widget;
  });
  if (widget === null) throw new Error("the note built no preview widget");
  const frame = (widget as HtmlPreviewWidget).toDOM().querySelector("iframe");
  if (frame === null) throw new Error("the preview widget built no iframe");
  return frame;
}

describe("the preview frame", () => {
  /**
   * THE GUARD.
   *
   * `allow-scripts` alone runs the note's JavaScript in an opaque origin, which
   * still reaches `fetch` and `postMessage` to the parent. `allow-scripts`
   * together with `allow-same-origin` is worse than either: a frame that is
   * both can reach `parent.document` and take its own `sandbox` attribute off.
   *
   * Sabotage-tested as `docs/decisions/testing.md` asks — adding either token
   * in `HtmlPreviewWidget.toDOM` turns this red, and it was confirmed to.
   */
  test("carries a bare sandbox: neither allow-scripts nor allow-same-origin", () => {
    const frame = frameFor(NOTE);

    // Present, and empty. `hasAttribute` rather than a truthy check, because
    // `sandbox=""` is the deny-everything value and is falsy as a string — a
    // test written the obvious way would pass with the attribute missing.
    expect(frame.hasAttribute("sandbox")).toBe(true);
    expect(frame.getAttribute("sandbox")).toBe("");

    const tokens = (frame.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
    expect(tokens).toEqual([]);
    expect(tokens).not.toContain("allow-scripts");
    expect(tokens).not.toContain("allow-same-origin");
  });

  test("is fed by srcdoc rather than by a src it would have to fetch", () => {
    const frame = frameFor(NOTE);
    expect(frame.hasAttribute("src")).toBe(false);
    expect(frame.getAttribute("srcdoc") ?? "").toContain('<div class="box">drawn</div>');
  });

  test("the markup reaches the frame unaltered — nothing sanitizes it", () => {
    // Stated as an assertion because it is the design: the browser is the
    // boundary, and a filter of ours would be a second mechanism nobody tests.
    const hostile = '<script>window.PWNED = 1</script><img src=x onerror="alert(1)">';
    const doc = ["```html-preview", hostile, "```", "", "after"].join("\n");
    expect(frameFor(doc).getAttribute("srcdoc") ?? "").toContain(hostile);
  });

  test("and the document it is fed forbids every fetch a stylesheet could make", () => {
    const built = previewDocument("<div>x</div>");
    expect(built).toContain("Content-Security-Policy");
    expect(built).toContain("default-src 'none'");
    expect(built).toContain("img-src data:");
    expect(built).not.toMatch(/(?:img|font|default)-src[^;"]*https?:/);
  });

  test("is a labelled region rather than an anonymous frame", () => {
    expect(frameFor(NOTE).getAttribute("title")).toBe("Rendered preview");
  });

  test("the widget wraps it in the element that does the clipping", () => {
    const frame = frameFor(NOTE);
    expect(frame.parentElement?.className).toBe("cm-lp-preview");
    expect(frame.className).toBe("cm-lp-preview-frame");
  });
});
