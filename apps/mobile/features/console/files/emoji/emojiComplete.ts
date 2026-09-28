/**
 * Typing `:` and a name offers the emoji it could mean.
 *
 * What the menu holds, in order: this workspace's own emoji, then standard
 * ones, then — for someone who may add emoji — "Search Slackmojis" and "Add a
 * custom emoji…". When nothing here matches it asks Slackmojis (through our
 * server) and offers what comes back, each one added to the workspace and put
 * in the note in one press.
 *
 * It opens only after `:` and two characters, and only where a shortcode
 * could start (after a space, a bracket or the start of the line), so `10:30`,
 * `http://` and a YAML key never raise it. Code, URLs and frontmatter never do.
 *
 * What it writes: a standard emoji as the character itself, and a workspace
 * emoji as `:name:` — see `docs/decisions/app-and-console/custom-emoji.md`.
 */

import {
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { customEmojiNameFrom } from "@context/shared/src/customEmoji";

import { emojiHost, type EmojiHostContext, type SlackmojiResult } from "./host";
import { inLiteral } from "./emojiInline";
import { searchStandardEmoji, standardEmojiNamed } from "./standardEmoji";

/** How many emoji the menu lists before its actions. */
const MENU_SIZE = 8;
/** How long typing must pause before Slackmojis is asked. */
const SLACKMOJIS_PAUSE_MS = 300;

/**
 * The `:query` a caret is at the end of, if it is at the end of one.
 *
 * Pure over the text before the caret, and exported for its test: what makes
 * it right is what it refuses — a colon glued to a word (`10:30`, `http:`),
 * one character, a space.
 */
export function openShortcode(before: string): { query: string; from: number } | null {
  const match = /(?:^|[\s([{"'>*_~])(:([a-z0-9_+-]{2,64}))$/i.exec(before);
  if (match === null) return null;
  return { query: match[2].toLowerCase(), from: before.length - match[1].length };
}

/** Workspace emoji names matching a query: name-start first, then inside. */
export function rankCustomEmoji(names: readonly string[], query: string): string[] {
  const starts = names.filter((name) => name.startsWith(query));
  const inside = names.filter((name) => !name.startsWith(query) && name.includes(query));
  return [...starts, ...inside];
}

/** What a row draws in front of its label. */
type Glyph =
  | { kind: "char"; char: string }
  | { kind: "custom"; name: string }
  | { kind: "slackmoji"; url: string }
  | { kind: "action"; icon: "search" | "add" };

const glyphs = new WeakMap<Completion, Glyph>();

function withGlyph(completion: Completion, glyph: Glyph): Completion {
  glyphs.set(completion, glyph);
  return completion;
}

/** The inserted text, and a space after it unless one is already there. */
function spaced(state: EditorState, to: number, text: string): string {
  const next = state.sliceDoc(to, to + 1);
  return next === "" || /\s/.test(next) ? text : `${text} `;
}

function insert(view: EditorView, completion: Completion, from: number, to: number, text: string): void {
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    userEvent: "input.complete",
    annotations: pickedCompletion.of(completion),
  });
}

/**
 * Insert what a round trip decides — an import, the Add dialog. The document
 * may have moved on by the time it answers: when the `:query` is still where
 * it was it is replaced, and otherwise the emoji goes where the caret is now.
 */
function insertLater(
  view: EditorView,
  from: number,
  to: number,
  typed: string,
  pending: Promise<string | null>,
): void {
  void pending.then((name) => {
    if (name === null) return;
    const text = `:${name}:`;
    const stillThere = view.state.sliceDoc(from, to) === typed;
    const at = stillThere ? { from, to } : { from: view.state.selection.main.head, to: view.state.selection.main.head };
    const insertText = spaced(view.state, at.to, text);
    view.dispatch({
      changes: { ...at, insert: insertText },
      selection: { anchor: at.from + insertText.length },
      userEvent: "input.complete",
    });
    view.focus();
  });
}

function customOption(name: string): Completion {
  const completion: Completion = {
    label: `:${name}:`,
    detail: "this workspace",
    type: "emoji",
    apply: (view, picked, from, to) => insert(view, picked, from, to, spaced(view.state, to, `:${name}:`)),
  };
  return withGlyph(completion, { kind: "custom", name });
}

function standardOption(char: string, name: string): Completion {
  const completion: Completion = {
    label: `:${name}:`,
    type: "emoji",
    apply: (view, picked, from, to) => insert(view, picked, from, to, char),
  };
  return withGlyph(completion, { kind: "char", char });
}

function slackmojiOption(host: EmojiHostContext, result: SlackmojiResult, typed: string): Completion {
  const name = customEmojiNameFrom(result.name);
  const completion: Completion = {
    label: `:${name}:`,
    detail: "add from Slackmojis",
    type: "emoji",
    apply: (view, _picked, from, to) => {
      const imported = host.importSlackmoji?.(result, name) ?? Promise.resolve({ error: "" });
      insertLater(
        view,
        from,
        to,
        typed,
        imported.then((outcome) => ("name" in outcome ? outcome.name : null)),
      );
    },
  };
  return withGlyph(completion, { kind: "slackmoji", url: result.url });
}

function actionOptions(host: EmojiHostContext | null, query: string, typed: string): Completion[] {
  const openAdd = host?.openAdd;
  if (openAdd === undefined) return [];
  const open = (tab: "upload" | "slackmojis"): Completion["apply"] => (view, _picked, from, to) =>
    insertLater(view, from, to, typed, openAdd({ query, tab }));
  const rows: Completion[] = [];
  if (host?.searchSlackmojis !== undefined) {
    rows.push(
      withGlyph(
        { label: `Search Slackmojis for “${query}”`, type: "emoji-action", apply: open("slackmojis"), boost: -99 },
        { kind: "action", icon: "search" },
      ),
    );
  }
  rows.push(
    withGlyph(
      { label: "Add a custom emoji…", type: "emoji-action", apply: open("upload"), boost: -99 },
      { kind: "action", icon: "add" },
    ),
  );
  return rows;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function emojiCompletionSource(): CompletionSource {
  return (context: CompletionContext): CompletionResult | null | Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos);
    const open = openShortcode(line.text.slice(0, context.pos - line.from));
    if (open === null) return null;
    const from = line.from + open.from;
    if (inLiteral(context.state, from)) return null;
    const typed = context.state.sliceDoc(from, context.pos);
    const host = context.state.facet(emojiHost)?.current ?? null;

    const custom = rankCustomEmoji(host?.custom() ?? [], open.query).slice(0, 5).map(customOption);
    const standard = searchStandardEmoji(open.query, MENU_SIZE - custom.length).map(({ emoji, name }) =>
      standardOption(emoji.char, name),
    );
    const actions = actionOptions(host, open.query, typed);
    const result = (options: Completion[]): CompletionResult | null =>
      options.length === 0 ? null : { from, to: context.pos, options, filter: false };

    const local = [...custom, ...standard];
    const search = host?.searchSlackmojis;
    if (local.length > 0 || search === undefined || host === null) return result([...local, ...actions]);

    return pause(SLACKMOJIS_PAUSE_MS)
      .then(() => (context.aborted ? [] : search(open.query)))
      .catch(() => [])
      .then((found) => {
        if (context.aborted) return null;
        return result([...found.slice(0, 5).map((each) => slackmojiOption(host, each, typed)), ...actions]);
      });
  };
}

/** Slackmojis pictures already fetched this session, by URL. */
const previews = new Map<string, Promise<string | null>>();

/** The glyph column of the completion list: a character, a picture, or an icon. */
export const emojiGlyphOption = {
  position: 20,
  render(completion: Completion, state: EditorState): Node | null {
    const glyph = glyphs.get(completion);
    if (glyph === undefined) return null;
    const box = document.createElement("span");
    box.className = "cm-emoji-glyph";
    if (glyph.kind === "char") {
      box.textContent = glyph.char;
      return box;
    }
    if (glyph.kind === "action") {
      box.textContent = glyph.icon === "search" ? "⌕" : "+";
      box.classList.add("cm-emoji-glyph-action");
      return box;
    }
    const host = state.facet(emojiHost)?.current ?? null;
    const load =
      glyph.kind === "custom"
        ? host?.load(glyph.name)
        : (() => {
            let pending = previews.get(glyph.url);
            if (pending === undefined && host?.previewSlackmoji !== undefined) {
              pending = host.previewSlackmoji(glyph.url).catch(() => null);
              previews.set(glyph.url, pending);
            }
            return pending;
          })();
    void load?.then((src) => {
      if (src === null) return;
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      box.replaceChildren(img);
    });
    return box;
  },
};

/**
 * Typing the closing colon of a standard shortcode puts the character in, the
 * way Slack does, so `:tada:` typed out in full is the same as picking it.
 */
export function emojiTyping(): Extension {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== ":" || from !== to) return false;
    const line = view.state.doc.lineAt(from);
    const open = openShortcode(line.text.slice(0, from - line.from));
    if (open === null) return false;
    const emoji = standardEmojiNamed(open.query);
    const start = line.from + open.from;
    if (emoji === undefined || inLiteral(view.state, start)) return false;
    view.dispatch({
      changes: { from: start, to: from, insert: emoji.char },
      selection: { anchor: start + emoji.char.length },
      userEvent: "input.type",
    });
    return true;
  });
}

export const emojiCompletionTheme = EditorView.baseTheme({
  ".cm-emoji-glyph": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "1.4em",
    height: "1.4em",
    flexShrink: "0",
    fontSize: "1.15em",
    alignSelf: "center",
  },
  ".cm-emoji-glyph img": { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" },
  ".cm-emoji-glyph-action": { color: "var(--lp-muted)", fontSize: "1em" },
});
