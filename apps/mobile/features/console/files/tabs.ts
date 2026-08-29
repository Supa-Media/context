/**
 * Open tabs, as data.
 *
 * The console keeps several notes open at once, and the same model drives both
 * shapes of the UI: a tab strip on desktop, and on mobile the Obsidian
 * arrangement — a count button in the bottom toolbar that opens a switcher
 * sheet. Neither shape is in here. There is no React, no React Native and no
 * DOM in this file, because the transitions worth being sure about are not
 * visual ones:
 *
 *  - **Closing the active tab.** Which tab you land on afterwards is the
 *    difference between "that was fine" and "where did my place go" — the
 *    neighbour to the right, or the left if there was nothing to the right.
 *  - **A rename landing while a draft is open.** The note the person is typing
 *    into changes path underneath them. Losing the tab, or the draft, at that
 *    moment is the single worst thing this module could do.
 *  - **Reopen ordering.** ⌘⇧T is only useful if what comes back is what you
 *    just lost, in the order you lost it.
 *
 * Every one of those is a sequence of events, not a screenshot, and all three
 * are effectively untestable inside a component. The console's Jest suite runs
 * in plain node with no renderer (see `jest.config.js`), so the rules live out
 * here where a test can drive them one action at a time.
 *
 * **Tabs retire `guardLeaving` in `editor.ts`.** That refusal exists because
 * today the pane holds exactly one note: clicking another one with an unsaved
 * draft would throw the draft away, so it is blocked with a prompt instead.
 * Once a second note opens in a second tab, nothing is thrown away by clicking
 * — the draft stays put in the tab it belongs to — and there is nothing left to
 * guard. That removal belongs to the integration step; `editor.ts` is
 * deliberately untouched here.
 */

import { baseName, parentPath } from "./paths";
import type { FolderListing } from "./types";

export interface Tab {
  path: string;
  /**
   * A single click opens a *preview* tab, shown in italics, which the next
   * single click REPLACES. Editing it, or double-clicking, pins it.
   */
  preview: boolean;
  dirty: boolean;
}

export interface TabsState {
  tabs: readonly Tab[];
  activePath: string | null;
  /** Most-recently-closed first, capped. Powers ⌘⇧T. */
  closed: readonly string[];
}

export const emptyTabs: TabsState = { tabs: [], activePath: null, closed: [] };

/**
 * How far back ⌘⇧T reaches.
 *
 * A bounded list rather than a full history: this is "undo the close I just
 * did", not a session log, and an unbounded array of paths in state that never
 * shrinks is a leak nobody would ever notice.
 */
export const MAX_REOPENABLE = 10;

export type TabsAction =
  | { type: "opened"; path: string; mode: "preview" | "pinned" }
  | { type: "pinned"; path: string }
  /** Marks the tab dirty and pins it. */
  | { type: "edited"; path: string }
  | { type: "saved"; path: string }
  | { type: "closed"; path: string }
  | { type: "closedOthers"; path: string }
  | { type: "reopened" }
  | { type: "activated"; path: string }
  /** A rename must follow the tab, draft and all. */
  | { type: "renamed"; from: string; to: string }
  /** Deleted, archived, or moved away — the path no longer resolves. */
  | { type: "removed"; path: string }
  /**
   * A different context is open. Every tab goes, and so does the reopen stack.
   *
   * The stack is the point, and neither of the two obvious loops gets there.
   * `closed` **adds** each path to it. `removed` **scrubs** the one path it is
   * given — see its case below, and the test that pins it — but leaves
   * everything the person had already closed with ⌘W *before* the switch, so
   * ⌘⇧T afterwards puts a note name from the previous context back on screen.
   * Only clearing the whole thing works, which is what this action is for: the
   * strip is about *this* context or it is about nothing.
   *
   * Not drafts — a `Tab` is `{ path, preview, dirty }` and holds no text.
   * `TabsState` never sees a draft; that lives in `useFileBrowser`'s editor,
   * which its own reset effect clears on the same key. Worth saying because
   * this file's header promises per-tab drafts eventually, and on the day they
   * arrive this action silently becomes an unsaved-work discard on every
   * context switch.
   */
  | { type: "reset" };

/** Newest first, deduplicated, capped. */
function remember(closed: readonly string[], paths: readonly string[]): string[] {
  const merged = [...paths, ...closed.filter((path) => !paths.includes(path))];
  return merged.slice(0, MAX_REOPENABLE);
}

/**
 * Drop a tab and decide what is active afterwards.
 *
 * The neighbour to the right — which is whatever slid into the closed tab's
 * index — or the last tab if it was the rightmost. Anything else (jumping to
 * the first tab, or to the most recently used) moves the person somewhere they
 * were not looking.
 */
function without(state: TabsState, path: string): { tabs: Tab[]; activePath: string | null } {
  const index = state.tabs.findIndex((tab) => tab.path === path);
  if (index < 0) return { tabs: [...state.tabs], activePath: state.activePath };
  const tabs = state.tabs.filter((tab) => tab.path !== path);
  if (state.activePath !== path) return { tabs, activePath: state.activePath };
  const neighbour = tabs[index] ?? tabs[tabs.length - 1];
  return { tabs, activePath: neighbour?.path ?? null };
}

/** Open a path, or activate it if it is already open. */
function open(state: TabsState, path: string, mode: "preview" | "pinned"): TabsState {
  const existing = state.tabs.find((tab) => tab.path === path);
  if (existing) {
    // Never a duplicate, and never a demotion: a tab you pinned stays pinned
    // however you arrive at it next.
    const tabs = existing.preview && mode === "pinned"
      ? state.tabs.map((tab) => (tab.path === path ? { ...tab, preview: false } : tab))
      : state.tabs;
    return { ...state, tabs, activePath: path };
  }

  const tab: Tab = { path, preview: mode === "preview", dirty: false };
  if (mode === "pinned") {
    return { ...state, tabs: [...state.tabs, tab], activePath: path };
  }

  // There is only ever one preview tab, and a new preview takes its slot rather
  // than its own — that is the whole point of arrow-keying down a folder
  // without ending up with forty tabs. The replaced tab is *not* remembered as
  // closed: nobody chose to close it, and it cannot have held anything, because
  // typing into a preview tab pins it (see `edited`).
  const slot = state.tabs.findIndex((existingTab) => existingTab.preview);
  const tabs = slot < 0
    ? [...state.tabs, tab]
    : state.tabs.map((existingTab, index) => (index === slot ? tab : existingTab));
  return { ...state, tabs, activePath: path };
}

/** A change to one open tab. Unknown paths are a no-op, not a crash. */
function amend(state: TabsState, path: string, change: Partial<Tab>): TabsState {
  if (!state.tabs.some((tab) => tab.path === path)) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.path === path ? { ...tab, ...change } : tab)),
  };
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "reset":
      return emptyTabs;
    case "opened":
      return open(state, action.path, action.mode);

    case "pinned":
      return amend(state, action.path, { preview: false });

    case "edited":
      // Pinning here is not a convenience. Typing into a preview tab is the
      // clearest statement available that you meant to keep it, and a tab the
      // next single click would replace is no place for an unsaved draft.
      return amend(state, action.path, { dirty: true, preview: false });

    case "saved":
      return amend(state, action.path, { dirty: false });

    case "closed": {
      if (!state.tabs.some((tab) => tab.path === action.path)) return state;
      // A dirty tab closes. Whether to ask first is a question about a modal,
      // and a modal decision has no business living inside a data structure —
      // the reducer publishes `dirty` and `dirtyCount`, and the UI confirms
      // before dispatching. A reducer that refused would also be undoable only
      // by a second, differently-named action, which is how "close anyway"
      // buttons end up bypassing the check entirely.
      const { tabs, activePath } = without(state, action.path);
      return { tabs, activePath, closed: remember(state.closed, [action.path]) };
    }

    case "closedOthers": {
      const kept = state.tabs.find((tab) => tab.path === action.path);
      if (!kept) return state;
      const others = state.tabs.filter((tab) => tab.path !== action.path);
      // In strip order, so the newest tab — tabs are appended, so the rightmost
      // — ends up last in `closed`. ⌘⇧T then walks left to right and rebuilds
      // the strip in the order it had.
      return {
        tabs: [{ ...kept, preview: false }],
        activePath: kept.path,
        closed: remember(state.closed, others.map((tab) => tab.path)),
      };
    }

    case "reopened": {
      const [path, ...rest] = state.closed;
      if (path === undefined) return state;
      // Pinned, not preview. You did not go to the trouble of reopening it to
      // have the next single click replace it.
      return open({ ...state, closed: rest }, path, "pinned");
    }

    case "activated":
      if (!state.tabs.some((tab) => tab.path === action.path)) return state;
      return { ...state, activePath: action.path };

    case "renamed": {
      if (!state.tabs.some((tab) => tab.path === action.from)) {
        // Not open, but it may be sitting in the reopen list, where a stale
        // path would come back as a 404.
        if (!state.closed.includes(action.from)) return state;
        return {
          ...state,
          closed: state.closed.map((path) => (path === action.from ? action.to : path)),
        };
      }
      // Everything except the path survives: `preview`, `dirty`, the tab's
      // position, and whether it is the active one. This is the case people
      // forget, and forgetting it means renaming the note you are typing into
      // closes it and takes the draft with it.
      return {
        tabs: state.tabs.map((tab) => (tab.path === action.from ? { ...tab, path: action.to } : tab)),
        activePath: state.activePath === action.from ? action.to : state.activePath,
        closed: state.closed.map((path) => (path === action.from ? action.to : path)),
      };
    }

    case "removed": {
      const { tabs, activePath } = without(state, action.path);
      // Deliberately not remembered as closed, and scrubbed from the list if it
      // was already there: a deleted, archived or moved-away note has no path
      // left to reopen, and ⌘⇧T handing somebody a 404 is worse than ⌘⇧T doing
      // nothing.
      return { tabs, activePath, closed: state.closed.filter((path) => path !== action.path) };
    }
  }
}

/**
 * ⌘1–⌘9. Index 8 means "the ninth tab"; out of range is a no-op.
 *
 * Zero-based on purpose, so the caller does the "⌘1 is the first" arithmetic
 * once, at the keyboard layer where the digit actually is.
 */
export function tabAt(state: TabsState, index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= state.tabs.length) return null;
  return state.tabs[index].path;
}

/** What the tab strip and the mobile count button show. */
export function dirtyCount(state: TabsState): number {
  return state.tabs.reduce((count, tab) => count + (tab.dirty ? 1 : 0), 0);
}

/**
 * What a tab is labelled.
 *
 * The base name without its extension, because a strip of `.md`s reads as
 * noise — except when two open tabs share one, which in a PARA context is
 * routine (`1-projects/notes.md` and `2-areas/notes.md`). Then both get their
 * folder, and neither is a coin toss.
 */
export function tabLabel(state: TabsState, path: string): string {
  const name = baseName(path).replace(/\.md$/i, "");
  const ambiguous = state.tabs.some(
    (tab) => tab.path !== path && baseName(tab.path).replace(/\.md$/i, "") === name,
  );
  if (!ambiguous) return name;
  const folder = parentPath(path);
  return folder === "" ? name : `${baseName(folder)}/${name}`;
}

/**
 * Which open tabs a changed set of listings says are gone.
 *
 * Pure, and here rather than inside `useTabs`' effect, because `#102`
 * established that in this console every guard expressed as a pure module is
 * held by a test and every guard inside a hook is not — 13-for-13 against
 * 0-for-14. Both rules below were in the second group.
 *
 * **Two different things mean "we have not looked".** A folder with no listing
 * at all is the obvious one: closing on it would shut every tab whenever a
 * folder collapsed. A folder whose listing is `truncated` is the one that was
 * missed — `fileOps.ts` sets that flag whenever the walk stopped short, which
 * includes a store reporting another page and offering no cursor, a
 * *first-page* condition on B2, Wasabi, MinIO or any proxy. Such a listing is
 * loaded and incomplete, so the old rule read "absent from the page" as
 * "deleted" and closed the tab of a note that still exists — after which the
 * tree, drawing the same short listing, could not reach it either.
 *
 * The flag has been measured by the server and carried to the client all along
 * with no consumer anywhere in `apps/mobile`. **This is now its only one**, and
 * that is a statement about this function rather than about the flag: several
 * readers of the same short listing are still blind to it, including
 * `buildTreeRows` (draws a truncated folder as complete, and can draw "Empty"
 * for one whose whole first page was filtered by `canSee`), `namesIn` (tells
 * `describeNameProblem` a taken name is free), `findEntry`, `countLoaded`,
 * `itemsFromListings`, and `loadedFolders` (the move dialog's destination list,
 * and `IngestionCard`'s one-tap capture targets — the latter already
 * deliberately partial, `.slice(0, 6)` beside a free-text field).
 *
 * An earlier version of this sentence called `loadedFolders` "the one worth
 * naming individually" because it "feeds `SettingsPane`'s folder visibility
 * list". There is no such list: folder visibility is set from the tree, through
 * `cycleVisibility` behind `canSetVisibility`, and `SettingsPane` has no
 * visibility control at all. That claim came from a review note and was written
 * in as fact without being checked — **a fabricated access-control consequence,
 * in a public repository, inside a commit about comments the code contradicts.**
 * None of these is a regression and none is disclosure;
 * every one of them is "a short list printed as a complete one", the rule
 * CLAUDE.md states for `noteCountTruncated` and `resetPrivacyManifest.partial`.
 */
export function tabsToClose(
  tabs: readonly Tab[],
  listings: Readonly<Record<string, FolderListing | undefined>>,
): string[] {
  const gone: string[] = [];
  for (const tab of tabs) {
    const folder = parentPath(tab.path);
    const listing = listings[folder];
    if (listing === undefined || listing.truncated) continue;
    if (!listing.entries.some((entry) => entry.path === tab.path)) gone.push(tab.path);
  }
  return gone;
}
