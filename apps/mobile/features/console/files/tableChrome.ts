/**
 * The controls on a drawn table, and why they hang off the rows and columns
 * rather than off the table.
 *
 * The first version was a bar of four buttons above the grid — add row, add
 * column, delete row, delete column — acting on *the last cell that had the
 * caret*. The report it earned was "deleting a row is not really possible",
 * and measuring it in a browser found two failures rather than one:
 *
 *  - The obvious gesture, hover the table and press "delete row", does
 *    nothing at all: the button is disabled until a cell has been focused,
 *    and a disabled button explains nothing.
 *  - Worse, once a cell *had* been focused the button stayed armed after the
 *    caret left the table entirely, so a press deleted a row chosen by
 *    something the person stopped thinking about three clicks ago.
 *
 * Both are the same mistake: **a destructive control whose target is not on
 * screen.** So every control here belongs to the thing it acts on. A handle in
 * the gutter beside a row acts on that row and highlights it while its menu is
 * open; a handle above a column acts on that column; the corner acts on the
 * table. Nothing is disabled waiting for state nobody can see, and nothing
 * acts on a row the pointer is nowhere near.
 *
 * ## Why a menu rather than more buttons
 *
 * A row has five things worth doing to it and a column has eight. Drawn as
 * buttons that is a toolbar per row, which is both unreadable and wider than
 * most tables. A handle is one affordance per row, and the menu it opens is
 * where the verbs are named in words rather than in glyphs nobody can decode.
 *
 * ## What this module is not
 *
 * It holds no CodeMirror and no Markdown. It draws DOM, asks a host what the
 * grid currently looks like, and hands actions back — so the interesting
 * behaviour is testable without an editor, which is the same split
 * `tableEdit.ts` makes for the writes.
 */

import type { ColumnAlign } from "./tableEdit";

/** Everything a handle needs to know, answered fresh at press time. */
export interface GridChromeHost {
  /** Body rows in the table as it is now. The header is not one of them. */
  rows(): number;
  columns(): number;
  align(column: number): ColumnAlign;
  /** The drawn cells of a row, or of a column, for highlighting a target. */
  cellsOfRow(row: number): HTMLElement[];
  cellsOfColumn(column: number): HTMLElement[];
  run(action: GridAction): void;
}

/** Everything a person can ask of a table's shape. */
export type GridAction =
  | { kind: "insert-row"; at: number; where: "above" | "below" }
  | { kind: "delete-row"; at: number }
  | { kind: "move-row"; at: number; by: -1 | 1 }
  | { kind: "insert-column"; at: number; where: "left" | "right" }
  | { kind: "delete-column"; at: number }
  | { kind: "move-column"; at: number; by: -1 | 1 }
  | { kind: "align-column"; at: number; align: ColumnAlign }
  | { kind: "edit-source" }
  | { kind: "delete-table" };

/** One row of a menu. */
interface MenuItem {
  readonly label: string;
  readonly run: () => void;
  /** Marked as the current state — the alignment a column already has. */
  readonly current?: boolean;
  /** Drawn in the destructive colour, and always last in its group. */
  readonly destructive?: boolean;
}

/** The custom properties a menu is drawn in; see `showMenu`. */
const PALETTE = [
  "--lp-bg",
  "--lp-content",
  "--lp-muted",
  "--lp-line-strong",
  "--lp-code-bg",
  "--lp-danger",
  "--lp-body",
] as const;

/*
  One menu at a time, for the whole document. Two open menus is two answers to
  "what does Escape close", and a person who presses a second handle means the
  second one.
*/
let openMenu: { element: HTMLElement; dismiss: () => void } | null = null;

/** Close whatever menu is open, if any. */
export function closeGridMenu(): void {
  openMenu?.dismiss();
}

/**
 * The gutter handle for one body row.
 *
 * Its own row is in its label, because a screen reader hears the handles in a
 * column of their own where the visual relationship is gone: "Row 2 actions"
 * says which one this is.
 */
export function rowHandle(host: GridChromeHost, row: number): HTMLButtonElement {
  return handle(`Row ${row + 1} actions`, "⋮", () => {
    const rows = host.rows();
    const items: MenuItem[] = [
      { label: "Insert row above", run: () => host.run({ kind: "insert-row", at: row, where: "above" }) },
      { label: "Insert row below", run: () => host.run({ kind: "insert-row", at: row, where: "below" }) },
    ];
    // Off the end is left out rather than disabled: a menu is a list of what
    // can be done, and the first row has nothing above it.
    if (row > 0) items.push({ label: "Move row up", run: () => host.run({ kind: "move-row", at: row, by: -1 }) });
    if (row < rows - 1) {
      items.push({ label: "Move row down", run: () => host.run({ kind: "move-row", at: row, by: 1 }) });
    }
    items.push({
      label: "Delete row",
      destructive: true,
      run: () => host.run({ kind: "delete-row", at: row }),
    });
    return { items, target: () => host.cellsOfRow(row) };
  });
}

/** The handle above one column, in the strip over the header. */
export function columnHandle(host: GridChromeHost, column: number): HTMLButtonElement {
  return handle(`Column ${column + 1} actions`, "⋯", () => {
    const columns = host.columns();
    const align = host.align(column);
    const items: MenuItem[] = [
      {
        label: "Insert column left",
        run: () => host.run({ kind: "insert-column", at: column, where: "left" }),
      },
      {
        label: "Insert column right",
        run: () => host.run({ kind: "insert-column", at: column, where: "right" }),
      },
    ];
    if (column > 0) {
      items.push({ label: "Move column left", run: () => host.run({ kind: "move-column", at: column, by: -1 }) });
    }
    if (column < columns - 1) {
      items.push({ label: "Move column right", run: () => host.run({ kind: "move-column", at: column, by: 1 }) });
    }
    /*
      Alignment is here and nowhere else. A Markdown table keeps it in the
      delimiter row, which is the one row the grid never draws, so before this
      there was no way to set it from the app at all.
    */
    items.push(
      { label: "Align left", current: align === "left", run: () => host.run({ kind: "align-column", at: column, align: "left" }) },
      { label: "Align centre", current: align === "center", run: () => host.run({ kind: "align-column", at: column, align: "center" }) },
      { label: "Align right", current: align === "right", run: () => host.run({ kind: "align-column", at: column, align: "right" }) },
      { label: "No alignment", current: align === null, run: () => host.run({ kind: "align-column", at: column, align: null }) },
    );
    if (columns > 1) {
      items.push({
        label: "Delete column",
        destructive: true,
        run: () => host.run({ kind: "delete-column", at: column }),
      });
    }
    return { items, target: () => host.cellsOfColumn(column) };
  });
}

/**
 * The corner handle, which is the table's own.
 *
 * "Edit as text" is the important one and is the escape hatch for everything
 * this menu does not do. A drawn table is an atomic range, so the caret cannot
 * get inside it: without a way back to the pipes, anything the controls have
 * no verb for — a stray escape, a row the parser refuses, a column somebody
 * wants to rewrite wholesale — could only be fixed by another app.
 */
export function tableHandle(host: GridChromeHost): HTMLButtonElement {
  return handle("Table actions", "⌗", () => ({
    items: [
      { label: "Edit as text", run: () => host.run({ kind: "edit-source" }) },
      { label: "Delete table", destructive: true, run: () => host.run({ kind: "delete-table" }) },
    ],
    target: () => [],
  }));
}

/** A plain button for the two appends, which need no menu to be unambiguous. */
export function appendButton(label: string, text: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-lp-grid-add";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = text;
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    closeGridMenu();
    run();
  });
  return button;
}

/* -------------------------------------------------------------------------- */

function handle(
  label: string,
  glyph: string,
  open: () => { items: MenuItem[]; target: () => HTMLElement[] },
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-lp-grid-handle";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-haspopup", "menu");
  button.textContent = glyph;
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    const mine = openMenu !== null && openMenu.element.dataset.lpFor === label;
    closeGridMenu();
    // A second press on the same handle closes it, which is what every menu
    // button in this app does.
    if (mine) return;
    const { items, target } = open();
    showMenu(button, label, items, target());
  });
  return button;
}

/**
 * Draw a menu under a handle.
 *
 * Positioned against the viewport and appended to the document rather than to
 * the grid, because the grid scrolls its own overflow: a menu inside it would
 * be clipped by the same box that cut the first version of this chrome in
 * half. Closed by a press outside it, by Escape, by a scroll, and by acting.
 */
function showMenu(
  button: HTMLButtonElement,
  label: string,
  items: readonly MenuItem[],
  target: readonly HTMLElement[],
): void {
  const document_ = button.ownerDocument;
  const menu = document_.createElement("div");
  menu.className = "cm-lp-grid-menu";
  menu.dataset.lpFor = label;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);

  for (const cell of target) cell.classList.add("cm-lp-grid-target");

  const dismiss = (): void => {
    if (openMenu?.element !== menu) return;
    openMenu = null;
    for (const cell of target) cell.classList.remove("cm-lp-grid-target");
    menu.remove();
    document_.removeEventListener("pointerdown", outside, true);
    document_.removeEventListener("keydown", onKey, true);
    document_.defaultView?.removeEventListener("scroll", dismiss, true);
    document_.defaultView?.removeEventListener("resize", dismiss);
  };

  const outside = (event: Event): void => {
    const at = event.target;
    if (at instanceof Node && (menu.contains(at) || button.contains(at))) return;
    dismiss();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    dismiss();
    button.focus();
  };

  items.forEach((item, index) => {
    const row = document_.createElement("button");
    row.type = "button";
    row.setAttribute("role", "menuitem");
    row.className = item.destructive
      ? "cm-lp-grid-menu-item cm-lp-grid-menu-destructive"
      : "cm-lp-grid-menu-item";
    if (item.current === true) row.classList.add("cm-lp-grid-menu-current");
    row.textContent = item.label;
    row.addEventListener("click", (event) => {
      event.preventDefault();
      dismiss();
      item.run();
    });
    row.addEventListener("keydown", (event) => {
      /*
        Up and down walk the menu. Written here rather than left to the
        browser because these are buttons in a div: nothing else makes a
        keyboard user's first press of Down go to the second item rather than
        out of the menu entirely.
      */
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const rows = [...menu.querySelectorAll<HTMLElement>(".cm-lp-grid-menu-item")];
      const next = rows[(index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length];
      next?.focus();
    });
    menu.append(row);
  });

  /*
    THE PALETTE, CARRIED WITH IT.

    Every `--lp-*` this menu is drawn in is declared on the editor's own root,
    and the menu is on the document's body — outside it, where an unknown
    custom property does not fall back and does not error: it invalidates the
    whole declaration. Measured in Chromium, that is a menu with no background
    at all, with the note's own text showing through its items. Exactly the
    defect `app-and-console.md` records as "white text on a white ground",
    reached from the other direction.

    So the properties travel to the element. Read from the handle, which is
    inside the editor, and set inline on the menu.
  */
  const inherited = button.ownerDocument.defaultView?.getComputedStyle(button);
  if (inherited !== undefined) {
    for (const name of PALETTE) {
      const value = inherited.getPropertyValue(name);
      if (value !== "") menu.style.setProperty(name, value);
    }
    /*
      And the size, which is in `em` everywhere in the editor because the note
      scales as a whole. On the body that em is the browser's default rather
      than the note's, so the one length that cannot be inherited is resolved
      here into pixels.
    */
    const size = Number.parseFloat(inherited.fontSize);
    if (Number.isFinite(size) && size > 0) menu.style.fontSize = `${Math.round(size * 1.05)}px`;
  }

  const box = button.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${Math.round(box.bottom + 4)}px`;
  menu.style.left = `${Math.round(box.left)}px`;
  document_.body.append(menu);

  /*
    Nudged back inside the window if it hangs off the right edge. A column
    handle on the last column of a wide table is exactly where this happens,
    and a menu half off the screen is the defect this chrome was rewritten to
    stop making.
  */
  const drawn = menu.getBoundingClientRect();
  const width = document_.defaultView?.innerWidth ?? 0;
  if (width > 0 && drawn.right > width - 8) {
    menu.style.left = `${Math.max(Math.round(width - drawn.width - 8), 8)}px`;
  }

  openMenu = { element: menu, dismiss };
  document_.addEventListener("pointerdown", outside, true);
  document_.addEventListener("keydown", onKey, true);
  document_.defaultView?.addEventListener("scroll", dismiss, true);
  document_.defaultView?.addEventListener("resize", dismiss);
  menu.querySelector<HTMLElement>(".cm-lp-grid-menu-item")?.focus();
}
