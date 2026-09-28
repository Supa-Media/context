/**
 * `:name:` in a note, drawn as the emoji it names.
 *
 * The file keeps the text — that is what makes the note readable in Obsidian
 * and on GitHub — and this draws over it: a standard shortcode as its
 * character, a workspace emoji as its picture. A name nobody answers for stays
 * text, and so does any shortcode the caret is touching, so it can be edited
 * like the rest of live preview's marks.
 *
 * Which names are workspace emoji is asked of the host one name at a time and
 * remembered for the life of the view, so a note full of `:lgtm:` asks once.
 * An `emojiRefresh` forgets the names that had no answer, which is how an
 * emoji added a moment ago starts drawing in the note that already names it.
 */

import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { findShortcodes } from "@context/shared/src/customEmoji";

import { frontmatterRange } from "../livePreview/frontmatter";
import { selectionTouches } from "../livePreview/reveal";
import { emojiHost, emojiRefresh } from "./host";
import { standardEmojiNamed } from "./standardEmoji";

/** Syntax nodes whose text is literal: a shortcode inside one is not an emoji. */
const LITERAL_NODES: ReadonlySet<string> = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "HTMLBlock",
  "HTMLTag",
  "URL",
  "Autolink",
  "Comment",
]);

/** Whether `pos` sits in code, a URL or frontmatter. */
export function inLiteral(
  state: EditorState,
  pos: number,
  front: { from: number; to: number } | null = frontmatterRange(state.doc.toString()),
): boolean {
  if (front !== null && pos >= front.from && pos <= front.to) return true;
  for (let node = syntaxTree(state).resolveInner(pos, 1); node !== null; node = node.parent) {
    if (LITERAL_NODES.has(node.name)) return true;
    if (node.parent === null) break;
  }
  return false;
}

class CharWidget extends WidgetType {
  constructor(readonly char: string, readonly name: string) {
    super();
  }
  eq(other: CharWidget): boolean {
    return other.char === this.char;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-emoji-char";
    span.textContent = this.char;
    span.title = `:${this.name}:`;
    return span;
  }
}

class PictureWidget extends WidgetType {
  constructor(readonly name: string, readonly src: string) {
    super();
  }
  eq(other: PictureWidget): boolean {
    return other.name === this.name && other.src === this.src;
  }
  toDOM(): HTMLElement {
    const img = document.createElement("img");
    img.className = "cm-emoji";
    img.src = this.src;
    img.alt = `:${this.name}:`;
    img.title = `:${this.name}:`;
    img.draggable = false;
    return img;
  }
}

/** What the host said about a name: a picture, nothing, or not yet. */
type Answer = { src: string } | null | "asking";

export function emojiInline(): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      answers = new Map<string, Answer>();
      destroyed = false;

      constructor(readonly view: EditorView) {
        this.decorations = this.build();
      }

      update(update: ViewUpdate): void {
        let refreshed = false;
        for (const transaction of update.transactions) {
          if (transaction.effects.some((effect) => effect.is(emojiRefresh))) refreshed = true;
        }
        if (refreshed) {
          for (const [name, answer] of this.answers) if (answer === null) this.answers.delete(name);
        }
        if (refreshed || update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged) {
          this.decorations = this.build();
        }
      }

      destroy(): void {
        this.destroyed = true;
      }

      ask(name: string): void {
        const host = this.view.state.facet(emojiHost)?.current ?? null;
        if (host === null) {
          this.answers.set(name, null);
          return;
        }
        this.answers.set(name, "asking");
        void host
          .load(name)
          .catch(() => null)
          .then((src) => {
            if (this.destroyed) return;
            this.answers.set(name, src === null ? null : { src });
            if (src !== null) this.view.dispatch({ effects: emojiRefresh.of(null) });
          });
      }

      build(): DecorationSet {
        const { state } = this.view;
        const builder = new RangeSetBuilder<Decoration>();
        const selection = this.view.hasFocus
          ? state.selection.ranges.map((range) => ({ from: range.from, to: range.to }))
          : [];
        const front = frontmatterRange(state.doc.toString());
        for (const { from, to } of this.view.visibleRanges) {
          const startLine = state.doc.lineAt(from).number;
          const endLine = state.doc.lineAt(to).number;
          for (let number = startLine; number <= endLine; number += 1) {
            const line = state.doc.line(number);
            for (const hit of findShortcodes(line.text)) {
              const span = { from: line.from + hit.from, to: line.from + hit.to };
              if (selectionTouches(span, selection) || inLiteral(state, span.from, front)) continue;
              const widget = this.widgetFor(hit.name);
              if (widget !== null) builder.add(span.from, span.to, Decoration.replace({ widget }));
            }
          }
        }
        return builder.finish();
      }

      widgetFor(name: string): WidgetType | null {
        const standard = standardEmojiNamed(name);
        if (standard !== undefined) return new CharWidget(standard.char, name);
        const answer = this.answers.get(name);
        if (answer === undefined) {
          this.ask(name);
          return null;
        }
        return answer === null || answer === "asking" ? null : new PictureWidget(name, answer.src);
      }
    },
    { decorations: (value) => value.decorations },
  );
  return [plugin, emojiTheme];
}

const emojiTheme = EditorView.baseTheme({
  ".cm-emoji": {
    height: "1.3em",
    width: "auto",
    maxWidth: "3em",
    verticalAlign: "-0.3em",
    objectFit: "contain",
  },
  ".cm-emoji-char": {
    fontFamily: "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif",
  },
});
