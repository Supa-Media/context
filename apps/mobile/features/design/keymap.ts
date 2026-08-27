/**
 * The keyboard binding table, and the pure resolver that reads it.
 *
 * ## This is an affordance layer, not a control surface
 *
 * Context ships to a browser and to a phone, and both are the product. This
 * module is the pointer surface's half of that, and it is deliberately only a
 * half: a phone has no keyboard, so nothing here may be the *only* way to run
 * anything. The rule a future addition has to satisfy is blunt:
 *
 *   **Every command named here must also be reachable by touch** — through the
 *   long-press action sheet on a tree row, or the bottom toolbar in the
 *   editor. A command that exists only as a keystroke is a command half this
 *   product's users cannot run at all.
 *
 * The reverse obligation is just as real, which is why this file is as long as
 * it is. A web app whose only affordance is a visible button is a web app that
 * feels slow to anybody who works in one all day: on a pointer, chords are not
 * a power-user garnish, they are the difference between a tool and a form.
 *
 * Structurally that means this file is inert off the web. It imports nothing —
 * not React, not `react-native`, not the DOM — so a native build simply never
 * calls `resolve` and nothing here can misfire on a touch device. The web
 * binder that actually attaches a `keydown` listener is a separate `.web.ts`
 * module (same split as `clipboard.ts` / `clipboard.web.ts`); it does the
 * platform-specific plumbing and calls into here for the decision. Keeping the
 * decision on this side is also what lets the tests run in plain node with no
 * renderer and no native mocks, which is the house style for logic in this app
 * (see `jest.config.js`).
 *
 * ## Why a table instead of a `switch`
 *
 * The obvious implementation is a `switch (event.key)` inside the listener.
 * The reason not to is that a `switch` can only be *executed*, never
 * *interrogated*. The context menu, the action sheet and the command palette
 * all need to answer "what shortcut does Rename have?", and against a `switch`
 * the only way to answer is to hard-code the string "F2" a second time next to
 * the menu item. Then somebody rebinds Rename, the menu keeps printing the old
 * chord, and the UI is lying about itself in a way no test can see. Data plus
 * `describeBinding` gives one source of truth, and the round-trip test below
 * is what holds it there.
 *
 * ## Scopes and the text-field rule
 *
 * `scope` is where the keystroke landed, and `inTextField` is whether it landed
 * in something the person is typing into. Together they are the whole reason
 * this module is more than a lookup:
 *
 *  - Outside an overlay, a **bare** key inside a text field is typing. Pressing
 *    `n` while writing a note must never create a note, and F2, Enter and the
 *    arrows must all reach the textarea untouched. Bindings that carry ⌘ or ⌥
 *    still fire, because nobody types those: ⌘S saves and ⌘K opens the palette
 *    from inside the textarea, which is exactly what makes the layer usable.
 *  - Inside an overlay — the palette, a menu, a dialog — the overlay owns the
 *    keyboard completely. Its own filter input is part of it, so its bare keys
 *    (arrows to move the highlight, Enter to accept, Escape to close) must fire
 *    even though the caret is in a field. Nothing *behind* the overlay may fire
 *    at all: ⌘N while the palette is open is inert, not a new note under a
 *    dialog the person cannot see.
 *
 * A binding declares the scopes it fires in. Declaring `"global"` declares
 * every scope **except** `"overlay"` — a global command is one that works
 * wherever you are, and "wherever you are" never includes "behind a modal".
 * `dismiss` reaches Escape in an overlay because it names `"overlay"`
 * explicitly, not because `"global"` leaked in.
 *
 * ## Modifier matching is exact
 *
 * `mod` is ⌘ on Apple platforms and Ctrl everywhere else, and matching is
 * exact rather than "at least these": Ctrl+S must not save on a Mac, ⌘S must
 * not save on Windows, and ⌘⌫ with Shift held must resolve to `deleteForever`
 * and never to `archive`. "At least these modifiers" is how a destructive
 * command ends up one held key away from a reversible one.
 *
 * Keys compare lowercased, because the browser reports `"N"` when Shift is
 * down; the Shift flag, not the character, is what distinguishes ⌘N from ⌘⇧N.
 * We deliberately avoid ⌥+letter chords: on macOS Option composes characters,
 * so `event.key` for ⌥N is `"Dead"`, not `"n"`. The only ⌥ bindings here are on
 * arrows, which are unaffected.
 */

export type Command =
  | "palette"
  | "quickSwitcher"
  | "findInNote"
  | "searchContext"
  | "newNote"
  | "newFolder"
  | "rename"
  | "duplicate"
  | "moveTo"
  | "copy"
  | "cut"
  | "paste"
  | "archive"
  | "deleteForever"
  | "save"
  | "togglePreview"
  | "closeTab"
  | "reopenTab"
  | "toggleRail"
  | "toggleExplorer"
  | "nextTab"
  | "prevTab"
  | "tab1"
  | "tab2"
  | "tab3"
  | "tab4"
  | "tab5"
  | "tab6"
  | "tab7"
  | "tab8"
  | "tab9"
  | "treeUp"
  | "treeDown"
  | "treeCollapse"
  | "treeExpand"
  | "treeOpen"
  | "dismiss";

/** Where the keystroke landed. A binding only fires in a scope that allows it. */
export type Scope = "global" | "tree" | "editor" | "overlay";

export interface Binding {
  command: Command;
  /** Normalized, lowercase: `"n"`, `"arrowdown"`, `"f2"`, `"backspace"`, `"escape"`. */
  key: string;
  /** ⌘ on Apple platforms, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  scopes: readonly Scope[];
}

const GLOBAL = ["global"] as const;
const TREE = ["tree"] as const;
const EDITOR = ["editor"] as const;
/**
 * The palette's list is navigated with the same three keys the tree is, and it
 * is the same command as far as this table is concerned — the overlay that is
 * open decides what "down" means. Declaring both scopes is what lets the
 * text-field rule stay strict in the tree and relaxed in the palette's filter.
 */
const TREE_AND_OVERLAY = ["tree", "overlay"] as const;

/** ⌘1 … ⌘9 jump to a tab by position; generated so the table cannot drift out of order. */
const TAB_COMMANDS = [
  "tab1",
  "tab2",
  "tab3",
  "tab4",
  "tab5",
  "tab6",
  "tab7",
  "tab8",
  "tab9",
] as const;

export const BINDINGS: readonly Binding[] = [
  /* Finding things. */
  { command: "palette", key: "k", mod: true, scopes: GLOBAL },
  { command: "quickSwitcher", key: "o", mod: true, scopes: GLOBAL },
  { command: "findInNote", key: "f", mod: true, scopes: EDITOR },
  { command: "searchContext", key: "f", mod: true, shift: true, scopes: GLOBAL },

  /* Making things. */
  { command: "newNote", key: "n", mod: true, scopes: GLOBAL },
  { command: "newFolder", key: "n", mod: true, shift: true, scopes: GLOBAL },

  /* Acting on the selected row. All of these are also on the action sheet. */
  { command: "rename", key: "f2", scopes: TREE },
  { command: "duplicate", key: "d", mod: true, scopes: TREE },
  { command: "moveTo", key: "m", mod: true, shift: true, scopes: TREE },
  { command: "copy", key: "c", mod: true, scopes: TREE },
  { command: "cut", key: "x", mod: true, scopes: TREE },
  { command: "paste", key: "v", mod: true, scopes: TREE },
  /**
   * Archive is reversible and permanent delete is not, so they are one Shift
   * apart on purpose — the same finger position, with the irreversible one
   * requiring a deliberate extra key. Exact modifier matching is what keeps
   * that separation real rather than decorative.
   */
  { command: "archive", key: "backspace", mod: true, scopes: TREE },
  { command: "deleteForever", key: "backspace", mod: true, shift: true, scopes: TREE },

  /* The editor. */
  { command: "save", key: "s", mod: true, scopes: EDITOR },
  { command: "togglePreview", key: "e", mod: true, scopes: EDITOR },

  /* Tabs and chrome. */
  { command: "closeTab", key: "w", mod: true, scopes: GLOBAL },
  { command: "reopenTab", key: "t", mod: true, shift: true, scopes: GLOBAL },
  { command: "toggleRail", key: "b", mod: true, scopes: GLOBAL },
  { command: "toggleExplorer", key: "e", mod: true, shift: true, scopes: GLOBAL },
  { command: "nextTab", key: "arrowright", mod: true, alt: true, scopes: GLOBAL },
  { command: "prevTab", key: "arrowleft", mod: true, alt: true, scopes: GLOBAL },
  ...TAB_COMMANDS.map(
    (command, index): Binding => ({
      command,
      key: String(index + 1),
      mod: true,
      scopes: GLOBAL,
    }),
  ),

  /* Moving around the tree — and, in an overlay, its list. */
  { command: "treeUp", key: "arrowup", scopes: TREE_AND_OVERLAY },
  { command: "treeDown", key: "arrowdown", scopes: TREE_AND_OVERLAY },
  { command: "treeCollapse", key: "arrowleft", scopes: TREE },
  { command: "treeExpand", key: "arrowright", scopes: TREE },
  { command: "treeOpen", key: "enter", scopes: TREE_AND_OVERLAY },

  /* Escape closes whatever is open, wherever you are. */
  { command: "dismiss", key: "escape", scopes: ["global", "overlay"] },
];

export interface KeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** True when the keystroke landed in a text field. */
  inTextField: boolean;
}

/** The browser reports `"N"` with Shift down and `"ArrowDown"` unshifted. */
function normalizeKey(key: string): string {
  return key.toLowerCase();
}

/**
 * Declaring `"global"` declares every scope but `"overlay"`. Nothing behind an
 * open overlay may fire, so the escalation stops at the modal boundary.
 */
function firesIn(binding: Binding, scope: Scope): boolean {
  if (binding.scopes.includes(scope)) return true;
  return scope !== "overlay" && binding.scopes.includes("global");
}

/** A binding with no ⌘/Ctrl and no ⌥ is a key somebody could be typing. */
function isBareChord(binding: Binding): boolean {
  return binding.mod !== true && binding.alt !== true;
}

function modifiersMatch(binding: Binding, event: KeyEvent, apple: boolean): boolean {
  // `mod` is ⌘ on Apple and Ctrl elsewhere; the *other* one is never an alias
  // for it, so Ctrl+S on a Mac and ⌘S on Windows both fail here.
  const mod = apple ? event.metaKey : event.ctrlKey;
  const foreign = apple ? event.ctrlKey : event.metaKey;
  if (foreign) return false;
  if (mod !== (binding.mod === true)) return false;
  if (event.shiftKey !== (binding.shift === true)) return false;
  if (event.altKey !== (binding.alt === true)) return false;
  return true;
}

/**
 * The single decision point. Returns the command this keystroke runs in this
 * scope on this platform, or `null` when the keystroke belongs to whatever the
 * person is typing into — or to the browser.
 */
export function resolve(event: KeyEvent, scope: Scope, apple: boolean): Command | null {
  const key = normalizeKey(event.key);
  // Inside an overlay the overlay owns the keyboard, filter input included.
  // Everywhere else, a bare key in a text field is typing and nothing else.
  const suppressBare = event.inTextField && scope !== "overlay";

  for (const binding of BINDINGS) {
    if (binding.key !== key) continue;
    if (!firesIn(binding, scope)) continue;
    if (suppressBare && isBareChord(binding)) continue;
    if (!modifiersMatch(binding, event, apple)) continue;
    return binding.command;
  }
  return null;
}

const APPLE_KEY_LABELS: Readonly<Record<string, string>> = {
  backspace: "⌫",
  enter: "↵",
  escape: "Esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

const KEY_LABELS: Readonly<Record<string, string>> = {
  backspace: "Backspace",
  enter: "Enter",
  escape: "Esc",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
};

function keyLabel(key: string, apple: boolean): string {
  const named = (apple ? APPLE_KEY_LABELS : KEY_LABELS)[key];
  if (named) return named;
  // "f2" prints as "F2"; a letter or digit prints as itself, uppercased.
  return key.toUpperCase();
}

/**
 * For printing on menus and tooltips: `"⌘⇧M"` on Apple, `"Ctrl+Shift+M"`
 * elsewhere. `null` when the command has no keystroke — which is a legitimate
 * state, not an error: a command that is only on the action sheet is exactly
 * the shape this product is supposed to be able to have.
 *
 * The menu prints this rather than its own copy of the chord, so a rebinding
 * moves both at once.
 */
export function describeBinding(command: Command, apple: boolean): string | null {
  const binding = BINDINGS.find((candidate) => candidate.command === command);
  if (!binding) return null;

  const parts: string[] = [];
  if (binding.mod) parts.push(apple ? "⌘" : "Ctrl");
  if (binding.shift) parts.push(apple ? "⇧" : "Shift");
  if (binding.alt) parts.push(apple ? "⌥" : "Alt");
  parts.push(keyLabel(binding.key, apple));

  // Apple chords are glyphs run together; everywhere else they are named and
  // joined, which is the convention each platform's own menus use.
  return apple ? parts.join("") : parts.join("+");
}
