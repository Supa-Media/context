/**
 * @jest-environment jsdom
 */

/**
 * Comments on a phone (`files/comments/sheet.ts`): a thread opens in a bottom
 * sheet, a visitor reads it and is offered sign-in, and a selection offers a
 * floating Comment chip that opens the same sheet with an empty composer.
 *
 * jsdom lays nothing out, so every pane here is zero pixels wide, which is a
 * phone as far as `hasMargin` is concerned. The wide case stubs the width.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { parseComments } from "@context/shared/src/comments.cjs";
import { comments, commentUi, setActiveThread } from "../features/console/files/comments/extension";
import { commentRail } from "../features/console/files/comments/rail";
import { commentSheet, type SheetPlacement } from "../features/console/files/comments/sheet";
import { commentStyles } from "../features/console/files/comments/styles";
import { hasMargin, quoteLabel } from "../features/console/files/comments/model";
import { darkColors } from "../features/design/tokens";

const NOTE = [
  "# Pricing",
  "",
  "It is <!--c:k7f2-->free, you cheapo<!--/c:k7f2--> for now.",
  "",
  "```comments",
  'k7f2 "free, you cheapo"',
  "- 2026-09-27T07:30:12Z @maya's Codex: hey, this seems a little unprofessional.",
  "- 2026-09-27T07:31:40Z @jon: eh, I don't really care",
  "```",
  "",
].join("\n");

const RESOLVED = NOTE.replace("```\n", "- 2026-09-27T07:31:45Z @jon resolved\n```\n");

let views: EditorView[] = [];
afterEach(() => {
  for (const view of views) view.destroy();
  views = [];
  document.body.replaceChildren();
});

function mount(
  doc: string,
  options: { author?: string | null; signIn?: () => void; placement?: SheetPlacement; editable?: boolean } = {},
) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const { author = "@dev2", signIn, placement = "viewport", editable = true } = options;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        EditorState.readOnly.of(!editable),
        comments({ author: () => author, signIn: () => signIn }),
        commentRail,
        commentSheet({ placement }),
      ],
    }),
  });
  views.push(view);
  const open = (id: string | null) => view.dispatch({ effects: setActiveThread.of(id) });
  const layer = () => document.querySelector<HTMLElement>(".cm-cmt-sheet-layer")!;
  const chip = () => view.scrollDOM.querySelector<HTMLButtonElement>(".cm-cmt-float")!;
  return { view, open, layer, chip };
}

describe("the thread sheet", () => {
  test("tapping the highlight opens the thread: quote, messages with author and time, and a reply field", () => {
    const { view, layer } = mount(NOTE);
    expect(layer().hidden).toBe(true);
    const mark = view.contentDOM.querySelector<HTMLElement>("[data-comment='k7f2']")!;
    mark.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(view.state.field(commentUi).active).toBe("k7f2");
    expect(layer().hidden).toBe(false);
    expect(layer().querySelector(".cm-cmt-sheet-title")!.textContent).toBe("On “free, you cheapo”");
    const who = [...layer().querySelectorAll(".cm-cmt-who b")].map((node) => node.textContent);
    expect(who).toEqual(["@maya's Codex", "@jon"]);
    expect(layer().querySelectorAll(".cm-cmt-when")).toHaveLength(2);
    expect(layer().querySelector("textarea")!.placeholder).toBe("Reply…");
    // No margin on a phone: the rail draws no cards, so a thread is never shown twice.
    expect(view.scrollDOM.querySelectorAll(".cm-cmt-card")).toHaveLength(0);
  });

  test("it lives on the page, outside the note, so typing a reply is not typing in the note", () => {
    const { view, open, layer } = mount(NOTE);
    open("k7f2");
    expect(view.dom.contains(layer())).toBe(false);
    expect(layer().parentElement).toBe(document.body);
  });

  test("a reply is appended to the file, and resolving marks the thread resolved", () => {
    const { view, open, layer } = mount(NOTE);
    open("k7f2");
    const input = layer().querySelector("textarea")!;
    input.value = "ok, toned down";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const thread = parseComments(view.state.doc.toString()).threads[0]!;
    expect(thread.events.at(-1)).toMatchObject({ author: "@dev2", text: "ok, toned down" });
    const resolve = [...layer().querySelectorAll("button")].find((node) => node.textContent === "Resolve")!;
    resolve.click();
    expect(parseComments(view.state.doc.toString()).threads[0]!.status).toBe("resolved");
  });

  test("a resolved thread says so, and keeps its history", () => {
    const { open, layer } = mount(RESOLVED);
    open("k7f2");
    expect(layer().querySelector(".cm-cmt-badge")!.textContent).toBe("Resolved");
    expect(layer().querySelector(".cm-cmt-resolved")!.textContent).toContain("Resolved by @jon");
    expect(layer().querySelectorAll(".cm-cmt-msg")).toHaveLength(2);
    expect(layer().querySelector("textarea")).toBeNull();
  });

  test("a visitor reads the thread, and the field says Sign in to reply", () => {
    const signIn = jest.fn();
    const { open, layer } = mount(NOTE, { author: null, signIn });
    open("k7f2");
    expect(layer().querySelectorAll(".cm-cmt-msg")).toHaveLength(2);
    expect(layer().querySelector("textarea")).toBeNull();
    const field = layer().querySelector<HTMLButtonElement>(".cm-cmt-signin")!;
    expect(field.textContent).toBe("Sign in to reply");
    field.click();
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  test("a signed-in reader who may not write gets no field and no sign-in", () => {
    const { open, layer } = mount(NOTE, { editable: false });
    open("k7f2");
    expect(layer().querySelector("textarea")).toBeNull();
    expect(layer().querySelector(".cm-cmt-signin")).toBeNull();
  });

  test("the scrim and the close button dismiss it without touching the file", () => {
    const { view, open, layer } = mount(NOTE);
    open("k7f2");
    layer().querySelector<HTMLElement>(".cm-cmt-scrim")!.click();
    expect(view.state.field(commentUi).active).toBeNull();
    expect(layer().hidden).toBe(true);
    open("k7f2");
    layer().querySelector<HTMLButtonElement>(".cm-cmt-close")!.click();
    expect(layer().hidden).toBe(true);
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  test("in the iOS web view it opens inside the note, under its line", () => {
    const { view, open, layer } = mount(NOTE, { placement: "inline" });
    open("k7f2");
    expect(view.scrollDOM.contains(layer())).toBe(true);
    expect(layer().querySelector(".cm-cmt-scrim")).toBeNull();
  });

  test("a pane wide enough for the margin shows cards there and no sheet", () => {
    const width = jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
    try {
      const { view, open, layer } = mount(NOTE);
      open("k7f2");
      expect(layer().hidden).toBe(true);
      expect(view.scrollDOM.querySelectorAll(".cm-cmt-card").length).toBeGreaterThan(0);
    } finally {
      width.mockRestore();
    }
  });
});

describe("starting a comment on a phone", () => {
  test("selecting words shows a Comment chip; tapping it opens the sheet with an empty composer", () => {
    const { view, chip, layer } = mount(NOTE);
    expect(chip().hidden).toBe(true);
    const from = view.state.doc.toString().indexOf("# Pricing") + 2;
    view.dispatch({ selection: { anchor: from, head: from + "Pricing".length } });
    expect(chip().hidden).toBe(false);
    expect(chip().textContent).toBe("Comment");

    chip().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    // The tap can collapse the selection before the click lands; the chip remembers.
    view.dispatch({ selection: { anchor: from } });
    chip().click();
    expect(layer().hidden).toBe(false);
    expect(chip().hidden).toBe(true);
    expect(layer().querySelector(".cm-cmt-sheet-title")!.textContent).toBe("On “Pricing”");
    const input = layer().querySelector("textarea")!;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Add a comment…");

    input.value = "call it Plans?";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const threads = parseComments(view.state.doc.toString()).threads;
    expect(threads.map((thread) => thread.quote)).toEqual(["free, you cheapo", "Pricing"]);
    expect(threads[1]!.events[0]).toMatchObject({ author: "@dev2", text: "call it Plans?" });
  });

  test("no chip for somebody who cannot comment, or for whitespace", () => {
    const visitor = mount(NOTE, { author: null, signIn: () => {} });
    visitor.view.dispatch({ selection: { anchor: 2, head: 9 } });
    expect(visitor.chip().hidden).toBe(true);

    const writer = mount(NOTE);
    const blank = NOTE.indexOf("\n\n");
    writer.view.dispatch({ selection: { anchor: blank, head: blank + 2 } });
    expect(writer.chip().hidden).toBe(true);
  });
});

describe("the sheet's rules", () => {
  test("phones have no margin; a desktop pane does", () => {
    expect(hasMargin(390)).toBe(false);
    expect(hasMargin(779)).toBe(false);
    expect(hasMargin(780)).toBe(true);
  });

  test("a long quote is cut at a word, on one line", () => {
    expect(quoteLabel("free,\n  you cheapo")).toBe("free, you cheapo");
    const long = "Empty 0-inbox, move anything that has become work into 1-projects and the rest into areas";
    const label = quoteLabel(long);
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(61);
    expect(long.startsWith(label.slice(0, -1))).toBe(true);
  });

  test("every comment field on a phone is at least 16px, so iOS does not zoom on focus", () => {
    const css = commentStyles(darkColors, "system-ui");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
    const sheetFields = rules.filter((rule) => rule.selector.includes(".cm-cmt-sheet .cm-cmt-input"));
    expect(sheetFields).toHaveLength(1);
    expect(sheetFields[0]!.body).toMatch(/font-size:\s*16px/);
    expect(sheetFields[0]!.selector).toContain(".cm-cmt-signin");
    // The margin's field, on a touch screen wide enough for a margin (a tablet).
    expect(css).toMatch(/@media \(pointer: coarse\) \{ \.cm-cmt-input \{ font-size: 16px; \} \}/);
  });
});
