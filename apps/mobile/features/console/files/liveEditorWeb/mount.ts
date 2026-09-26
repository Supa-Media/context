/**
 * Building the web editor: the body of the effect in `LiveEditor.web.tsx`
 * that runs once, at mount.
 *
 * It creates the `EditorView`, attaches the DOM listeners, hands the
 * imperative handle out, and returns the teardown that undoes all of it in
 * the same order it always did. The effect still owns *when* this runs; this
 * module owns only what it does.
 */

import { EditorState, type Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { pluginSuggestSource, type PluginSuggestRef } from "../pluginSuggest";
import { pluginLinkPreview, pluginPreviewTheme, type PluginPreviewRef } from "../pluginPreview";
import { drawInterim, takeBackRun } from "../dictate";
import { closeFindPanel, findInNote } from "../findInNote";
import { remoteCarets, reportSelection } from "../../presence/remoteCarets";
import { mayPersist, type SharedDoc } from "../../presence/sharedDoc";
import { editorExtensions, openingCaret, runCommand, type HandlerRef } from "../editorSetup";
import type { NoteLinkContext } from "../noteLinks";
import type { FormHostRef } from "../formBlock";
import { listHost, type ListHostRef } from "../listBlock/model";
import type { ImageHostRef } from "../imageBlock";
import type { EditorControls, EditorHandlers, LiveEditorProps, MenuPoint } from "./contract";
import { contextMenuListener } from "./contextMenu";
import { selectTitle, titleLine } from "./titleLine";

export function mountEditor({
  host,
  view,
  value,
  editable,
  editableCompartment,
  latestValue,
  bound,
  presenceRef,
  handlers,
  onOpenNote,
  links,
  forms,
  images,
  lists,
  onImageProblem,
  suggesters,
  onPreviewLinks,
  previews,
  collab,
  setMenuAt,
  setTableAt,
}: {
  host: { current: HTMLDivElement | null };
  view: { current: EditorView | null };
  value: string;
  editable: boolean;
  editableCompartment: { current: Compartment };
  latestValue: { current: string };
  bound: { current: SharedDoc | null };
  presenceRef: { current: LiveEditorProps["presence"] };
  handlers: { current: EditorHandlers };
  onOpenNote: LiveEditorProps["onOpenNote"];
  links: { current: NoteLinkContext };
  forms: FormHostRef;
  images: ImageHostRef;
  lists: ListHostRef;
  onImageProblem: LiveEditorProps["onImageProblem"];
  suggesters: { current: PluginSuggestRef };
  onPreviewLinks: LiveEditorProps["onPreviewLinks"];
  previews: { current: PluginPreviewRef };
  collab: { current: Compartment };
  setMenuAt: (at: MenuPoint | null) => void;
  setTableAt: (at: MenuPoint | null) => void;
}): (() => void) | undefined {
  if (host.current === null) return;

  /**
   * The configuration lives in `editorSetup.ts`, shared with the iOS half.
   *
   * It used to be written out here, which was right while web was the only
   * surface with a Live Preview. It stopped being right the day
   * `LiveEditor.tsx` became the same CodeMirror inside a `WebView`: two copies
   * of the read-only facets, the `Mod-s` gate and the update listener are two
   * copies to fix, and each half's tests would keep passing while they
   * drifted.
   */
  // `onChange` is wrapped rather than passed straight through: this half also
  // has to record what the editor now holds, which is what the effect below
  // compares an incoming `value` against. (The iOS half keeps the same fact
  // in `createHostBridge`, for the same reason and under the same name.)
  const bridged: HandlerRef = {
    current: {
      onChange: (text: string) => {
        latestValue.current = text;
        /*
          **Only the elected writer dirties the local draft.**

          While a room is live every editor in it holds the same text, so if
          each one marked its own draft unsaved, each one's autosave would
          fire and they would race against one etag — the collision this
          whole feature exists to remove, arriving from the other end. One
          member writes; the rest render.

          `canWrite` is true when there is no room at all, which is what
          keeps a note nobody else is in behaving exactly as it always did.
        */
        if (!mayPersist({ bound: bound.current, canWrite: presenceRef.current?.canWrite === true })) return;
        handlers.current.onChange(text);
      },
      onSave: () => {
        /*
          **A manual save is a save, so writer election decides it too.**

          Review found this: `onChange` was gated and ⌘S was not, so any
          client in the room could push its own draft to the bucket with a
          keystroke — which is the racing-writers collision the election
          exists to prevent, reachable by the one control that bypasses
          autosave entirely. For a non-writer the merged text is already
          being saved by somebody else, so the right behaviour is to do
          nothing rather than to save a duplicate.
        */
        if (!mayPersist({ bound: bound.current, canWrite: presenceRef.current?.canWrite === true })) return;
        handlers.current.onSave();
      },
    },
  };

  const state = EditorState.create({
    doc: value,
    /*
      The start of the writing, not the start of the file — see
      `openingCaret`. Without it a note that opens with a `---` block opens
      with the caret inside it, and `livePreview.ts` reveals what the caret
      is in, so hiding the block bought nothing on the one screen it was for.
    */
    selection: { anchor: openingCaret(value) },
    // `editorExtensions` rather than `editorStateFor`: the latter is the
    // shared entry point `webview/guest.ts` also calls, and K2's find-in-note
    // keymap (`findInNote`) is web-only — see that module's header for why
    // it is appended here instead of folded into the shared list.
    extensions: [
      ...editorExtensions({
        editable,
        editableCompartment: editableCompartment.current,
        handlers: bridged,
        // Absent when this surface has nowhere to navigate to; the extension
        // is then not installed at all and links are plain text.
        links: onOpenNote === undefined ? undefined : links,
        forms,
        /*
          Images. Passed unconditionally: the ref is the thing that is empty
          on a surface with no bucket, and the row reports that itself — the
          same reason `pluginSuggest` is installed unconditionally below.
        */
        images,
        ...(onImageProblem === undefined ? {} : { reportImage: onImageProblem }),
        /*
          A plugin's in-editor suggestions.

          An option on the shared list rather than an extension appended after
          it: `editorExtensions` already configures CodeMirror's one
          completion, and a second `autocompletion()` beside it throws
          `Config merge conflict for field override` at state construction —
          which is what it did, in production, for every note opened with a
          plugin running. The native guest passes nothing here and keeps the
          editor it had.

          Installed unconditionally on this surface rather than only where a
          plugin is already running, which is the other half of that report's
          fix. "Can a plugin run here?" is not answerable at mount: the owner
          check is still resolving, and a plugin may be started a minute
          later. The source reads `suggesters.current` and answers nothing
          until there is something to ask — so the question is asked at every
          keystroke instead of once, and the answer is allowed to change.
        */
        pluginSuggest: pluginSuggestSource(suggesters.current),
        /*
          No `insetBottom`. A mobile browser shrinks the layout viewport when
          the keyboard opens rather than drawing over the page, so the
          scroller is already the size of what can be seen and a margin here
          would push the caret up by a keyboard that is covering nothing.
          The iOS half needs one because a WKWebView keeps its full height;
          see `coveredBottom`.
        */
      }),
      /*
        A plugin's read preview, on the same condition as its suggestions and
        for the same reason: a surface with no sandbox behind it gets no
        extension rather than one wired to a source that never answers.
      */
      ...(onPreviewLinks === undefined
        ? []
        : [pluginLinkPreview(previews.current), pluginPreviewTheme]),
      findInNote(),
      // The title: the caret in it, and the line under it. Web only, like
      // find-in-note; see `titleLine.ts`.
      titleLine(() => handlers.current.onTitleCaret),
      // Folder lists: web only, like find-in-note. The native guest has no
      // copy of the workspace to read, so its lists stay as source.
      listHost.of(lists),
      /*
        Other people's carets, and this editor's own going out.

        The extension is installed unconditionally and the *roster* is what
        may be absent, for `pluginSuggest`'s reason directly above: whether
        this note has a room behind it is not answerable at mount, and a
        connection that arrives a second later must not need a different
        editor.

        `selectionSet` rather than every update: a repaint, a scroll and a
        remote caret all produce updates, and reporting on those would send
        a frame per keystroke of somebody else's typing.
      */
      remoteCarets(),
      // Empty until the room answers; see the effect below.
      collab.current.of([]),
      reportSelection(() => presenceRef.current?.report),
    ],
  });

  const created = new EditorView({ state, parent: host.current });

  /*
    Focus, out to React.

    Two DOM listeners here rather than an extension in `editorSetup.ts`,
    because the guest reports its focus over the bridge instead — the two
    surfaces answer the same prop by different routes, and that route is the
    only part of this the two halves do not share. `guest.ts` attaches the
    identical pair to the identical element, and its comment carries the
    argument for which pair: a table cell is `contenteditable` DOM of a
    widget's, so a caret in a grid is a caret in the note and `contentDOM`
    does not have focus. `focusin` and `focusout` bubble; `focus` and `blur`
    do not.

    Read off the ref rather than closed over, exactly like `onChange` above
    and for the same reason: this view is built once and would otherwise
    report to the first render's callbacks forever.
  */
  let focused = false;
  const reportFocus = () => {
    if (focused) return;
    focused = true;
    handlers.current.onFocus?.();
  };
  const reportBlur = (event: FocusEvent) => {
    // Moving from one cell to the next is not leaving the note.
    const to = event.relatedTarget;
    if (to instanceof Node && created.dom.contains(to)) return;
    if (!focused) return;
    focused = false;
    handlers.current.onBlur?.();
  };
  created.dom.addEventListener("focusin", reportFocus);
  created.dom.addEventListener("focusout", reportBlur);

  // Right-click over the note body; see `contextMenuListener`.
  const onContextMenu = contextMenuListener({ created, handlers, setMenuAt, setTableAt });
  created.contentDOM.addEventListener("contextmenu", onContextMenu);

  view.current = created;
  latestValue.current = value;
  forms.generation = (forms.generation ?? 0) + 1;
  lists.generation = (lists.generation ?? 0) + 1;

  /*
    The imperative handle, built against `created` rather than `view.current`
    so it cannot be aimed at a later editor by a race — and handed back as
    `null` in the teardown below, before `destroy()`, so nothing can dispatch
    into a destroyed view. See `LiveEditorProps.controls`.

    Every method is `runCommand` from `editorSetup.ts`, which is the same
    function the guest bundle runs inside its `WebView`. `undo`/`redo` are
    therefore CodeMirror's own commands over the `history()` extension already
    configured there — the same history `historyKeymap` gives ⌘Z. A
    hand-rolled value stack here would be a *second* history disagreeing with
    the keyboard's on the one platform that has a keyboard.
  */
  const api: EditorControls = {
    wrap: (before, after) => runCommand(created, { name: "wrap", before, after }),
    toggleLinePrefix: (prefix) => runCommand(created, { name: "toggleLinePrefix", prefix }),
    insertLink: () => runCommand(created, { name: "insertLink" }),
    undo: () => runCommand(created, { name: "undo" }),
    redo: () => runCommand(created, { name: "redo" }),
    blur: () => runCommand(created, { name: "blur" }),
    // Not a `runCommand`: the find bar is this surface's alone, so there is
    // no verb for it in the bridge's protocol and nothing on the other side
    // to run one.
    closeFind: () => closeFindPanel(created),
    dictate: (text) => runCommand(created, { name: "dictate", text }),
    // Not `runCommand`s: neither changes the document, so neither is a
    // command. See `EditorControls.showInterim`.
    showInterim: (text) => drawInterim(created, text),
    discardDictation: () => takeBackRun(created),
    // Not a `runCommand` either: it moves the selection and changes nothing.
    selectTitle: () => selectTitle(created),
  };
  handlers.current.controls?.(api);

  return () => {
    handlers.current.controls?.(null);
    created.dom.removeEventListener("focusin", reportFocus);
    created.dom.removeEventListener("focusout", reportBlur);
    created.contentDOM.removeEventListener("contextmenu", onContextMenu);
    created.destroy();
    view.current = null;
  };
}
