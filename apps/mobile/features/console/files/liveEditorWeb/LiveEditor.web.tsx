/**
 * The Live Preview editor, on web.
 *
 * A thin, deliberately boring shell around CodeMirror. Everything interesting
 * about how the document is drawn lives in `livePreview.ts` and everything
 * about how the editor behaves lives in `editorSetup.ts` — both pure, both
 * tested, and `editorSetup.ts` shared verbatim with the iOS half, which runs
 * the same configuration inside a `WebView`. This file exists to solve exactly
 * one hard problem, which is keeping a mutable editor instance and React's idea
 * of the world in agreement without either of them fighting the other.
 *
 * ## The two directions, and why they are not symmetrical
 *
 * **Typing → React** is a subscription: `updateListener` fires, and the text
 * goes out through `onChange` into the existing reducer in `editor.ts`. Nothing
 * about the editor's own state changes as a result, so there is no loop.
 *
 * **React → editor** is the dangerous one, and it happens for exactly three
 * reasons: a different note was opened, the person discarded their draft, or a
 * conflict was resolved by loading somebody else's version. In all three the
 * new text is *authoritative* and the editor must be told. What must not happen
 * is the round trip — editor fires `onChange`, parent re-renders with the same
 * text, effect writes it back — because writing a document into CodeMirror
 * resets the selection, so that loop shows up as the caret jumping to the end
 * of the line on every keystroke.
 *
 * The guard is one comparison: only dispatch when the incoming `value` differs
 * from what the editor already holds. That is why `latestValue` exists rather
 * than a dependency array — a dep array compares against the *previous render's*
 * prop, which is not the same question.
 *
 * ## Why not a controlled component
 *
 * The obvious React shape — value in, onChange out, re-render on every
 * keystroke — is wrong for a text editor whose state includes a selection, an
 * undo history and a parsed syntax tree. CodeMirror owns all three. Treating it
 * as controlled would mean rebuilding them from scratch on every character.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Compartment } from "@codemirror/state";
import type { PluginSuggestRef } from "../pluginSuggest";
import type { PluginPreviewRef } from "../pluginPreview";
import type { EditorView } from "@codemirror/view";
import { Menu } from "../../../design/components/Menu";
import { isApplePlatform } from "../../../design/applePlatform";
import { editorMenuItems, type EditorMenuId } from "../editorMenu";
import { insertTable } from "../markdownFormat";
import { TableSizePicker } from "../TableSizePicker.web";
import { closeFindPanel } from "../findInNote";
import { setRemoteCarets } from "../../presence/remoteCarets";
import type { SharedDoc } from "../../presence/sharedDoc";
import { editability, replaceDocument } from "../editorSetup";
import type { NoteLinkContext } from "../noteLinks";
import { webUrl } from "../webUrl";
import type { FormHostRef, FormResponseRetract, FormResponseUpdate, FormVote } from "../formBlock";
import { listHost, type ListHostRef } from "../listBlock/model";
import type { ImageHostRef } from "../imageBlock";
import { useColors } from "../../../design/theme";
import type { LiveEditorProps } from "./contract";
import { ensureStyles } from "./stylesheet";
import { mountEditor } from "./mount";
import { bindSharedDocument, followNote } from "./sharedBinding";
import { runEditorMenuAction } from "./contextMenu";

export function LiveEditor({
  value,
  editable,
  onChange,
  presence,
  onSave,
  controls,
  onFocus,
  onBlur,
  accessibilityLabel,
  onOpenNote,
  notePath,
  notePaths,
  onSubmitForm,
  onReadFormResponses,
  onVoteForm,
  onUpdateFormResponse,
  onRetractFormResponse,
  onLoadImage,
  onStoreImage,
  onImageProblem,
  folderLists,
  onSuggest,
  onPickSuggestion,
  onPreviewLinks,
  onDictate,
  onAsk,
}: LiveEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  /**
   * The presence reporter, behind a ref.
   *
   * The `updateListener` below is installed once, at state construction, and
   * closing over the prop would pin it to the value this render had — the same
   * trap `latestValue` exists for, one field along. A note reopened after a
   * reconnect would then report its caret into a socket that is gone.
   */
  const presenceRef = useRef(presence);
  presenceRef.current = presence;
  const settledRef = useRef(presence?.settled === true);
  settledRef.current = presence?.settled === true;
  /**
   * Where the shared document is swapped in.
   *
   * The editor is built once, at mount, and the room answers a moment later —
   * so the collaborative binding cannot be in the initial extension list. A
   * `Compartment` is CodeMirror's own answer to exactly that: an empty slot at
   * construction, reconfigured when there is something to put in it, with the
   * selection and the undo history left alone.
   */
  const collab = useRef(new Compartment());
  /**
   * The room this editor is **actually wired to**, or `null`.
   *
   * Not the same fact as `presence.shared`, which is non-null from the moment
   * the hook runs and says only that a document object exists. This says
   * `yCollab` is installed: a keystroke here becomes an update everybody else
   * applies, and the room — not `value` — is the authority for the text.
   *
   * Both of the gates that used to read `presence.shared` read this instead,
   * because both are really asking "is somebody else coordinating this
   * editor?" and the unbound answer to that is no. Getting it wrong costs a
   * note: with an empty document that never bound, `mayPersist` silenced every
   * client but the elected writer, and the `value` effect stood down over a
   * binding that was never installed.
   */
  const bound = useRef<SharedDoc | null>(null);
  /** Re-run the binding attempt when the room settles without any text. */
  const bindIfWaiting = useRef<(() => void) | null>(null);
  const colors = useColors();

  /**
   * What a link points at, and where following one goes.
   *
   * A ref rather than a dependency of the effect that builds the editor, for
   * the reason `HandlerRef` exists: rebuilding the view when a different note
   * opens would throw away the caret, the selection and the undo history. The
   * extension reads this at event time, so the note it resolves against is
   * always the one on screen.
   */
  const links = useRef<NoteLinkContext>({
    path: notePath ?? null,
    paths: notePaths,
    onOpen: () => {},
  });
  links.current = {
    path: notePath ?? null,
    paths: notePaths,
    onOpen: (path, mode) => onOpenNote?.(path, mode),
    onOpenUrl: openWebUrl,
  };

  /*
    The same ref trick, for the same reason, on the path that needs it most: a
    form widget is built once and kept across every transaction that does not
    change its fence (see `FormWidget.eq`), so a closure captured when it was
    built would still be aiming at whichever note was open then. Reading the
    handler at press time is what makes "submit this form" mean the form in
    front of you.
  */
  const forms = useRef<FormHostRef>({ current: null, generation: 0 }).current;
  /*
    And the same arrangement for link previews, for the same reason: the
    extension is built once per editor and the host's callback arrives new on
    every render, so what is configured has to be an object the host writes
    into rather than the callback itself.
  */
  /*
    Images, on the same ref arrangement and for the same reason as forms: a row
    widget is built once and kept across every transaction that does not change
    its line, so a closure captured at build time would be loading bytes for
    whichever note was open then.
  */
  const images = useRef<ImageHostRef>({ current: null }).current;
  /*
    Folder lists, on the same ref arrangement: a list widget is kept across
    every transaction that does not change its fence, so it reads the source,
    the open note and where a row goes at the moment it needs them.
  */
  const lists = useRef<ListHostRef>({ current: null, generation: 0 }).current;
  lists.current =
    folderLists === undefined || onOpenNote === undefined
      ? null
      : {
          load: (folder, subfolders) => folderLists.load(folder, subfolders),
          ...(folderLists.subscribe === undefined ? {} : { subscribe: folderLists.subscribe }),
          ...(folderLists.setProperty === undefined ? {} : { setProperty: folderLists.setProperty }),
          open: (path, background) => onOpenNote(path, background ? "background" : "foreground"),
          selfPath: notePath ?? null,
        };
  images.current =
    onLoadImage === undefined || onStoreImage === undefined
      ? null
      : { load: (target) => onLoadImage(target), upload: (image) => onStoreImage(image) };
  const previews = useRef<PluginPreviewRef>({ previews: new Map(), note: null });
  previews.current.ask = onPreviewLinks;
  /*
    Assigned rather than signalled, every render. This editor is built once and
    has notes swapped through it, so the extension cannot see a note change on
    its own — and a counter the host bumps is a counter somebody forgets, which
    is what the first draft of this did (bumped on mount only).
  */
  previews.current.note = notePath ?? null;
  /*
    And the same for suggestions, which is the fix for the second production
    report on that feature: the state below is built in an effect with an empty
    dependency array, so a source handed `onSuggest` directly would call the
    *first* one forever. `useRuntime` rebuilds `askSuggestions` whenever the
    running frames change, so "open the note, then start the plugin" left the
    editor calling a closure whose sandbox list was empty — a plugin that says
    Running and suggests nothing, which is what Seyi saw twice.
  */
  const suggesters = useRef<PluginSuggestRef>({});
  suggesters.current.ask = onSuggest;
  suggesters.current.pick = onPickSuggestion;
  forms.current =
    onSubmitForm === undefined
      ? null
      : {
          submit: (submission) => onSubmitForm(submission),
          ...(onReadFormResponses === undefined
            ? {}
            : { readResponses: (path: string) => onReadFormResponses(path) }),
          ...(onVoteForm === undefined ? {} : { vote: (next: FormVote) => onVoteForm(next) }),
          ...(onUpdateFormResponse === undefined
            ? {}
            : { update: (change: FormResponseUpdate) => onUpdateFormResponse(change) }),
          ...(onRetractFormResponse === undefined
            ? {}
            : { retract: (change: FormResponseRetract) => onRetractFormResponse(change) }),
        };

  /**
   * The note's colours, kept in step with the app's.
   *
   * Its own effect rather than a line in the one below: that effect *builds*
   * the editor, so making it depend on the palette would tear down and rebuild
   * the view on every change of appearance — losing the caret, the selection
   * and the undo history to a colour change. Declared first so the stylesheet
   * is in the document before the first view is created.
   */
  useEffect(() => {
    ensureStyles(colors);
  }, [colors]);

  /**
   * Editability is the one part of the configuration that changes after the
   * editor is built — a note is read-only when it is `privacy.md`, or when the
   * viewer is not an editor of this context.
   *
   * A `Compartment` rather than a full `reconfigure`, and the difference is not
   * style: replacing the whole configuration would rebuild the update listener,
   * and an earlier draft of this file did exactly that and silently detached
   * typing from `onChange`. A compartment swaps one facet and leaves every
   * other extension — including the listener — untouched.
   */
  const editableCompartment = useRef(new Compartment());

  /**
   * The callbacks, held in a ref and read at call time.
   *
   * CodeMirror's extensions are built once, when the view is created. If they
   * closed over the props directly they would capture the first render's
   * `onChange` forever, and every keystroke after the first state change would
   * be sent to a stale reducer.
   */
  const handlers = useRef({ onChange, onSave, controls, onFocus, onBlur, onDictate, onAsk });
  handlers.current = { onChange, onSave, controls, onFocus, onBlur, onDictate, onAsk };

  /**
   * The right-click menu over the note body, and the table-size picker it can
   * raise. `null` means closed; the point is where the pointer was.
   *
   * Two pieces of state rather than one discriminated union because they are
   * genuinely sequential — choosing "Table…" closes the menu and opens the
   * picker at the **same** point, so the picker outlives the menu and has to
   * remember an anchor the menu has already forgotten.
   */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [tableAt, setTableAt] = useState<{ x: number; y: number } | null>(null);

  // What the editor is known to hold. Compared against the incoming `value` to
  // decide whether a write is a genuine external change or the echo of our own
  // last keystroke. See the module comment.
  const latestValue = useRef(value);

  useEffect(() => {
    return mountEditor({
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
    });
    // Created once. `value` and `editable` are deliberately not dependencies —
    // the two effects below carry their changes in, without tearing the editor
    // down and losing the selection and undo history with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A different note was opened, and the room bound here is the one being
  // left — see `followNote`.
  const shownPath = useRef(notePath ?? null);
  useEffect(() => {
    followNote({ view, shownPath, collab, bound, latestValue, notePath, value });
    // `value` is read, not depended on: a keystroke changes it under the same
    // path and is the effect below's business, not this one's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notePath]);

  // The shared document, into the editor — see `bindSharedDocument`.
  useEffect(() => {
    return bindSharedDocument({ view, collab, bound, bindIfWaiting, latestValue, settledRef, presence });
    // `presence?.settled` is read through `bindIfWaiting` by the effect below
    // rather than listed here: naming it would tear down and rebuild a live
    // binding every time the room settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presence?.shared]);

  /*
    The room settling, into a binding that was waiting for it.

    Separate from the effect above because the two have different jobs: that
    one owns the binding's life, and this one is a single retry of the
    condition it stalled on. Folding them together would mean listing
    `settled` in those dependencies, which tears down a working binding and
    builds another — and `ySync` is a module-level plugin, so the rebuild is
    the stale-room bug the effect above was written to close.
  */
  useEffect(() => {
    bindIfWaiting.current?.();
  }, [presence?.settled]);

  /*
    The roster, into the editor.

    A `StateEffect` rather than a prop the extension reads, because CodeMirror
    state is not React's: the field holds the members and the decorations are
    computed from it, so a roster that arrives while somebody is mid-word
    redraws the carets without touching the document, the selection or the undo
    history.

    The dependency is the members array from `usePresence`, which is a new
    array only when something actually changed — the reducer returns the same
    state object for a frame it ignored, so a peer's heartbeat does not
    dispatch here.
  */
  useEffect(() => {
    const current = view.current;
    if (!current) return;
    current.dispatch({ effects: setRemoteCarets.of(presence?.members ?? []) });
  }, [presence?.members]);

  // An authoritative change from outside: a draft discarded, a conflict
  // resolved, a note arriving into an editor that is already on it.
  //
  // **Suspended while a shared document is bound.** The room is then the
  // authority for this note's text, and writing `value` over it would be two
  // sources fighting for one document — which shows up as your own typing
  // being replaced a moment after you type it. A *different note* is no longer
  // one of the cases this effect carries: it arrives one commit before the room
  // for it does, so the guard below was dropping it and the editor kept showing
  // the note before it. The `notePath` effect above owns that case, and takes
  // the binding down on its way. Never the echo of our own typing — that is
  // what the comparison is for, and without it the caret jumps to the end of
  // the document on every keystroke.
  useEffect(() => {
    const current = view.current;
    if (current === null) return;
    if (value === latestValue.current) return;

    /*
      **The guard the comment above promised, which was missing.**

      Review found this: the header said this effect stands down while a shared
      document is bound and there was no condition under it doing so. With a
      room live, `value` is the local draft — which for every client except the
      elected writer is *stale by construction*, because they deliberately stop
      calling `onChange`. Writing it over the document would replace everybody's
      text with one client's stale copy on the next unrelated re-render.

      `latestValue` is still updated first, so when the binding is torn down —
      a different note, a discarded draft — the next authoritative value is
      compared against what the editor actually holds rather than against
      whatever it held before the room existed.
    */
    latestValue.current = value;
    /*
      **Bound, not merely present.** This read `presence.shared`, which exists
      from the moment the hook runs — so the note arriving from the bucket was
      being refused by a room that had not answered, and on an empty note (or a
      deployment with no presence binding at all) by one that never would.
      `bound` is the question this was always asking.
    */
    if (bound.current) return;

    // Not an edit — a different note, a discarded draft, a resolved conflict —
    // and not an entry in the undo history either, or the bar's undo key steps
    // back into the note before this one. See `replaceDocument`.
    replaceDocument(current, value);
  }, [value]);

  useEffect(() => {
    const current = view.current;
    if (current === null) return;
    current.dispatch({
      effects: editableCompartment.current.reconfigure(editability(editable)),
    });
  }, [editable]);

  /*
    The find bar belongs to the document it was searching.

    This editor is built once and has notes swapped through it — that is what
    the effect above this one is for — so nothing takes a bar opened on one
    note down when another arrives, and what stays on screen is a query, a
    match count and highlights computed for a document that is no longer here.
    Keyed on the note rather than on `value`, because `value` changes on every
    keystroke and closing the bar while somebody types in it is worse than the
    bug.
  */
  useEffect(() => {
    const current = view.current;
    if (current === null) return;
    closeFindPanel(current);
  }, [notePath]);

  /*
    The menu belongs to the note it was opened over.

    Same argument as the find bar above, and the same failure without it: this
    editor is built once and has notes swapped through it, so a menu left
    standing across a note change is a set of verbs aimed at a document that is
    no longer here — and "Bold" would then wrap a selection in the *new* note at
    an offset taken from the old one.
  */
  useEffect(() => {
    setMenuAt(null);
    setTableAt(null);
  }, [notePath]);

  // One menu id, run against the live editor — see `runEditorMenuAction`.
  const runMenuAction = useCallback((id: EditorMenuId) => {
    runEditorMenuAction(id, { view, menuAt, setTableAt, handlers });
  }, [menuAt]);

  /*
    Stable identities, because the picker registers two `document` listeners
    keyed on them and this component re-renders on every keystroke — an inline
    arrow would tear those listeners down and rebuild them for each character
    typed into the note behind the picker.
  */
  const pickTableSize = useCallback(({ rows, columns }: { rows: number; columns: number }) => {
    const current = view.current;
    if (current === null || current.state.readOnly) return;
    // `rows` counts the header, which is the row the grid drew; the command
    // takes body rows. The subtraction lives here, once.
    /*
      The grid is drawn by the same transaction, and `insertTable` puts the
      caret in its first cell. Focusing the editor after that would take the
      caret straight back out of the cell — which is what it did, until a real
      browser typed into a table nobody was in.
    */
    if (!insertTable(current, rows - 1, columns)) current.focus();
  }, []);
  const closeTablePicker = useCallback(() => setTableAt(null), []);

  return (
    <>
      <div
        ref={host}
        className="cm-lp-root"
        aria-label={accessibilityLabel}
        style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
      />
      {menuAt === null || view.current === null ? null : (
        <Menu<EditorMenuId>
          /*
            The same call the `contextmenu` handler makes to decide whether to
            open at all, and it has to stay the same call: a menu that opened
            on one answer and drew another would offer rows the handler had
            already decided were not there — or, worse, open empty. The two are
            eight hundred lines apart, which is exactly why the arguments are
            spelled out identically in both rather than defaulted in one.
          */
          items={editorMenuItems({
            canEdit: !view.current.state.readOnly,
            hasSelection: !view.current.state.selection.main.empty,
            apple: isApplePlatform(),
            canDictate: onDictate !== undefined,
            canAsk: onAsk !== undefined,
            canList: view.current.state.facet(listHost)?.current != null,
          })}
          anchor={menuAt}
          title="Format"
          onSelect={runMenuAction}
          onDismiss={() => setMenuAt(null)}
        />
      )}
      {tableAt === null ? null : (
        <TableSizePicker anchor={tableAt} onPick={pickTableSize} onDismiss={closeTablePicker} />
      )}
    </>
  );
}

/**
 * A web link from the note, in a new browser tab.
 *
 * `noopener` so the page cannot reach back into this one through
 * `window.opener` — this tab holds somebody's notes. The desktop shell's
 * `setWindowOpenHandler` turns the same call into the person's real browser,
 * and allows only `http:`/`https:` itself.
 *
 * Checked again here although `noteLinks` only ever passes what `webUrl`
 * returned: this is the line that hands a string to the browser, and it should
 * not depend on its one caller staying careful.
 */
function openWebUrl(url: string): void {
  if (typeof window === "undefined" || webUrl(url) !== url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}
