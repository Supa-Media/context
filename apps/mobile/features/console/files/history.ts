import type { AppSectionKey } from "../nav";
import type { SettingsSectionKey } from "../settings/sections";

/**
 * Where you have been in this context, and the way back.
 *
 * Obsidian's mobile toolbar leads with `‹` and `›`, and they are the first two
 * of its six controls — before search, before new, before tabs. That placement
 * is not decoration: a phone shows one note at a time, so "the note I was just
 * looking at" is a destination you reach constantly and cannot see. Our toolbar
 * had no answer to it at all; the only way back to the previous note was to
 * open the drawer and find it in the tree again.
 *
 * ## Why a separate stack from the tab strip
 *
 * Tabs are a *set* of open notes; history is an *order* of visits. Two tabs can
 * be open while you have moved between them six times, and `⌘⇧T` reopening a
 * closed tab is not the same act as stepping back to where you were. Deriving
 * one from the other would make both wrong: back would skip a revisit, and
 * closing a tab would erase somewhere you had been.
 *
 * ## The shape is a browser's, deliberately
 *
 * A cursor into a list, not a stack of two. Stepping back and then visiting
 * somewhere new **truncates the forward tail**, because a forward entry is a
 * prediction about a branch you have just left — every browser does this, and
 * the alternative is a forward button that goes somewhere you never chose.
 *
 * Pure, so the interesting cases — a revisit, a step back followed by a new
 * visit, the ends of the list — are tested without a renderer.
 */

/**
 * A PAGE, NOT A PATH — and this is the correction, not the original design.
 *
 * `entries` held `string[]`, and every string was a file or folder path. So
 * the console's other destinations were not "somewhere you had been" with a
 * poor label; they did not exist. Reported from a phone: open Settings, open a
 * note from it, press `‹`, and you land on the note you were reading *before* —
 * because the only list `‹` could walk was the notes.
 *
 * Every kind here is a place with its own URL (`nav.ts` makes that the rule:
 * "the back button has to mean something"), so this union is the set of URLs
 * one context can be showing, minus the context segment they share:
 *
 *  - **`path`** — a note or a folder, and with it the inbox, a channel and a
 *    contact page. Those are addressed by path too (`classifyCommsPath`), so
 *    they came along the moment the other two kinds did rather than needing a
 *    kind each.
 *  - **`settings`** — the overlay, *per section*. `?settings=storage` and
 *    `?settings=ingestion` are different URLs and a person moving between them
 *    has moved; collapsing them to one "settings" place would make `‹` skip a
 *    page, which is the same defect wearing a different shape.
 *  - **`app`** — Search, Map, Connections. Above a context rather than inside
 *    one, and reachable without changing which context is selected, so they
 *    belong in the same list.
 *
 * What is deliberately **not** a kind is another context. Paths are relative to
 * a bucket — see `clearedHistory`, which is unchanged and still wipes on a
 * context switch, for what carrying one across would offer somebody.
 */
export type Place =
  | { kind: "path"; path: string }
  | { kind: "settings"; section: SettingsSectionKey }
  | { kind: "app"; section: AppSectionKey };

export function notePlace(path: string): Place {
  return { kind: "path", path };
}

export function settingsPlace(section: SettingsSectionKey): Place {
  return { kind: "settings", section };
}

export function appPlace(section: AppSectionKey): Place {
  return { kind: "app", section };
}

/**
 * Whether two places are the same one.
 *
 * `kind` first, and that is the whole reason this is a function rather than a
 * payload comparison: a note called `storage.md` and the storage settings
 * section both carry the string "storage", and a comparison that looked only
 * at the payload would call them one place and swallow the step between them.
 */
export function samePlace(a: Place | null, b: Place | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "path") return a.path === (b as { path: string }).path;
  return a.section === (b as { section: string }).section;
}

/**
 * Which place the console is showing, from the three things that decide it.
 *
 * Here rather than inline in the layout, and that is the lesson of the defect
 * this replaced: the *model* was wide enough to hold a settings section long
 * before anything recorded one, so a suite full of passing history tests said
 * nothing at all about whether `‹` could reach Settings. A derivation that
 * lives in a `useMemo` is a derivation with no test.
 *
 * The order is the order the screen stacks them, and each step is a real
 * precedence rather than a preference:
 *
 *  1. **The settings overlay wins**, because it is drawn over Browse with the
 *     note still mounted behind it. Asking "which path is selected" while it
 *     is open answers about the page underneath.
 *  2. **An app pane next.** Search, Map and Connections are outside a context
 *     but do not clear its selection, so a stale path survives into them.
 *  3. **Otherwise the selection**, which is a note, a folder, the inbox, a
 *     channel or a contact — all addressed by path.
 *
 * `null` means "nowhere yet", which is the frame before the first selection
 * lands, and it records nothing rather than recording a guess.
 */
export function placeOf(where: {
  settingsSection: SettingsSectionKey | null;
  routeKind: "landing" | "app" | "context";
  appSection: AppSectionKey | null;
  selectedPath: string | null;
}): Place | null {
  if (where.settingsSection !== null) return settingsPlace(where.settingsSection);
  if (where.routeKind === "app" && where.appSection !== null) {
    return appPlace(where.appSection);
  }
  return where.selectedPath === null ? null : notePlace(where.selectedPath);
}

export interface HistoryState {
  /** Visited places, oldest first. */
  entries: readonly Place[];
  /** Cursor into `entries`. `-1` only while nothing has been visited. */
  at: number;
}

export const emptyHistory: HistoryState = { entries: [], at: -1 };

/** The place the cursor is on, or `null` before anything has been visited. */
export function currentPlace(state: HistoryState): Place | null {
  return state.at < 0 ? null : (state.entries[state.at] ?? null);
}

/**
 * The path the cursor is on, or `null`.
 *
 * `null` where the current place is a settings section or an app pane, **not**
 * the last path behind it. Callers select a file with this, and answering with
 * a stale path would move the selection out from under somebody who pressed
 * back to reach a setting.
 */
export function currentPath(state: HistoryState): string | null {
  const place = currentPlace(state);
  return place !== null && place.kind === "path" ? place.path : null;
}

/**
 * Record a visit.
 *
 * Re-visiting where you already are is a **no-op**, not an entry. Otherwise
 * every re-render that re-selects the open note would grow the list, and back
 * would need two presses to go anywhere — which is the bug that makes people
 * stop trusting a back button.
 */
export function visited(state: HistoryState, place: Place): HistoryState {
  if (samePlace(currentPlace(state), place)) return state;
  const kept = state.entries.slice(0, state.at + 1);
  return { entries: [...kept, place], at: kept.length };
}

/**
 * Somewhere arrived at, which may be somewhere this list already holds.
 *
 * **The browser's back button is why this is not `visited`.** On the web the
 * address bar is a second history over the same places: a navigation pushes
 * `?note=` (see `useNoteUrl`), so pressing the browser's own back walks it,
 * the URL changes under the console, and `useNoteAddress` opens the note it
 * names. That arrival reaches the same effect a click does — and recorded as a
 * fresh visit it would **truncate the forward tail**, so the browser could go
 * back and this list could never go forward again. The two stacks would drift
 * apart on the first press.
 *
 * So an arrival at the entry immediately behind or ahead of the cursor moves
 * the cursor instead of appending, which is the same answer `stepped` would
 * have given for that place. Anywhere else is a visit.
 *
 * **What this costs, stated rather than discovered:** deliberately navigating
 * to the note you were just on — clicking it in the tree rather than pressing
 * `‹` — now moves the cursor back rather than appending a third entry, so `›`
 * afterwards returns to the note you left. A browser would have appended, and
 * its forward would be dead. This is the better of the two behaviours and it
 * is also the one that keeps `‹ ›` agreeing with what the address bar just
 * did; the alternative is telling those two stacks apart, which nothing on
 * this side of the URL can do.
 */
export function arrived(state: HistoryState, place: Place): HistoryState {
  if (samePlace(currentPlace(state), place)) return state;
  if (samePlace(state.entries[state.at - 1] ?? null, place)) {
    return { entries: state.entries, at: state.at - 1 };
  }
  if (samePlace(state.entries[state.at + 1] ?? null, place)) {
    return { entries: state.entries, at: state.at + 1 };
  }
  return visited(state, place);
}

/**
 * How many rows the Recent sheet offers.
 *
 * A sheet is `maxHeight: 70%` and scrolls, so the cap is not about fitting —
 * it is about what is still recognisable. Past a dozen or so the rows are
 * somewhere you were this morning, which is a search, not a jump.
 */
export const MAX_RECENT = 15;

/**
 * Where you have been, as a list — newest first, each place once.
 *
 * The phone's `‹` reaches the previous note; this reaches the previous fifteen,
 * and it is what the Recent sheet draws. **Derived from `entries` rather than
 * kept beside them**, which is the whole point: the tab switcher this replaced
 * was a second model of "which notes am I working with" living on the same
 * toolbar as this one, and it could not be reconciled with navigation — closing
 * its last row left the note on screen, because a tab set knows nothing about
 * where you are. One array, walked forwards by `‹ ›` and backwards by this, has
 * no second answer to disagree with.
 *
 * It inherits the cost of that, and the cost is real: stepping back and then
 * visiting somewhere new truncates the forward tail, so a note you looked at two
 * minutes ago can leave this list. That is `visited`'s browser rule, argued at
 * the top of this file, and a non-truncating log beside it would buy those rows
 * back at the price of the thing being removed.
 *
 * Duplicates are collapsed even though `entries` keeps them — a repeat visit is
 * a real step for `‹`, and two identical rows in a sheet is a list that reads as
 * broken. Folders are kept: history records the *selection*, and "back to the
 * folder I was in" is a destination a phone reaches constantly.
 */
export function recentPaths(state: HistoryState): string[] {
  const seen = new Set<string>();
  const recent: string[] = [];
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    /*
      Paths only, now that history is wider than this sheet.

      The sheet draws file names and sends `select(path)`, so a settings
      section listed here would be a row that either reads as a note or
      navigates nowhere. `‹` owes every page; Recent is a list of notes and
      folders and says so.
    */
    const place = state.entries[index];
    if (place === undefined || place.kind !== "path") continue;
    if (seen.has(place.path)) continue;
    seen.add(place.path);
    recent.push(place.path);
    if (recent.length === MAX_RECENT) break;
  }
  return recent;
}

/**
 * Whether the Recent sheet has anywhere to send you.
 *
 * Not `recentPaths(state).length > 0`. The list always contains the note on
 * screen — the sheet marks that row rather than hiding it, so a person opening
 * it can see where they stand — which makes "one entry, and it is the one I am
 * looking at" the real empty case. It is also the *ordinary* case on the first
 * note of a session, and a control that offers to take somebody where they
 * already are is one they learn to stop pressing.
 *
 * `selected` is the selection rather than the editor's path, because a folder is
 * a place this list holds too: standing in `1-projects` with `1-projects` as the
 * only entry is the same dead end.
 */
export function hasSomewhereToGo(state: HistoryState, selected: string | null): boolean {
  // Against the sheet's own rows rather than every entry: a settings section
  // in the list is not somewhere this sheet can send anybody.
  return recentPaths(state).some((path) => path !== selected);
}

export function canGoBack(state: HistoryState): boolean {
  return state.at > 0;
}

export function canGoForward(state: HistoryState): boolean {
  return state.at >= 0 && state.at < state.entries.length - 1;
}

/**
 * Move the cursor. Refuses to run off either end rather than clamping silently,
 * so a caller can tell "nothing happened" from "moved to the same place".
 */
export function stepped(state: HistoryState, delta: -1 | 1): HistoryState {
  const next = state.at + delta;
  if (next < 0 || next >= state.entries.length) return state;
  return { ...state, at: next };
}

/**
 * Forget everything.
 *
 * Switching context is the case. Paths are relative to a bucket, so a history
 * carried across would offer to take somebody "back" to a note that does not
 * exist where they now are — and the refusal would arrive as a read failure
 * against somebody else's context.
 */
export function clearedHistory(): HistoryState {
  return emptyHistory;
}
