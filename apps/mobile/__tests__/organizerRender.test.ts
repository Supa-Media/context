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
import { OrganizerNotices } from "../features/organizer/Notices";
import { OrganizerProvider } from "../features/organizer/OrganizerContext";
import { usePremiumSlotsFor } from "../features/organizer/PremiumParts";
import type { OrganizerStatus, OrganizerSuggestion } from "../features/organizer/types";
import type { OrganizerView } from "../features/organizer/useOrganizer";

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
  autopilot: [string, boolean][];
  enabled: boolean[];
  acknowledged: boolean[];
  undone: number;
}

function organizer(over: Partial<OrganizerView> & { status?: OrganizerStatus | null } = {}, calls?: Calls): OrganizerView {
  const status = over.status === undefined ? STATUS : over.status;
  return {
    state: status === null ? { kind: "unavailable" } : { kind: "ready", status },
    status,
    slug: "seyi",
    suggestions: { list: [DONE, FILE], loading: false, failed: false, busy: new Set() },
    loadSuggestions: () => {},
    reviewOpen: false,
    openReview: (options) => calls?.opened.push(options ?? {}),
    closeReview: () => {},
    resolve: (s, decision) => calls?.resolved.push([s.id, decision]),
    setEnabled: (on) => calls?.enabled.push(on),
    setAutopilot: (kind, on) => calls?.autopilot.push([kind, on]),
    acknowledgeNotice: (turnOff) => calls?.acknowledged.push(turnOff),
    sweepNow: () => {},
    openSettings: () => {},
    toasts: [],
    dismissToast: () => {},
    undoFor: () => undefined,
    ...over,
  };
}

const fresh = (): Calls => ({ opened: [], resolved: [], autopilot: [], enabled: [], acknowledged: [], undone: 0 });

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
  test("no view, a member, or nothing waiting: the column is the one it always was", () => {
    expect(byId(mount(explorer()), "explorer-suggestions")).toBeNull();
    expect(byId(mount(explorer(), organizer({ status: { ...STATUS, isOwner: false } })), "explorer-suggestions")).toBeNull();
    expect(byId(mount(explorer(), organizer({ status: { ...STATUS, pending: 0 } })), "explorer-suggestions")).toBeNull();
    expect(byId(mount(explorer(), organizer({ status: { ...STATUS, on: false } })), "explorer-suggestions")).toBeNull();
  });

  test("the owner's line counts what is waiting and opens the list", () => {
    const calls = fresh();
    const container = mount(explorer(), organizer({}, calls));
    const line = byId(container, "explorer-suggestions");
    expect(line?.textContent).toContain("2 suggestions");
    press(line);
    expect(calls.opened).toHaveLength(1);
  });

  test("the popover groups the list, and ✓ and ✕ answer one row each", () => {
    const calls = fresh();
    const container = mount(explorer(), organizer({ reviewOpen: true }, calls));
    const list = byId(container, "explorer-suggestions-list");
    expect(list?.textContent).toContain("Projects · 1");
    expect(list?.textContent).toContain("Inbox · 1");
    expect(list?.textContent).toContain("Mark done? Every step is ticked off");
    expect(list?.textContent).toContain("File in Custom domains?");
    press(byId(container, "organizer-accept-d1"));
    press(byId(container, "organizer-dismiss-f1"));
    expect(calls.resolved).toEqual([
      ["d1", "accept"],
      ["f1", "dismiss"],
    ]);
    expect(byId(container, "organizer-accept-d1")?.getAttribute("aria-label")).toBe("Mark done: Code decomposition");
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
