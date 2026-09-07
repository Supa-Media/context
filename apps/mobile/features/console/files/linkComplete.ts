/**
 * Typing `[[` offers the notes you could mean.
 *
 * ## What was wrong
 *
 * `[[` is how every note in these buckets points at another one, and the
 * editor's answer to it was nothing at all: you typed the path from memory, and
 * if you got it wrong the link rendered as plain text — because `noteLinks`
 * draws a wikilink only once it resolves. So the failure mode was silent, and
 * the fix was to go and read the tree. The owner's words: "autocomplete doesn't
 * work … as I'm typing it should autofill the different pages we have
 * available".
 *
 * ## What it can offer, and the honest limit on it
 *
 * The same list `noteLinks` resolves a bare `[[name]]` against — `paths` on the
 * shared `NoteLinkRef` — which is **not every note in the context**. The file
 * tree loads folder by folder, so this holds what somebody has expanded plus
 * whatever a search or a link happened to fetch. That is a real limit and it is
 * worst exactly where it is least welcome: a phone draws no tree at all, so the
 * list there is close to the folder you are in.
 *
 * It is still the right first version. Nothing here invents a destination — an
 * offered path is a note this surface has actually seen — and widening the list
 * is a separate piece of work with a separate cost (a full note index, or an
 * async source that asks the gateway's search and, on iOS, does so over the
 * WebView bridge). Recorded as the next step rather than half-built here.
 *
 * ## What it inserts
 *
 * The rooted path with the `.md` dropped, which is the one style that resolves
 * from anywhere: `resolveLink` reads anything containing a `/` as rooted and
 * needs no note list for it. A bare name would be shorter and is what somebody
 * writing by hand tends to type — and it resolves only while exactly one note
 * answers to that name, so an autocompletion that produced one would break the
 * moment a second `overview.md` appeared anywhere in the bucket. The label
 * shows the basename; the path is what is written.
 */

import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { NoteLinkRef } from "./noteLinks";

/**
 * The `[[` a caret is inside, if it is inside one.
 *
 * Pure over the text before the caret, and exported for its own test: what
 * makes this correct is which positions it *refuses* — after the link is
 * closed, across a line break, inside a `[single]` bracket — and each of those
 * is a property of a string.
 *
 * `[^\]\n]*` is the same class `parseLinks`' own wikilink pattern uses, so what
 * this calls "inside a wikilink" and what the resolver will later call one are
 * the same shape rather than two regexes drifting apart.
 */
export function openWikilink(before: string): { query: string; from: number } | null {
  const match = /\[\[([^\][\n]*)$/.exec(before);
  if (match === null) return null;
  return { query: match[1], from: before.length - match[1].length };
}

/** One offered note. */
export interface NoteChoice {
  /** The note's own name, without the folder or the extension. */
  readonly label: string;
  /** The folder it is in, or `""` at the root. */
  readonly folder: string;
  /** What is written into the document. */
  readonly insert: string;
}

/** `1-projects/foo/overview.md` → `overview`. */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

/** `1-projects/foo/overview.md` → `1-projects/foo`. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * How many offers to build.
 *
 * A cap rather than the whole bucket, because this list is rebuilt on every
 * keystroke inside a `[[` and an empty query offers everything. Fifty is more
 * than fits on a phone screen twice over, and a query that needs more than
 * fifty candidates is a query that has not been typed yet.
 */
export const MAX_CHOICES = 50;

/**
 * The notes that could be meant by `query`, best first.
 *
 * Ranked in three bands rather than scored, because the bands are the thing a
 * person can predict: a name that *starts* with what you typed, then a name
 * that contains it, then a path that contains it. Within a band, alphabetical —
 * a stable order matters more than a cleverer one when the list is being
 * rebuilt under a moving caret.
 *
 * The note being edited is never offered. A link from a note to itself is not
 * something somebody is reaching for at a `[[`, and it is the one candidate
 * guaranteed to rank first in every band.
 */
export function noteChoices(
  query: string,
  paths: readonly string[],
  self: string | null,
): NoteChoice[] {
  const needle = query.trim().toLowerCase();
  const banded: { band: number; path: string }[] = [];

  for (const path of paths) {
    if (path === self) continue;
    const name = baseName(path).toLowerCase();
    const band =
      needle === "" || name.startsWith(needle)
        ? 0
        : name.includes(needle)
          ? 1
          : path.toLowerCase().includes(needle)
            ? 2
            : -1;
    if (band < 0) continue;
    banded.push({ band, path });
  }

  banded.sort((a, b) => (a.band === b.band ? a.path.localeCompare(b.path) : a.band - b.band));
  return banded.slice(0, MAX_CHOICES).map(({ path }) => ({
    label: baseName(path),
    folder: folderOf(path),
    insert: path.replace(/\.md$/, ""),
  }));
}

/**
 * The extension.
 *
 * `override` rather than a language-registered source: this editor's only
 * completion is this one, and the Markdown language package registers its own
 * (HTML tags inside a fenced block) that has no business firing in a note.
 */
export function noteCompletion(ref: NoteLinkRef): Extension {
  return [
    autocompletion({
      override: [(context: CompletionContext): CompletionResult | null => {
        const line = context.state.doc.lineAt(context.pos);
        const open = openWikilink(context.state.doc.sliceString(line.from, context.pos));
        if (open === null) return null;
        // An explicit request (Ctrl-Space) opens the list on a bare `[[`; typing
        // does not, so the first two keystrokes of a link are not fought over.
        if (!context.explicit && open.query === "") return null;

        const paths = ref.current.paths ?? [];
        if (paths.length === 0) return null;

        const options: Completion[] = noteChoices(open.query, paths, ref.current.path).map(
          (choice) => ({
            label: choice.label,
            detail: choice.folder,
            type: "text",
            apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
              /*
                The `]]` is written here rather than left to the person, and only
                when it is not already there: accepting a completion inside an
                existing `[[…]]` must not leave `]]]]` behind. The caret lands
                after the closing brackets either way, which is where the next
                word goes.
              */
              const closing = view.state.doc.sliceString(to, to + 2) === "]]" ? "" : "]]";
              view.dispatch({
                changes: { from, to, insert: `${choice.insert}${closing}` },
                // Past the closing brackets either way: when they were already
                // there they now sit immediately after the inserted path, and
                // when they were not, they are the two characters just written.
                selection: { anchor: from + choice.insert.length + 2 },
                userEvent: "input.complete",
              });
            },
          }),
        );
        if (options.length === 0) return null;

        return {
          from: line.from + open.from,
          options,
          // Our own ranking, in bands a person can predict — see `noteChoices`.
          filter: false,
        };
      }],
      // The list is rebuilt from the note paths on every keystroke, so there is
      // nothing to keep open across one.
      closeOnBlur: true,
    }),
    completionTheme,
  ];
}

/**
 * The list's own look.
 *
 * Drawn from the editor's CSS custom properties for the reason `noteLinks`'
 * theme states: the guest bundle runs inside a WebView handed a palette at
 * mount, so a colour imported from the design tokens here would be the
 * *build's* palette rather than the viewer's.
 */
const completionTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-autocomplete": {
    border: "1px solid var(--lp-code-bg)",
    borderRadius: "8px",
    background: "var(--lp-bg)",
    color: "var(--lp-content)",
    font: "13px/1.5 system-ui, sans-serif",
    boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "inherit",
    maxHeight: "14em",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "5px 9px",
    display: "flex",
    gap: "10px",
    alignItems: "baseline",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--lp-code-bg)",
    color: "var(--lp-content)",
  },
  ".cm-completionDetail": {
    marginLeft: "auto",
    fontStyle: "normal",
    fontSize: "0.85em",
    color: "var(--lp-muted)",
    /* A long folder truncates rather than pushing the name off the row. */
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "60%",
  },
});
