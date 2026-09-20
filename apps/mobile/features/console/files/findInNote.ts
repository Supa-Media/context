/**
 * Find-in-note: the keymap, the panel, and the ways out of it.
 *
 * ## Where this started
 *
 * `@codemirror/search` was not in the bundle's dependency list and no search
 * binding existed at all, so ⌘F/Ctrl-F fell through to the browser's own
 * Find — which searches only the lines CodeMirror has actually rendered, and
 * silently misses on a long note. K2 in the sweep bound CodeMirror's own
 * search panel and nothing more: no toolbar key, no UI of this app's own, on
 * the argument that a discoverable entry point is a decision for later, once
 * the binding exists to discover.
 *
 * Later arrived as a report: *"cmd f looks really ugly and isn't
 * dismissable."* Both halves are real, and they are different bugs.
 *
 *  - **Ugly** is the stock panel. CodeMirror's base theme paints a light grey
 *    strip with browser-default `input`, `button` and checkbox controls, and
 *    the console around it is painted from `tokens.ts`. Every other overlay in
 *    this editor — the completion list, the link affordance, a plugin's
 *    preview — carries an `EditorView.theme` naming `--lp-*` custom
 *    properties. This one carried none, so it was the one thing on screen that
 *    could not follow the app from light to dark.
 *  - **Not dismissable** is the keymap. `searchKeymap`'s Escape is scoped to
 *    `editor` and `search-panel`, which covers the caret being in the note or
 *    in the query field and nothing else. Click a tree row, a tab or the
 *    accessory bar and Escape reaches the console's `dismiss` command instead
 *    — `frame.closeOverlays()`, which had never heard of this panel. And ⌘F
 *    could not put it away either: `openSearchPanel` is idempotent, so the
 *    chord everybody presses twice only refocuses the field.
 *
 * So: a panel of Context's own, `Mod-f` that toggles, and `closeFindPanel` for
 * an Escape that landed anywhere else in the console. The frame's overlay
 * stack reaches it through `EditorControls.closeFind` (`LiveEditor.web.tsx`),
 * which is what makes `keymap.ts`'s promise — Escape "closes whatever is open,
 * wherever you are" — true for this panel rather than aspirational.
 *
 * ## Still web only, and still its own module
 *
 * `editorSetup.ts` is compiled twice — once by Metro for the browser, once by
 * esbuild into the iOS guest bundle (`webview/bundle.generated.ts`), which
 * ships to every phone over the air. A find bar needs real screen space, a
 * text input and a close control that the accessory bar has nowhere to put
 * yet, so this ships only to the surface that already has room for a floating
 * bar over a wide document. Keeping it out of `editorSetup.ts` is not just
 * "unused on native" — it means `webview/entry.ts` never imports this file, so
 * esbuild never traces into `@codemirror/search` at all and
 * `bundle.generated.ts` is untouched: the native guest bundle is
 * byte-identical, not merely unaffected in behaviour. A custom panel is more
 * code *in this module*, never a new import in the shared list, and
 * `findInNote.test.ts` pins that against the committed source of both halves.
 *
 * A touch entry point is still an open decision. `keymap.ts` requires every
 * command it names to be reachable without a keyboard; this one is not, which
 * is exactly why it does not ship to the phone.
 */

import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";
import {
  EditorView,
  keymap,
  runScopeHandlers,
  type Command,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * ⌘F/Ctrl-F opens the find bar and closes it again; Escape closes it from the
 * note or the query field; `closeFindPanel` closes it from anywhere else.
 */
export function findInNote(): Extension {
  return [
    search({ createPanel: (view) => new FindPanel(view) }),
    /*
      Ours first. Two keymaps both binding `Mod-f` are tried in order, and
      `searchKeymap`'s binding is `openSearchPanel` — which cannot close
      anything. `findInNote.test.ts` presses the chord twice and asserts the
      bar is gone, which is the guard for this ordering rather than this
      comment.
    */
    keymap.of([{ key: "Mod-f", run: toggleFind, scope: "editor search-panel" }]),
    keymap.of(searchKeymap),
    findTheme,
  ];
}

/**
 * Put the find bar away, and say whether there was one.
 *
 * The boolean is the contract `closeOverlays` is built on: Escape with nothing
 * open must reach the browser rather than being swallowed, so a closer that
 * closed nothing has to say so. Takes the view rather than an event because
 * the press it answers landed somewhere else entirely — a tree row, a tab, the
 * accessory bar — and never reached this editor's DOM at all.
 */
export function closeFindPanel(view: EditorView): boolean {
  if (!searchPanelOpen(view.state)) return false;
  return closeSearchPanel(view);
}

/**
 * ⌘F on a bar that already has the caret means "put it away".
 *
 * Deliberately not "toggle whenever the panel is open": with the bar up and
 * the caret back in the note, ⌘F means "take me to the query field" — which is
 * what `openSearchPanel` does, and what somebody reaching for the bar expects.
 * Closing there would take it away from the press meant to reach it.
 */
const toggleFind: Command = (view) => {
  if (searchPanelOpen(view.state) && fieldHasFocus(view)) return closeSearchPanel(view);
  return openSearchPanel(view);
};

function fieldHasFocus(view: EditorView): boolean {
  const field = view.dom.querySelector(`.${BAR} [main-field]`);
  return field !== null && field === view.root.activeElement;
}

/* -------------------------------------------------------------------------- */

const BAR = "cm-ctx-find";

/**
 * How many matches are counted before the count stops being a number.
 *
 * The count is recomputed on every transaction while the bar is open, which
 * includes every keystroke in the note, and counting means walking the whole
 * document. A cap bounds that at a constant rather than at the length of
 * whatever somebody opened — and "1000+" is as useful an answer as the true
 * number would have been.
 */
const MATCH_CAP = 1000;

/**
 * The toggles, in the order they are drawn.
 *
 * Labels rather than icons: `Aa`, `|ab|` and `.*` are what every editor with a
 * find bar draws, and a person who knows one knows these. The `aria-label` is
 * the affordance for everybody else — the stock panel's checkboxes had a text
 * label each, which is the one thing it did better than a row of icons would.
 */
const TOGGLES: readonly {
  /** The `SearchQuery` flag this sets, which is also how it is read back. */
  key: "caseSensitive" | "wholeWord" | "regexp";
  /** What is drawn in the button. */
  glyph: string;
  /** What it is called, to a screen reader and on hover. */
  label: string;
}[] = [
  { key: "caseSensitive", glyph: "Aa", label: "Match case" },
  { key: "wholeWord", glyph: "|ab|", label: "Whole word" },
  { key: "regexp", glyph: ".*", label: "Regular expression" },
];

type ToggleKey = (typeof TOGGLES)[number]["key"];

/**
 * The find bar.
 *
 * A `Panel` rather than a floating widget of our own because CodeMirror
 * already owns the lifecycle — mounted with the search state, torn down with
 * it, told about every transaction — and a second mechanism beside it would be
 * a second thing to keep in step with the query. What the theme below changes
 * is where the panel container sits: over the document rather than in a band
 * above it, so opening the bar does not move the line somebody is reading.
 */
class FindPanel implements Panel {
  readonly dom: HTMLDivElement;
  /** Over the document, at the top. See `findTheme`. */
  readonly top = true;

  private readonly view: EditorView;
  private readonly field: HTMLInputElement;
  private readonly count: HTMLSpanElement;
  private readonly toggles = new Map<ToggleKey, HTMLButtonElement>();
  /** What the editor's search state currently holds, as this panel last saw it. */
  private query: SearchQuery;

  constructor(view: EditorView) {
    this.view = view;
    this.query = getSearchQuery(view.state);

    this.field = document.createElement("input");
    this.field.className = "cm-ctx-find-field";
    this.field.type = "text";
    this.field.value = this.query.search;
    this.field.placeholder = "Find";
    this.field.autocomplete = "off";
    this.field.spellcheck = false;
    this.field.setAttribute("aria-label", "Find in note");
    // `openSearchPanel` finds the field to focus by this attribute, so the
    // stock command still lands in the right place on a panel it did not build.
    this.field.setAttribute("main-field", "true");
    this.field.addEventListener("input", () => this.commit());

    this.count = document.createElement("span");
    this.count.className = "cm-ctx-find-count";
    // Announced rather than only drawn: "no results" is the answer to what was
    // just typed, and somebody using a screen reader is the person least able
    // to see that nothing highlighted.
    this.count.setAttribute("aria-live", "polite");

    this.dom = document.createElement("div");
    this.dom.className = BAR;
    this.dom.setAttribute("role", "search");
    this.dom.setAttribute("aria-label", "Find in note");
    this.dom.append(this.field, this.count, separator());

    for (const toggle of TOGGLES) {
      const button = textButton(toggle.glyph, toggle.label);
      button.addEventListener("click", () => {
        this.commit({ [toggle.key]: !this.query[toggle.key] });
        // Back to the field: a person toggling `Aa` is still typing a query,
        // and leaving the caret on the button means the next keystroke goes
        // nowhere.
        this.field.focus();
      });
      this.toggles.set(toggle.key, button);
      this.dom.append(button);
    }

    this.dom.append(
      separator(),
      iconButton(CHEVRON_UP, "Previous match", () => findPrevious(this.view)),
      iconButton(CHEVRON_DOWN, "Next match", () => findNext(this.view)),
      iconButton(CROSS, "Close find", () => closeSearchPanel(this.view)),
    );

    this.dom.addEventListener("keydown", (event) => this.keydown(event));
    this.draw();
  }

  mount(): void {
    this.field.focus();
    this.field.select();
  }

  update(update: ViewUpdate): void {
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) this.sync(effect.value);
      }
    }
    // The count depends on the document and on where the selection is, so it is
    // recomputed on any transaction that moved either — which includes the
    // selection `findNext` just made, and that is how the "2/3" advances.
    if (update.docChanged || update.selectionSet) this.count.textContent = this.summary();
  }

  /**
   * What the controls now describe, into the editor's search state.
   *
   * The query is the one source of truth for the flags — the buttons draw it
   * rather than hold it, which is why a toggle passes the flag it wants rather
   * than reading its own `aria-pressed` back. A control that stores state in
   * its own markup is a control that disagrees with the editor the first time
   * something else sets the query.
   */
  private commit(flags: Partial<Record<ToggleKey, boolean>> = {}): void {
    const query = new SearchQuery({
      search: this.field.value,
      caseSensitive: flags.caseSensitive ?? this.query.caseSensitive,
      wholeWord: flags.wholeWord ?? this.query.wholeWord,
      regexp: flags.regexp ?? this.query.regexp,
      replace: this.query.replace,
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    this.draw();
  }

  /** The editor's search state, back into the controls — somebody else changed it. */
  private sync(query: SearchQuery): void {
    this.query = query;
    this.field.value = query.search;
    this.draw();
  }

  /** The query, as the controls show it. */
  private draw(): void {
    for (const toggle of TOGGLES) {
      this.toggles.get(toggle.key)?.setAttribute("aria-pressed", String(this.query[toggle.key]));
    }
    this.count.textContent = this.summary();
  }

  /**
   * What the bar says about the query, as a string.
   *
   * Three states, in words rather than in colour: nothing typed says nothing,
   * a query with no match says so, and a query with matches is a number — the
   * total on its own until a match is current, then `3/17`. Colour would be
   * the fourth thing this bar needs the palette for and would carry the same
   * fact twice; words carry it to a screen reader as well.
   */
  private summary(): string {
    const query = getSearchQuery(this.view.state);
    if (query.search === "" || !query.valid) return query.search === "" ? "" : "no results";

    const main = this.view.state.selection.main;
    const cursor = query.getCursor(this.view.state);
    let total = 0;
    let current = 0;
    let capped = false;
    for (let next = cursor.next(); next.done !== true; next = cursor.next()) {
      total += 1;
      if (next.value.from === main.from && next.value.to === main.to) current = total;
      if (total >= MATCH_CAP) {
        capped = true;
        break;
      }
    }

    const size = `${total}${capped ? "+" : ""}`;
    return total === 0 ? "no results" : current === 0 ? size : `${current}/${size}`;
  }

  /**
   * Keys pressed inside the bar.
   *
   * CodeMirror's keymap is attached to the editor's content, so a chord typed
   * in this field never reaches it — `runScopeHandlers` is how a panel asks for
   * the `search-panel` scope, and it is what makes Escape and ⌘F work from
   * here. `stopPropagation` on a handled chord keeps it from *also* reaching
   * the console's `document` listener, where Escape would go on to close the
   * drawer behind this bar.
   */
  private keydown(event: KeyboardEvent): void {
    if (runScopeHandlers(this.view, event, "search-panel")) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Enter" && event.target === this.field) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
    }
  }
}

/* -------------------------------------------------------------------------- */

function separator(): HTMLSpanElement {
  const line = document.createElement("span");
  line.className = "cm-ctx-find-sep";
  // Decorative: it separates controls that already name themselves.
  line.setAttribute("aria-hidden", "true");
  return line;
}

function button(label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "cm-ctx-find-button";
  element.setAttribute("aria-label", label);
  element.title = label;
  return element;
}

function textButton(text: string, label: string): HTMLButtonElement {
  const element = button(label);
  element.textContent = text;
  return element;
}

function iconButton(path: string, label: string, run: () => void): HTMLButtonElement {
  const element = button(label);
  element.append(icon(path));
  element.addEventListener("click", run);
  return element;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const CHEVRON_UP = "M4 10l4-4 4 4";
const CHEVRON_DOWN = "M4 6l4 4 4-4";
const CROSS = "M4.5 4.5l7 7M11.5 4.5l-7 7";

/** A stroked glyph on a 16-unit square; the stroke is `currentColor` in the theme. */
function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute("d", path);
  svg.append(line);
  return svg;
}

/* -------------------------------------------------------------------------- */

/**
 * The bar's look, in the editor's own custom properties.
 *
 * Every colour is an `--lp-*` the host declares (`LiveEditor.web.tsx`'s
 * `ensureStyles`) rather than a value, which is the rule the completion list
 * and the plugin preview already follow — an unknown custom property makes its
 * whole declaration invalid, so `liveEditorMount.test.ts` asserts that every
 * property any mounted sheet reads is one that host declares, and this theme
 * is mounted inside that test.
 *
 * The first block is the one doing the structural work. CodeMirror's base
 * theme lays a panel container out as a sticky band at the edge of the
 * editor, so opening the bar would push the note's first line down and closing
 * it would pull it back up. Absolute, over the document and out of the way on
 * the right, is where a find bar belongs on a surface this wide — and it is
 * the reason `FindPanel.top` is true rather than a preference about edges.
 */
const findTheme = EditorView.theme({
  ".cm-panels.cm-panels-top": {
    position: "absolute",
    top: "0",
    right: "0",
    left: "auto",
    width: "auto",
    maxWidth: "100%",
    zIndex: "6",
    background: "transparent",
    border: "0",
    color: "var(--lp-heading)",
  },
  ".cm-ctx-find": {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    margin: "8px 10px",
    padding: "4px 4px 4px 8px",
    background: "var(--lp-bg)",
    border: "1px solid var(--lp-line-strong)",
    borderRadius: "13px",
    // A shadow is depth, not a colour: the palette has no token for one, and
    // the plugin preview's tooltip already casts the same.
    boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
    font: "13px/1.2 system-ui, sans-serif",
  },
  ".cm-ctx-find-field": {
    border: "0",
    outline: "none",
    background: "transparent",
    color: "var(--lp-heading)",
    fontFamily: "var(--lp-mono)",
    fontSize: "12px",
    width: "120px",
    minWidth: "0",
    padding: "4px 2px",
  },
  ".cm-ctx-find-field::placeholder": { color: "var(--lp-muted)" },
  ".cm-ctx-find-count": {
    fontFamily: "var(--lp-mono)",
    fontSize: "11px",
    color: "var(--lp-muted)",
    fontVariantNumeric: "tabular-nums",
    padding: "0 6px 0 4px",
    whiteSpace: "nowrap",
  },
  ".cm-ctx-find-sep": {
    width: "1px",
    alignSelf: "stretch",
    background: "var(--lp-line)",
    margin: "3px 4px",
  },
  ".cm-ctx-find-button": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "24px",
    height: "24px",
    padding: "0 4px",
    border: "0",
    borderRadius: "7px",
    background: "transparent",
    color: "var(--lp-muted)",
    cursor: "pointer",
    fontFamily: "var(--lp-mono)",
    fontSize: "11px",
    lineHeight: "1",
  },
  ".cm-ctx-find-button:hover": {
    background: "var(--lp-code-bg)",
    color: "var(--lp-heading)",
  },
  ".cm-ctx-find-button:focus-visible": {
    outline: "2px solid var(--lp-link)",
    outlineOffset: "1px",
  },
  ".cm-ctx-find-button[aria-pressed=true]": {
    background: "var(--lp-focus-ring)",
    color: "var(--lp-link)",
  },
  ".cm-ctx-find-button svg": {
    width: "13px",
    height: "13px",
    display: "block",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.6",
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  /*
    The matches themselves, which the stock theme paints yellow and orange —
    two colours from nobody's palette, and the orange one is what a person is
    meant to read their query inside of.
  */
  ".cm-searchMatch": {
    background: "var(--lp-focus-ring)",
    borderRadius: "2px",
  },
  ".cm-searchMatch-selected": {
    background: "var(--lp-link)",
    color: "var(--lp-bg)",
  },
});
