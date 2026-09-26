/**
 * The right-click menu over the note body: the listener that decides whether
 * it opens, and the router that runs what was chosen.
 *
 * Both were written inline in `LiveEditor.web.tsx`, the listener inside the
 * effect that builds the editor and the router inside a `useCallback`. Both
 * are still *called* from exactly there, so when each is built and what it
 * closes over is unchanged.
 */

import type { EditorView } from "@codemirror/view";
import { isApplePlatform } from "../../../design/applePlatform";
import { writeClipboard } from "../../../design/clipboard";
import { editorMenuItems, LINE_PREFIXES, type EditorMenuId } from "../editorMenu";
import { MARKERS, toggleWrap } from "../markdownFormat";
import { runCommand } from "../editorSetup";
import { insertFolderList } from "../listBlock/insert";
import { listHost } from "../listBlock/model";
import type { EditorHandlers, MenuOpen, MenuPoint } from "./contract";
import { applySpellingFix, desktopSpeller, hasFinePointer, wordUnder, type SpellingFix } from "./spelling";

/** How long a right-click waits on the desktop checker before opening without it. */
const SPELLING_WAIT_MS = 250;

  /**
   * Right-click over the note body.
   *
   * A DOM listener on `contentDOM` rather than a CodeMirror
   * `domEventHandlers`, for the one reason that matters here: `noteLinks.ts`
   * already registers a `contextmenu` handler, and it answers a **long press
   * on a link** (WebKit reports one as a `contextmenu`). Its press must keep
   * winning, so this checks `defaultPrevented` and stands down — the same
   * shape as `useKeymap.web.ts`'s guard, and the same sentence: a press
   * something has already answered is not this one's to answer again.
   *
   * ## Three things it deliberately does not do
   *
   *  - **Shift-right-click falls through to the browser.** In a browser,
   *    spelling suggestions live in the browser's own menu and nowhere else,
   *    and spellcheck is on in this editor by decision (P1 in the editor
   *    sweep) — so replacing that menu unconditionally would have taken away
   *    the feature somebody deliberately turned on. Firefox already spells
   *    this chord the same way; the other engines learn it here, and the menu
   *    says so in its last row. The desktop app asks the operating system's
   *    checker instead and puts the suggestions at the top (`spelling.ts`).
   *  - **It never suppresses a menu it will not answer.** A read-only note
   *    with nothing selected has no verbs, `editorMenuItems` returns an empty
   *    list, and the browser's menu opens instead of an empty box.
   *    `rowInteractions.web.ts` states the same rule for the file tree.
   *  - **It does not move the caret out of a selection.** Right-clicking
   *    inside the selected text keeps that selection, which is what Copy and
   *    Bold are then about. Clicking anywhere else puts the caret where the
   *    click landed — explicitly, because the engines disagree about whether
   *    a right button places a caret in a contenteditable at all, and a
   *    formatting menu that acts three lines from where somebody clicked is
   *    worse than none.
   */
export function contextMenuListener({
  created,
  handlers,
  setMenuAt,
  setTableAt,
}: {
  created: EditorView;
  handlers: { current: EditorHandlers };
  setMenuAt: (at: MenuOpen | null) => void;
  setTableAt: (at: MenuPoint | null) => void;
}): (event: MouseEvent) => void {
  /*
    Which right-click is the latest. The checker answers through a promise, and
    a second right-click before the first answer lands must not have its menu
    replaced by the first one's.
  */
  let latest = 0;

  const onContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (event.shiftKey) return;

    const at = { x: event.clientX, y: event.clientY };
    /*
      `posAtCoords` measures, and measuring is the one thing that can fail
      here: it reads client rectangles off ranges, which a document that has
      not been laid out does not have. A throw inside this listener would
      cost the whole menu rather than the caret move, so an unanswerable
      position is `null` and the selection is simply left where it is.
    */
    let position: number | null = null;
    try {
      position = created.posAtCoords(at);
    } catch {
      position = null;
    }
    const selection = created.state.selection.main;
    const inSelection =
      !selection.empty && position !== null && position >= selection.from && position <= selection.to;
    if (!inSelection && position !== null && !created.state.readOnly) {
      created.dispatch({ selection: { anchor: position } });
    }

    const empty =
      editorMenuItems({
        canEdit: !created.state.readOnly,
        hasSelection: !created.state.selection.main.empty,
        apple: isApplePlatform(),
        /*
          Read through `handlers`, not from the closure, for the reason that
          ref exists: this listener is attached once when the view is created
          and the props it reads change under it — a note going read-only, a
          window narrowing out of the density that has a panel. A closure
          captured at creation would offer Dictate on a note that had since
          become somebody else's to read.
        */
        canDictate: handlers.current.onDictate !== undefined,
        canAsk: handlers.current.onAsk !== undefined,
        canList: created.state.facet(listHost)?.current != null,
      }).length === 0;
    if (empty) {
      /*
        Standing down closes whatever this menu already had open.

        Without it a right-click that falls through to the browser leaves the
        previous popover sitting there — two menus on the glass, one of them
        about a caret that has moved. Found by the test that drives a
        capability away under a mounted editor; the same line covers
        Shift-right-click, where it is just as true.
      */
      setMenuAt(null);
      setTableAt(null);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setTableAt(null);

    const canEdit = !created.state.readOnly;
    const check = canEdit ? desktopSpeller() : null;
    const target =
      check !== null && created.state.selection.main.empty
        ? wordUnder(created.state, position)
        : null;
    const ticket = ++latest;
    if (check === null || target === null) {
      setMenuAt({ ...at, spellingHint: canEdit && check === null && hasFinePointer() });
      return;
    }

    /*
      The menu opens once, with the checker's answer — not empty and then
      again with suggestions pushed in above the row somebody was reaching
      for. The desktop checker answers synchronously behind the promise, so
      the wait is a microtask; the timer is for a checker that never answers,
      which still gets a menu, just without suggestions.
    */
    let opened = false;
    const open = (spelling: SpellingFix | null) => {
      if (opened || ticket !== latest) return;
      opened = true;
      setMenuAt({ ...at, spelling });
    };
    check(target.word).then(
      (answer) =>
        open(
          answer.misspelled && created.state.sliceDoc(target.from, target.to) === target.word
            ? { ...target, suggestions: answer.suggestions }
            : null,
        ),
      () => open(null),
    );
    setTimeout(() => open(null), SPELLING_WAIT_MS);
  };
  return onContextMenu;
}

/**
 * One menu id, run against the live editor.
 *
 * Every arm goes through the same two modules the keymap and the accessory
 * bar go through — `runCommand` for the verbs that already existed, and
 * `markdownFormat.ts` for the markers — so this is a *router*, not a third
 * implementation of markdown editing. That matters beyond tidiness:
 * `NoteEditor` re-attaches a note's frontmatter in front of every edit on a
 * phone, so an arm that wrote to the buffer by any other route would silently
 * drop the YAML block of every captured note (`noteAccessory.test.ts` pins
 * exactly that for the bar).
 *
 * `readOnly` is checked once, here, and again inside `runCommand` and again
 * by `editability`'s `changeFilter`. That is three gates for one rule and all
 * three are wanted — see `editability`, which argues it at length. The menu's
 * own contribution is that Copy stays available on a note nobody may write.
 */
export function runEditorMenuAction(
  id: EditorMenuId,
  {
    view,
    menuAt,
    setTableAt,
    handlers,
  }: {
    view: { current: EditorView | null };
    menuAt: MenuOpen | null;
    setTableAt: (at: MenuPoint | null) => void;
    handlers: { current: EditorHandlers };
  },
): void {
  const current = view.current;
  if (current === null) return;

  if (id === "copy" || id === "cut") {
    const { from, to } = current.state.selection.main;
    const text = current.state.sliceDoc(from, to);
    if (text !== "") {
      /*
        Fire-and-forget deliberately. `writeClipboard` already falls back to
        `execCommand` where the async API is refused, and there is nowhere in
        this component to report a failure to — the editor has no toast. A
        cut whose copy failed would be the one unacceptable outcome, so the
        delete waits for the answer and is skipped if it never came.
      */
      void writeClipboard(text).then((ok) => {
        if (!ok || id !== "cut") return;
        const editor = view.current;
        if (editor === null || editor.state.readOnly) return;
        /*
          The positions were read before an `await`, and an autosave
          conflict or a note being opened underneath can replace the
          document in that window. Deleting a range that no longer holds
          what was copied would take out whatever moved into it, so the
          range has to still say what it said — and if it does not, the
          copy stands and nothing is removed.
        */
        if (editor.state.sliceDoc(from, to) !== text) return;
        editor.dispatch({ changes: { from, to, insert: "" }, userEvent: "delete.cut" });
      });
    }
    current.focus();
    return;
  }

  if (id.startsWith("spelling:")) {
    const fix = menuAt?.spelling ?? null;
    const suggestion = fix?.suggestions[Number(id.slice("spelling:".length))];
    if (fix !== null && suggestion !== undefined) applySpellingFix(current, fix, suggestion);
    current.focus();
    return;
  }

  if (id === "table") {
    setTableAt(menuAt === null ? null : { x: menuAt.x, y: menuAt.y });
    return;
  }

  if (id === "folderList") {
    insertFolderList(current);
    return;
  }

  if (id === "dictate") {
    /*
      The caret, not the selection's head. The menu put the caret where the
      click landed (see the `contextmenu` handler), so this is where somebody
      pointed — and handing the host a position rather than letting it ask
      later is what stops the words arriving wherever the caret drifted to
      while a permission prompt was up.
    */
    handlers.current.onDictate?.(current.state.selection.main.head);
    current.focus();
    return;
  }

  if (id === "ask") {
    // No `focus()`: the answer arrives in the panel, and pulling the caret
    // back into the note would put the keyboard over it on a narrow window.
    handlers.current.onAsk?.();
    return;
  }

  const marker = id === "bold" || id === "italic" || id === "strikethrough" || id === "code"
    ? MARKERS[id]
    : null;
  if (marker !== null) {
    if (!current.state.readOnly) toggleWrap(current, marker.before, marker.after);
    current.focus();
    return;
  }

  if (id === "link") {
    runCommand(current, { name: "insertLink" });
    return;
  }

  const prefix = LINE_PREFIXES[id];
  if (prefix !== undefined) {
    runCommand(current, { name: "toggleLinePrefix", prefix });
    return;
  }
  // `heading` is the submenu's own id and is never dispatched — `Menu` opens
  // its `items` instead. Reaching here with it is a no-op rather than a
  // silent rewrite of the caret's line, which is the whole reason it is not
  // spelled `heading1`. See `editorMenu.ts`.
}
