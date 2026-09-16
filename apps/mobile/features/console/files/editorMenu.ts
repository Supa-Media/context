/**
 * What right-clicking inside a note offers, as data.
 *
 * The same shape and the same argument as `menu.ts`, which is the file tree's
 * menu: a pure model, so the two rules that actually matter are checkable
 * without a renderer, and one list rendered by `Menu.web.tsx` — which draws a
 * popover at the pointer on a wide window and a bottom sheet on a narrow one,
 * so the same menu serves a right-click and a long press without this file
 * knowing which happened.
 *
 * The rules it inherits, because they are the same rules:
 *
 *  - **Read-only means absent, not disabled.** `privacy.md`, an encrypted note,
 *    and a workspace `member` reading somebody else's context all arrive here
 *    with `canEdit: false`. A menu of greyed-out formatting rows tells them
 *    their editor is broken; a two-row menu tells them the truth.
 *  - **Chords are printed from `keymap.ts`, never from a literal here.** That
 *    module's own doc explains why: a table of `"⌘B"` strings twelve lines from
 *    the items is how a menu ends up advertising a keystroke nothing binds, and
 *    it is also how a Windows console ends up printing `⌘`.
 *
 * ## What is deliberately not on it
 *
 * **Paste.** Reading the clipboard is a permission prompt in Chrome and a
 * second confirmation in Safari, and it is refused outright on an insecure
 * origin — so a Paste row would be a control that works for some people, some
 * of the time, with nothing useful to say when it does not. ⌘V is unaffected
 * and is what everybody uses. "An absent capability is reported honestly; it is
 * never faked" cuts the other way here: the honest thing is not to offer it.
 *
 * **Every heading level, and the browser's own menu.** Headings stop at three
 * because a menu is a list somebody reads, and `# ` through `###### ` is a
 * submenu nobody scans. Spelling suggestions, Paste, Inspect and the rest of
 * the browser's menu are one **Shift-right-click** away — `LiveEditor.web.tsx`
 * leaves that chord alone precisely so this menu is never the *only* menu, and
 * spellcheck is on in this editor by deliberate decision (P1 in the sweep).
 */

import { describeBinding, type Command } from "../../design/keymap";
import type { MenuItem } from "./menu";

export type EditorMenuId =
  | "cut"
  | "copy"
  | "bold"
  | "italic"
  | "strikethrough"
  | "code"
  | "link"
  /**
   * The submenu's own id, and deliberately not `heading1`.
   *
   * The same trap `menu.ts` records for `visibility`: a parent row is never
   * dispatched — the caller opens its `items` instead — but a dispatcher that
   * forgot to check `items` would run whichever real id the parent carried. An
   * id with no handler is a no-op; an id with the wrong handler silently
   * rewrites the line somebody right-clicked.
   */
  | "heading"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "numberedList"
  | "task"
  | "quote"
  | "table";

export interface EditorMenuContext {
  /** False for `privacy.md`, an encrypted note, and a reader in someone else's context. */
  canEdit: boolean;
  /** Whether anything is selected. Decides Cut and Copy, and nothing else. */
  hasSelection: boolean;
  /** `⌘B` rather than `Ctrl+B`. Read from the browser by the caller. */
  apple: boolean;
}

/** The chord a row prints, or nothing — which `describeBinding` treats as legitimate. */
function chord(command: Command, apple: boolean): { shortcut: string } | undefined {
  const described = describeBinding(command, apple);
  return described === null ? undefined : { shortcut: described };
}

/**
 * The menu for one right-click.
 *
 * **An empty array is a real answer**, and the caller has to honour it rather
 * than opening an empty popover: a read-only note with nothing selected has no
 * verbs at all, and the right behaviour there is to let the browser's own menu
 * open. `rowInteractions.web.ts` states the same rule for the tree — never
 * suppress a menu you are not going to answer.
 *
 * Cut and Copy have no chord printed beside them on purpose. ⌘C and ⌘X here are
 * the *browser's* text bindings, not this app's — `keymap.ts` binds those two
 * letters to copying and cutting a **file** in the tree — and printing a
 * coincidence as if it were a binding is how the next reader learns something
 * untrue about where chords come from.
 */
export function editorMenuItems(context: EditorMenuContext): MenuItem<EditorMenuId>[] {
  const { canEdit, hasSelection, apple } = context;
  const items: MenuItem<EditorMenuId>[] = [];

  if (hasSelection) {
    if (canEdit) items.push({ id: "cut", label: "Cut" });
    items.push({ id: "copy", label: "Copy" });
  }

  if (!canEdit) return items;

  const separatorBefore = items.length > 0;
  items.push(
    { id: "bold", label: "Bold", separatorBefore, ...chord("bold", apple) },
    { id: "italic", label: "Italic", ...chord("italic", apple) },
    { id: "strikethrough", label: "Strikethrough", ...chord("strikethrough", apple) },
    { id: "code", label: "Code" },

    { id: "link", label: "Link to a note", separatorBefore: true },

    {
      id: "heading",
      label: "Heading",
      separatorBefore: true,
      items: [
        { id: "heading1", label: "Heading 1" },
        { id: "heading2", label: "Heading 2" },
        { id: "heading3", label: "Heading 3" },
      ],
    },
    { id: "bulletList", label: "Bulleted list" },
    { id: "numberedList", label: "Numbered list" },
    { id: "task", label: "Task checkbox" },
    { id: "quote", label: "Quote" },

    // The ellipsis is the menu convention for "this asks you something first" —
    // here, how many rows and columns. See `TableSizePicker.web.tsx`.
    { id: "table", label: "Table…", separatorBefore: true },
  );

  return items;
}

/**
 * The line prefix each block row writes, in one place.
 *
 * A map rather than a `switch` in the component for the reason this whole
 * module is data: "what does Quote insert" is answerable in a test that runs in
 * plain node, and the answer cannot drift from what the menu offers because the
 * keys of this object and the ids above are the same union.
 */
export const LINE_PREFIXES: Readonly<Partial<Record<EditorMenuId, string>>> = {
  heading1: "# ",
  heading2: "## ",
  heading3: "### ",
  bulletList: "- ",
  numberedList: "1. ",
  task: "- [ ] ",
  quote: "> ",
};
