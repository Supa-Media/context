import type { EditorView } from "@codemirror/view";

/**
 * The `#tag` the pointer is on, read the way a link is: off the drawn element
 * (`.cm-lp-tag`, which live preview leaves off a tag the caret is in, so a
 * tag being edited takes clicks as text), then its words off the document.
 */
export function tagUnder(view: EditorView, under: EventTarget | null): { from: number; to: number; tag: string } | null {
  const element =
    under instanceof Element ? under : under instanceof Node ? under.parentElement : null;
  const drawn = element?.closest(".cm-lp-tag") ?? null;
  if (drawn === null || !view.contentDOM.contains(drawn)) return null;
  const from = view.posAtDOM(drawn, 0);
  const tag = /^#([\p{L}\p{N}_\-/]+)/u.exec(view.state.doc.sliceString(from, from + 200))?.[1]?.replace(/\/+$/, "");
  return tag === undefined || tag === "" ? null : { from, to: from + 1 + tag.length, tag };
}
