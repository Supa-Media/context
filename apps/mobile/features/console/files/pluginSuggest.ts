import { autocompletion, type CompletionSource } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/**
 * A plugin's in-editor suggestions, drawn by CodeMirror rather than by the
 * plugin.
 *
 * ## Why the completion list is ours and the content is theirs
 *
 * `registerEditorSuggest` is how an Obsidian plugin offers a completion —
 * YouVersion Linker's whole primary interaction, the list you get from typing
 * `@ John 1:1`. Obsidian mounts the plugin's suggester into its editor, where
 * it renders its own DOM and handles its own keys.
 *
 * Context cannot do that: this editor is the trusted realm, and
 * `docs/decisions/plugins.md` rules out third-party callbacks, DOM and
 * `EditorView` access inside it. So the parts are split along the boundary
 * rather than ported across it. **The plugin decides what to offer and what a
 * pick produces; CodeMirror decides how a list looks and how keys behave.** The
 * only things that cross are strings.
 *
 * ## The line is the unit, and that is what makes the pick safe
 *
 * `ask` is given the text of the current line up to the cursor. `pick` answers
 * with the whole line the plugin's `selectSuggestion` produced. So applying a
 * suggestion is "replace this line with that line" — which needs no write
 * grant, because the *editor* makes the edit through its normal path. It is the
 * person typing, and it undoes like anything else they typed.
 *
 * A pick is asynchronous — it crosses to a sandbox and back — and the document
 * can move underneath it. So the line is re-resolved at apply time and the edit
 * is abandoned unless that line is still character-for-character the one the
 * suggestion was computed from. That is the etag rule this codebase applies to
 * notes, at the scale of one line: **never write over what you did not read.**
 */
export function pluginSuggestions(options: {
  /** Ask the running plugins; resolves empty when none offers anything. */
  ask: (line: string, ch: number) => Promise<{ text: string }[]>;
  /** Take the pick; resolves to the rewritten line, or null if nothing answers. */
  pick: (index: number) => Promise<string | null>;
}): Extension {
  const source: CompletionSource = async (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const ch = context.pos - line.from;
    const items = await options.ask(line.text.slice(0, ch), ch);
    if (items.length === 0) return null;
    const asked = line.text;
    const lineNumber = line.number;
    return {
      from: line.from,
      to: line.to,
      /*
        `filter: false`, because the plugin already decided what matches. The
        query it triggered on is its own — `@ John 3:16` — and CodeMirror
        filtering the labels against the word under the cursor would drop
        suggestions whose text does not happen to contain it.
      */
      filter: false,
      options: items.map((item, index) => ({
        label: item.text,
        apply: (view: EditorView) => {
          void options.pick(index).then((next) => {
            if (next === null) return;
            /*
              Re-resolved, then compared. The round trip to the sandbox is long
              enough for the person to have typed, and the plugin computed this
              line from the one it was shown. Replacing a line it never saw
              would overwrite their keystrokes with a completion for text that
              is gone.
            */
            if (lineNumber > view.state.doc.lines) return;
            const current = view.state.doc.line(lineNumber);
            if (current.text !== asked) return;
            view.dispatch({
              changes: { from: current.from, to: current.to, insert: next },
              selection: { anchor: current.from + next.length },
            });
          });
        },
      })),
    };
  };
  /*
    `override` rather than an added source: this is the only completion this
    editor offers, and leaving CodeMirror's default word-completion on beside it
    would put the note's own vocabulary in the same menu as a plugin's
    suggestions, with no way for a reader to tell which came from where.
  */
  return autocompletion({ override: [source], activateOnTyping: true });
}
