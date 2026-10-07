/**
 * @jest-environment jsdom
 */

/**
 * AUTO-ORGANIZE, ON THE GLASS.
 *
 * `organizer.test.ts` proves the rules; this proves the surfaces obey them and
 * that each press reaches the view: the explorer's foot line and its popover,
 * ✓ and ✕, the Premium slots, the one-time notice, the toast's offered action
 * and Activity's Undo. And the claim that matters most for everybody who is
 * not the owner of a paying workspace: with no view, or a member's, nothing
 * is added to the screen at all.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";
import { Explorer } from "../features/console/files/Explorer";
import type { FileBrowser } from "../features/console/files/browser";
import { ActivityList } from "../features/console/activity/ActivityList";
import type { ActivityEntry } from "../features/console/activity/activity";
import { PremiumBody } from "../features/console/settings/panels/PremiumPanel";
import { demoPremiumView } from "../features/console/settings/panels/premium";
import { ToastHost } from "../features/design/components/Toast";
import { ORGANIZER_ACTOR } from "../features/organizer/copy";
import { sourceLine } from "../features/organizer/changeCopy";
import { WhatChangedPage } from "../features/organizer/WhatChangedPage";
import { OrganizerNotices } from "../features/organizer/Notices";
import { OrganizerProvider } from "../features/organizer/OrganizerContext";
import { usePremiumSlotsFor } from "../features/organizer/PremiumParts";
import type { ChangeCard, OrganizerStatus, OrganizerSuggestion } from "../features/organizer/types";
import type { OrganizerView } from "../features/organizer/useOrganizer";

const PEOPLE: ChangeCard = {
  id: "c1",
  topic: "people",
  headline: "Dana Reyes has left the team",
  quote: "We parted ways with Dana Reyes on Friday.",
  source: { path: "0-inbox/meetings/2026-10-02-leadership-sync.md", title: "Leadership sync", kind: "meeting" },
  at: 0,
  steps: [
    { id: "s0", do: "archive", path: "2-areas/team/dana-reyes.md", title: "Dana Reyes", about: "person" },
    { id: "s1", do: "set", path: "1-projects/emails/overview.md", title: "Onboarding emails", field: "owner", value: "Sam Patel", was: "Dana Reyes" },
    { id: "s2", do: "set", path: "1-projects/dark-mode/overview.md", title: "Dark mode", field: "priority", value: "p3", was: "p1" },
  ],
};

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 1280, height: 900 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

const STATUS: OrganizerStatus = {
  available: true,
  isOwner: true,
  on: true,
  noticeNeeded: false,
  startsAt: null,
  sweep: null,
  pending: 2,
  autopilot: { done: false, archive: false, file: false },
};

const DONE: OrganizerSuggestion = {
  id: "d1",
  kind: "done",
  path: "1-projects/code-decomposition/overview.md",
  title: "Code decomposition",
  reason: "Every step is ticked off",
};
const FILE: OrganizerSuggestion = {
  id: "f1",
  kind: "file",
  path: "0-inbox/sayo-dns-questions.md",
  title: "sayo-dns-questions",
  reason: "DNS questions",
  target: { path: "1-projects/custom-domains", title: "Custom domains" },
};

interface Calls {
  opened: unknown[];
  resolved: [string, string][];
  changed: [string, string, readonly string[]][];
  autopilot: [string, boolean][];
  enabled: boolean[];
  acknowledged: boolean[];
  undone: number;
  swept: number;
  pages: number;
  tabs: string[];
  many: [string[], string][];
}

function organizer(over: Partial<OrganizerView> & { status?: OrganizerStatus | null } = {}, calls?: Calls): OrganizerView {
  const status = over.status === undefined ? STATUS : over.status;
  return {
    state: status === null ? { kind: "unavailable" } : { kind: "ready", status },
    status,
    slug: "seyi",
    suggestions: { list: [DONE, FILE], changes: [], routes: [], teams: [], keep: "", loading: false, failed: false, busy: new Set() },
    loadSuggestions: () => {},
    tab: "inbox",
    setTab: (tab) => calls?.tabs.push(tab),
    openReview: (options) => calls?.opened.push(options ?? {}),
    resolve: async (s, decision) => {
      calls?.resolved.push([s.id, decision]);
      return { applied: true, offer: null, undo: `undo-${s.id}` };
    },
    resolveMany: async (list, decision) => {
      calls?.many.push([list.map((s) => s.id), decision]);
      return new Map(list.map((s) => [s.id, { applied: true, offer: null, undo: `undo-${s.id}` }]));
    },
    undo: async () => {
      if (calls) calls.undone += 1;
      return true;
    },
    resolveChange: (card, decision, steps) => calls?.changed.push([card.id, decision, steps]),
    sendRoute: async () => false,
    sendRoutes: async () => 0,
    dismissRoutes: () => {},
    dismissRoute: () => {},
    setTeamOn: () => {},
    setKeep: () => {},
    setEnabled: (on) => calls?.enabled.push(on),
    setAutopilot: (kind, on) => calls?.autopilot.push([kind, on]),
    acknowledgeNotice: (turnOff) => calls?.acknowledged.push(turnOff),
    sweepNow: () => {
      if (calls) calls.swept += 1;
    },
    openSettings: () => {},
    pageOpen: false,
    openPage: () => {
      if (calls) calls.pages += 1;
    },
    closePage: () => {},
    toasts: [],
    dismissToast: () => {},
    undoFor: () => undefined,
    ...over,
  };
}

const fresh = (): Calls => ({ opened: [], resolved: [], changed: [], autopilot: [], enabled: [], acknowledged: [], undone: 0, swept: 0, pages: 0, tabs: [], many: [] });

function browser(): FileBrowser {
  return {
    canEdit: true,
    contextId: "w1",
    loading: false,
    busy: false,
    listings: { "": { path: "", entries: [], manifestUsable: true, truncated: false } },
    expanded: new Set<string>(),
    toggleFolder: () => {},
    collapseAll: () => {},
    selectedPath: null,
    opening: null,
    select: () => true,
    deselect: () => true,
    say: () => {},
  } as unknown as FileBrowser;
}

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(element: ReactElement, view?: OrganizerView): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const inner = createElement(SafeAreaProvider, { initialMetrics: METRICS }, element);
  act(() => {
    root.render(view === undefined ? inner : createElement(OrganizerProvider, { value: view }, inner));
  });
  return container;
}

const explorer = () => createElement(Explorer, { files: browser(), contextLabel: "@seyi" });
const byId = (container: HTMLElement, id: string) => container.querySelector(`[data-testid="${id}"]`);
const press = (element: Element | null) => {
  if (element === null) throw new Error("nothing to press");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("the explorer's foot", () => {
  test("no view, a member, or switched off: the column is the one it always was", () => {
    expect(byId(mount(explorer()), "explorer-what-changed")).toBeNull();
    expect(byId(mount(explorer(), organizer({ status: { ...STATUS, isOwner: false } })), "explorer-what-changed")).toBeNull();
    expect(byId(mount(explorer(), organizer({ status: { ...STATUS, on: false } })), "explorer-what-changed")).toBeNull();
  });

  test("one line, not two: What changed counts the tidy-ups too, and opens on them when nothing came in", () => {
    const calls = fresh();
    const container = mount(explorer(), organizer({}, calls));
    // "11 suggestions" was a second line beside What changed, and read as a second helper (Dev2, 2026-10-07).
    expect(byId(container, "explorer-suggestions")).toBeNull();
    const line = byId(container, "explorer-what-changed");
    expect(line?.textContent).toContain("2");
    press(line);
    expect(calls.tabs).toEqual(["tidy"]);
    expect(calls.pages).toBe(1);
  });
});

describe("What changed", () => {
  const WAITING: OrganizerStatus = { ...STATUS, pending: 3, changes: 1 };
  const withCards = (calls: Calls, over: Partial<OrganizerView> = {}) =>
    organizer(
      {
        status: WAITING,
        pageOpen: true,
        suggestions: { list: [DONE, FILE], changes: [PEOPLE], routes: [], teams: [], keep: "", loading: false, failed: false, busy: new Set() },
        ...over,
      },
      calls,
    );
  const page = (view: OrganizerView, opened: string[] = []) =>
    createElement(WhatChangedPage, { organizer: view, compact: false, now: 0, onOpenSource: (path: string) => opened.push(path) });

  test("the tree has its own line, with the cards waiting, and it opens the page", () => {
    const calls = fresh();
    const container = mount(explorer(), withCards(calls, { pageOpen: false }));
    const line = byId(container, "explorer-what-changed");
    expect(line?.textContent).toContain("What changed");
    press(line);
    expect(calls.pages).toBe(1);
    // What came in comes first.
    expect(calls.tabs).toEqual(["inbox"]);
    // One count for both: 1 that came in, 2 to tidy.
    expect(line?.textContent).toContain("3");
  });

  test("the line is there before anything has arrived, and not for a member", () => {
    const none = mount(explorer(), organizer({ status: { ...STATUS, pending: 0, changes: 0 } }));
    expect(byId(none, "explorer-what-changed")?.textContent).toBe("What changed");
    expect(byId(mount(explorer(), organizer({ status: { ...WAITING, isOwner: false } })), "explorer-what-changed")).toBeNull();
  });

  test("the page says what changed, quotes where it read it, and lists its steps ticked", () => {
    const opened: string[] = [];
    const container = mount(page(withCards(fresh()), opened));
    expect(byId(container, "what-changed-page")?.textContent).toContain("What changed");
    expect(byId(container, "what-changed-waiting")?.textContent).toBe("Waiting for you (1)");
    const card = byId(container, "organizer-change-c1");
    expect(card?.textContent).toContain("People");
    expect(card?.textContent).toContain("Dana Reyes has left the team");
    expect(card?.textContent).toContain("“We parted ways with Dana Reyes on Friday.”");
    expect(card?.textContent).toContain("Meeting, Oct 2: Leadership sync");
    expect(card?.textContent).toContain("Archive Dana Reyes’s page");
    expect(card?.textContent).toContain("Give Onboarding emails to Sam Patel");
    expect(card?.textContent).toContain("Was Dana Reyes");
    expect(card?.textContent).toContain("Lower Dark mode");
    expect(card?.textContent).toContain("High → Low");
    expect(byId(container, "organizer-change-step-s1")?.getAttribute("aria-checked")).toBe("true");
    expect(byId(container, "organizer-change-apply-c1")?.textContent).toBe("Apply 3 changes");
    press(byId(container, "organizer-change-source-c1"));
    expect(opened).toEqual([PEOPLE.source.path]);
  });

  test("unticking a step leaves it out of Apply; This is wrong puts the card away", () => {
    const calls = fresh();
    const container = mount(page(withCards(calls)));
    press(byId(container, "organizer-change-step-s2"));
    expect(byId(container, "organizer-change-step-s2")?.getAttribute("aria-checked")).toBe("false");
    expect(byId(container, "organizer-change-apply-c1")?.textContent).toBe("Apply 2 changes");
    press(byId(container, "organizer-change-apply-c1"));
    press(byId(container, "organizer-change-wrong-c1"));
    expect(calls.changed).toEqual([
      ["c1", "accept", ["s0", "s1"]],
      ["c1", "dismiss", []],
    ]);
  });

  test("nothing waiting says so, and Check now asks for a sort", () => {
    const calls = fresh();
    const container = mount(page(withCards(calls, { suggestions: { list: [], changes: [], routes: [], teams: [], keep: "", loading: false, failed: false, busy: new Set() } })));
    expect(byId(container, "what-changed-empty")?.textContent).toContain("Nothing waiting");
    press(byId(container, "what-changed-check"));
    expect(calls.swept).toBe(1);
  });

  test("two tabs, each with what waits behind it; Tidy up holds the suggestions, not the cards", () => {
    const calls = fresh();
    const inbox = mount(page(withCards(calls)));
    expect(byId(inbox, "what-changed-tab-inbox")?.textContent).toBe("From your inbox1");
    expect(byId(inbox, "what-changed-tab-tidy")?.textContent).toBe("Tidy up2");
    expect(byId(inbox, "what-changed-tab-inbox")?.getAttribute("aria-selected")).toBe("true");
    expect(byId(inbox, "tidy-up")).toBeNull();
    press(byId(inbox, "what-changed-tab-tidy"));
    expect(calls.tabs).toEqual(["tidy"]);
    const tidy = mount(page(withCards(fresh(), { tab: "tidy" })));
    expect(byId(tidy, "tidy-up")).not.toBeNull();
    expect(byId(tidy, "organizer-change-c1")).toBeNull();
  });

  test("a source's name comes out of somebody's bucket, so it is contained", () => {
    const flip = "\u202E";
    const dated = sourceLine({ kind: "meeting", path: `meetings/2026-10-02 sync${flip}fdp.md`, title: "x" });
    expect(dated).toBe(`Meeting, Oct 2: \u2068Sync${flip}fdp\u2069`);
    const plain = sourceLine({ kind: "note", path: "0-inbox/idea.md", title: `idea${flip}` });
    expect(plain).toBe(`Note: \u2068idea${flip}\u2069`);
    // The control: an ordinary name is drawn byte for byte.
    expect(sourceLine({ kind: "meeting", path: "meetings/2026-10-02-leadership-sync.md", title: "x" })).toBe(
      "Meeting, Oct 2: Leadership sync",
    );
  });
});

describe("Tidy up", () => {
  const ARCHIVE: OrganizerSuggestion = { id: "a1", kind: "archive", path: "0-inbox/voice-memo.md", title: "Voice memo", reason: "Not opened since September" };
  const D2: OrganizerSuggestion = { ...DONE, id: "d2", title: "Members-only pages" };
  const tidy = (calls: Calls, list: OrganizerSuggestion[] = [DONE, D2, FILE, ARCHIVE], opened: string[] = []) =>
    mount(
      createElement(WhatChangedPage, {
        organizer: organizer({ tab: "tidy", pageOpen: true, suggestions: { list, changes: [], routes: [], teams: [], keep: "", loading: false, failed: false, busy: new Set() } }, calls),
        compact: false,
        now: 0,
        onOpenSource: (path: string) => opened.push(path),
      }),
    );

  test("grouped by what they would do, each row the note, why, and one button that says what it does", () => {
    const opened: string[] = [];
    const container = tidy(fresh(), undefined, opened);
    expect(byId(container, "tidy-group-done")?.textContent).toContain("Looks finished · 2");
    expect(byId(container, "tidy-group-file")?.textContent).toContain("Belongs somewhere else · 1");
    expect(byId(container, "tidy-group-archive")?.textContent).toContain("Nothing is deleted");
    expect(byId(container, "tidy-row-f1")?.textContent).toContain("Move to");
    expect(byId(container, "tidy-row-f1")?.textContent).toContain("Projects › Custom domains");
    expect(byId(container, "tidy-row-d1")?.textContent).toContain("Every step is ticked off");
    expect(byId(container, "tidy-do-d1")?.textContent).toBe("Done");
    expect(byId(container, "tidy-do-f1")?.textContent).toBe("Move");
    expect(byId(container, "tidy-do-a1")?.textContent).toBe("Archive");
    expect(byId(container, "tidy-do-d1")?.getAttribute("aria-label")).toBe("Done: Code decomposition");
    // A group of one has no "all" button; a group of two does.
    expect(byId(container, "tidy-all-file")).toBeNull();
    expect(byId(container, "tidy-all-done")?.textContent).toBe("Mark both done");
    expect(byId(container, "tidy-progress")?.textContent).toContain("0 of 4 done");
    // The note's name opens the note.
    press(byId(container, "tidy-open-d1"));
    expect(opened).toEqual([DONE.path]);
  });

  test("an answered row stays as one line with its Undo, and the bar counts it", async () => {
    const calls = fresh();
    const container = tidy(calls);
    press(byId(container, "tidy-do-d1"));
    await act(async () => {});
    expect(calls.resolved).toEqual([["d1", "accept"]]);
    expect(byId(container, "tidy-row-d1")).toBeNull();
    expect(byId(container, "tidy-answered-d1")?.textContent).toContain("Code decomposition marked done");
    expect(byId(container, "tidy-progress")?.textContent).toContain("1 of 4 done");
    expect(byId(container, "tidy-group-done")?.textContent).toContain("Looks finished · 1");
    press(byId(container, "tidy-undo-d1"));
    await act(async () => {});
    expect(calls.undone).toBe(1);
    // Back as a row to answer again, and the bar gives the step back.
    expect(byId(container, "tidy-row-d1")).not.toBeNull();
    expect(byId(container, "tidy-answered-d1")).toBeNull();
    expect(byId(container, "tidy-progress")?.textContent).toContain("0 of 4 done");
  });

  test("Skip answers one row and offers no Undo; the group button answers the whole group at once", async () => {
    const calls = fresh();
    const container = tidy(calls);
    press(byId(container, "tidy-skip-f1"));
    await act(async () => {});
    expect(calls.resolved).toEqual([["f1", "dismiss"]]);
    expect(byId(container, "tidy-answered-f1")?.textContent).toContain("skipped");
    expect(byId(container, "tidy-undo-f1")).toBeNull();
    press(byId(container, "tidy-all-done"));
    await act(async () => {});
    expect(calls.many).toEqual([[["d1", "d2"], "accept"]]);
    expect(byId(container, "tidy-answered-d2")).not.toBeNull();
    expect(byId(container, "tidy-progress")?.textContent).toContain("3 of 4 done");
  });

  test("a long group shows three and the rest behind a link", () => {
    const many = [1, 2, 3, 4, 5].map((n) => ({ ...FILE, id: `f${n}`, title: `Note ${n}` }));
    const container = tidy(fresh(), many);
    expect(byId(container, "tidy-row-f4")).toBeNull();
    expect(byId(container, "tidy-more-file")?.textContent).toBe("2 more");
    press(byId(container, "tidy-more-file"));
    expect(byId(container, "tidy-row-f5")).not.toBeNull();
  });

  test("when the last one goes, it says All tidy; with nothing ever waiting, the same", async () => {
    const calls = fresh();
    const container = tidy(calls, [DONE]);
    press(byId(container, "tidy-do-d1"));
    await act(async () => {});
    expect(byId(container, "tidy-all-tidy")?.textContent).toContain("All tidy");
    expect(byId(container, "tidy-progress")?.textContent).toContain("1 of 1 done");
    const empty = tidy(fresh(), []);
    expect(byId(empty, "tidy-all-tidy")?.textContent).toContain("Nothing to tidy right now");
  });
});

function Premium({ view, returned }: { view: OrganizerView; returned: "done" | null }) {
  const slots = usePremiumSlotsFor(view, returned);
  return createElement(PremiumBody, { view: demoPremiumView(), section: "premium", returned, autoOrganize: slots });
}

describe("Settings › Premium", () => {
  test("the disclosure sits in what Premium includes, before the upgrade too", () => {
    const container = mount(createElement(Premium, { view: organizer({ status: { ...STATUS, available: false } }), returned: null }));
    expect(byId(container, "organizer-included")?.textContent).toContain("Context reads your notes");
    // No switches before there is anything to switch.
    expect(byId(container, "organizer-settings")).toBeNull();
  });

  test("the owner's switches reach the view", () => {
    const calls = fresh();
    const container = mount(createElement(Premium, { view: organizer({}, calls), returned: null }));
    expect(byId(container, "organizer-settings")?.textContent).toContain("Without asking");
    press(byId(container, "organizer-autopilot-done"));
    press(byId(container, "organizer-switch"));
    expect(calls.autopilot).toEqual([["done", true]]);
    expect(calls.enabled).toEqual([false]);
  });

  test("the owner can tell whether it is sorting: never yet, now, when it last did, and a sort that failed", () => {
    const calls = fresh();
    const never = mount(createElement(Premium, { view: organizer({ status: { ...STATUS, sweep: null } }, calls), returned: null }));
    expect(byId(never, "organizer-sort-never")?.textContent).toContain("Hasn’t sorted yet.");
    press(byId(never, "organizer-sort-now"));
    expect(calls.swept).toBe(1);

    const now = Date.now();
    const running = { state: "running" as const, startedAt: now - 60_000, finishedAt: null, read: 12, total: 40, found: { done: 0, archive: 0, file: 0 } };
    const sorting = mount(createElement(Premium, { view: organizer({ status: { ...STATUS, sweep: running } }), returned: null }));
    expect(byId(sorting, "organizer-sort-running")?.textContent).toContain("Sorting now · 12 of 40 notes");
    // Nothing to press while it runs.
    expect(byId(sorting, "organizer-sort-now")).toBeNull();

    const done = { ...running, state: "done" as const, finishedAt: now - 3 * 3_600_000, read: 40 };
    const sorted = mount(createElement(Premium, { view: organizer({ status: { ...STATUS, sweep: done, pending: 2 } }, calls), returned: null }));
    expect(byId(sorted, "organizer-sort-done")?.textContent).toContain("Sorted 3 hours ago. 2 suggestions waiting.");
    press(byId(sorted, "organizer-sort-review"));
    expect(calls.opened).toEqual([{ closeSettings: true }]);

    const failed = { ...done, state: "failed" as const };
    const broke = mount(createElement(Premium, { view: organizer({ status: { ...STATUS, sweep: failed } }, calls), returned: null }));
    expect(byId(broke, "organizer-sort-failed")?.textContent).toContain("The last sort didn’t finish (3 hours ago).");
    press(byId(broke, "organizer-sort-now"));
    expect(calls.swept).toBe(2);
  });

  test("switched off, there is no sort line to read", () => {
    const container = mount(createElement(Premium, { view: organizer({ status: { ...STATUS, on: false } }), returned: null }));
    expect(byId(container, "organizer-settings")).not.toBeNull();
    expect(container.querySelector('[data-testid^="organizer-sort-"]')).toBeNull();
  });

  test("a member reads it and is offered nothing to press", () => {
    const container = mount(createElement(Premium, { view: organizer({ status: { ...STATUS, isOwner: false } }), returned: null }));
    expect(byId(container, "organizer-settings")?.textContent).toContain("Only the owner can turn auto-organize on or off.");
    expect(byId(container, "organizer-switch")).toBeNull();
    expect(byId(container, "organizer-autopilot-done")).toBeNull();
  });

  test("the sweep reads, then shows what it found; Show me opens the list over closed settings", () => {
    const sweep = { state: "running" as const, startedAt: 1, finishedAt: null, read: 212, total: 450, found: { done: 0, archive: 0, file: 0 } };
    const reading = mount(createElement(Premium, { view: organizer({ status: { ...STATUS, sweep } }), returned: "done" }));
    expect(byId(reading, "organizer-sweep-reading")?.textContent).toContain("Tidying up @seyi");
    expect(byId(reading, "organizer-sweep-reading")?.textContent).toContain("212 of 450 notes");

    const calls = fresh();
    const done = { ...sweep, state: "done" as const, finishedAt: 2, read: 450, found: { done: 1, archive: 0, file: 1 } };
    const found = mount(createElement(Premium, { view: organizer({ status: { ...STATUS, sweep: done } }, calls), returned: "done" }));
    const card = byId(found, "organizer-sweep-found");
    expect(card?.textContent).toContain("Found 1 project that looks done and 1 inbox note to file");
    expect(card?.textContent).toContain("Looks done. Every step is ticked off");
    press(byId(found, "organizer-show-me"));
    expect(calls.opened).toEqual([{ closeSettings: true }]);
    press(byId(found, "organizer-later"));
    expect(byId(found, "organizer-sweep-found")).toBeNull();
  });
});

describe("the notices band", () => {
  test("the one-time notice: Turn off and Got it both answer it", () => {
    const calls = fresh();
    const view = organizer({ status: { ...STATUS, noticeNeeded: true } }, calls);
    const container = mount(createElement(OrganizerNotices, { compact: false, atRoot: false }), view);
    expect(byId(container, "organizer-existing-notice")?.textContent).toContain("Premium now includes auto-organize.");
    press(byId(container, "organizer-notice-off"));
    press(byId(container, "organizer-notice-ok"));
    expect(calls.acknowledged).toEqual([true, false]);
  });

  test("the phone's entry is on the workspace page only", () => {
    const calls = fresh();
    const view = organizer({}, calls);
    const onNote = mount(createElement(OrganizerNotices, { compact: true, atRoot: false }), view);
    expect(byId(onNote, "organizer-phone-entry")).toBeNull();
    const atRoot = mount(createElement(OrganizerNotices, { compact: true, atRoot: true }), view);
    expect(byId(atRoot, "organizer-phone-entry")?.textContent).toContain("2 suggestions to look over");
    press(byId(atRoot, "organizer-look-over"));
    expect(calls.opened).toHaveLength(1);
  });
});

describe("the toast's offered step", () => {
  test("Yes, automatically runs and puts the toast away; Undo is still there", () => {
    const ran: string[] = [];
    const dismissed: string[] = [];
    const container = mount(
      createElement(ToastHost, {
        toasts: [
          {
            id: "organizer-1",
            message: "You’ve marked 3 projects done. Do this automatically from now on?",
            undo: () => ran.push("undo"),
            action: { label: "Yes, automatically", run: () => ran.push("autopilot") },
          },
        ],
        onDismiss: (id: string) => dismissed.push(id),
      }),
    );
    expect(byId(container, "toast-undo-organizer-1")).not.toBeNull();
    press(byId(container, "toast-action-organizer-1"));
    expect(ran).toEqual(["autopilot"]);
    expect(dismissed).toEqual(["organizer-1"]);
  });
});

describe("Activity", () => {
  const row = (over: Partial<ActivityEntry>): ActivityEntry => ({
    at: new Date(Date.now() - 40 * 60_000).toISOString(),
    kind: "revised",
    paths: ["1-projects/code-decomposition/overview.md"],
    n: 1,
    vis: "team",
    by: ORGANIZER_ACTOR,
    via: null,
    note: "Every step is ticked off",
    ...over,
  });

  test("the organizer's rows carry the reason and an Undo; nobody else's do", () => {
    let undone = 0;
    const entries = [row({}), row({ by: "@sayo", via: null, note: null })];
    const container = mount(
      createElement(ActivityList, {
        entries,
        seenAt: null,
        now: Date.now(),
        onOpen: () => {},
        empty: "Nothing yet",
        undoFor: (entry: ActivityEntry) => (entry.by === ORGANIZER_ACTOR ? () => (undone += 1) : undefined),
      }),
    );
    expect(container.textContent).toContain("Context organizer marked code-decomposition done");
    expect(container.textContent).toContain("Every step is ticked off");
    const undos = container.querySelectorAll('[data-testid^="activity-undo-"]');
    expect(undos).toHaveLength(1);
    press(undos[0]);
    expect(undone).toBe(1);
  });
});
