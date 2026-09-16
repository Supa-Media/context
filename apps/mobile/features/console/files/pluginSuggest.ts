import type { CompletionSource } from "@codemirror/autocomplete";
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
 * with that same text as the plugin's `selectSuggestion` left it. So applying a
 * suggestion is "replace what is before the caret with that" — which needs no
 * write grant, because the *editor* makes the edit through its normal path. It
 * is the person typing, and it undoes like anything else they typed.
 *
 * **Before the caret, and not the whole line.** The guest's one-line editor is
 * built from what crosses, so it has never contained anything the reader typed
 * *after* the caret — and this replaced the whole line with it, which silently
 * deleted that tail. Sending more of the line would fix it in the other
 * direction and hand the sandbox note content nobody asked it about; the range
 * it writes is what was wrong, so that is what changed.
 *
 * A pick is asynchronous — it crosses to a sandbox and back — and the document
 * can move underneath it. So the line is re-resolved at apply time and the edit
 * is abandoned unless the text before the caret is still character-for-character
 * what the suggestion was computed from. That is the etag rule this codebase
 * applies to notes, at the scale of part of a line: **never write over what you
 * did not read.**
 *
 * ## A source, never an `autocompletion()` of its own
 *
 * This returned an `Extension` first, and that shipped a crash: opening any
 * note with a plugin running threw `Config merge conflict for field override`
 * and dropped the console back to the workspace route. CodeMirror combines its
 * completion facet with `combineConfig`, and `override` has no combiner — so a
 * second `autocompletion()` in the same state is not a second list, it is a
 * throw at construction.
 *
 * `linkComplete.ts` and `formComplete.ts` both say so in their own headers, and
 * `editorCompletion` exists to be the one place that builds the list. This is a
 * source for it, like the other two.
 *
 * ## A ref, never the callbacks themselves
 *
 * The second production report on this feature: YouVersion showed **Running**
 * and typing `@John 3:16` still produced nothing. Not the guest, not the gate —
 * the editor builds its `EditorState` in an effect with an empty dependency
 * array, so whatever it was handed at **mount** is what the source calls for
 * the life of that editor. Open a note, then start a plugin, and the source is
 * still holding a callback whose `sandboxes` list was empty; if no plugin could
 * run at mount at all, there was no source installed to hold anything.
 *
 * So this takes the same mutable ref `FormHostRef` and `PluginPreviewRef` take,
 * and for the reason `FormHostRef`'s header already gives: a widget built once
 * must read its host at the moment it is used, not at the moment it was built.
 * An absent `ask` means no plugin can be asked *right now* — the source answers
 * nothing and is still there when one can.
 */
export interface PluginSuggestRef {
  /** Ask the running plugins; absent while none can be. */
  ask?: (line: string, ch: number) => Promise<{ text: string }[]>;
  /** Take the pick; resolves to the rewritten line, or null if nothing answers. */
  pick?: (index: number) => Promise<string | null>;
}

export function pluginSuggestSource(ref: PluginSuggestRef): CompletionSource {
  return async (context) => {
    /*
      Read off the ref every time. A plugin started after this note was opened
      is exactly the case the whole indirection exists for.
    */
    const ask = ref.ask;
    if (ask === undefined) return null;
    const line = context.state.doc.lineAt(context.pos);
    const ch = context.pos - line.from;
    const asked = line.text.slice(0, ch);
    const items = await ask(asked, ch);
    if (items.length === 0) return null;
    const lineNumber = line.number;
    return {
      from: line.from,
      to: context.pos,
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
          const pick = ref.pick;
          if (pick === undefined) return;
          void pick(index).then((next) => {
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
            if (current.text.slice(0, ch) !== asked) return;
            view.dispatch({
              changes: { from: current.from, to: current.from + ch, insert: next },
              selection: { anchor: current.from + next.length },
            });
          });
        },
      })),
    };
  };
}
