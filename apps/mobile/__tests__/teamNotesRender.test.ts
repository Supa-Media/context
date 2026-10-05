/**
 * @jest-environment jsdom
 */

/**
 * "FOR YOUR TEAMS", ON THE GLASS: boards 5–7 on a personal workspace's What
 * changed page.
 *
 * What a person must be able to trust before pressing Add: the card says which
 * team and that the original stays with them; Add opens the note exactly as
 * the team would read it, with what was held back and why; only Add THERE
 * sends it, with their edits; and Keep it here sends nothing.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";
import { WhatChangedPage } from "../features/organizer/WhatChangedPage";
import type { OrganizerStatus, RouteCard, RouteTeam } from "../features/organizer/types";
import type { OrganizerView } from "../features/organizer/useOrganizer";

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 1280, height: 900 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

const STATUS: OrganizerStatus = {
  available: true,
  isOwner: true,
  on: true,
  noticeNeeded: false,
  startsAt: null,
  sweep: null,
  pending: 1,
  changes: 1,
  autopilot: { done: false, archive: false, file: false },
};

const BETA: RouteCard = {
  id: "r1",
  team: "@supa",
  teamTitle: "Supa Media",
  folder: "1-projects/context-private-beta",
  folderTitle: "Context private beta",
  title: "Private beta opens to the waitlist on Oct 20",
  body: "Invites start on October 20, fifty a day.",
  leftOut: [
    { what: "something about a person's role", why: "people" },
    { what: "someone's time off", why: "personal" },
  ],
  source: { path: "0-inbox/meetings/2026-10-02-leadership-sync.md", title: "Leadership sync", kind: "meeting" },
  at: 0,
};

const TEAMS: RouteTeam[] = [
  { name: "@public-worship", title: "Public Worship", on: false },
  { name: "@supa", title: "Supa Media", on: true },
];

interface Calls {
  sent: [string, string, string][];
  kept: string[];
  toggled: [string, boolean][];
  keeps: string[];
  opened: string[];
}

function view(calls: Calls, over: Partial<OrganizerView["suggestions"]> = {}): OrganizerView {
  return {
    status: STATUS,
    suggestions: { list: [], changes: [], routes: [BETA], teams: TEAMS, keep: "", loading: false, failed: false, busy: new Set(), ...over },
    loadSuggestions: () => {},
    sweepNow: () => {},
    closePage: () => {},
    resolveChange: () => {},
    sendRoute: async (card: RouteCard, title: string, body: string) => {
      calls.sent.push([card.id, title, body]);
      return true;
    },
    dismissRoute: (card: RouteCard) => calls.kept.push(card.id),
    setTeamOn: (team: string, on: boolean) => calls.toggled.push([team, on]),
    setKeep: (keep: string) => calls.keeps.push(keep),
  } as unknown as OrganizerView;
}

const fresh = (): Calls => ({ sent: [], kept: [], toggled: [], keeps: [], opened: [] });

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(organizer: OrganizerView, calls: Calls, compact = false): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const page = createElement(WhatChangedPage, { organizer, compact, now: 0, onOpenSource: (path: string) => calls.opened.push(path) });
  act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, page)));
  return container;
}

const byId = (container: HTMLElement, id: string) => container.querySelector(`[data-testid="${id}"]`);
const press = (element: Element | null) => {
  if (element === null) throw new Error("nothing to press");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
function type(element: Element | null, value: string) {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error("not a field");
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the card", () => {
  test("names the team, the note and where it goes, and says the original stays", () => {
    const calls = fresh();
    const page = mount(view(calls), calls);
    expect(byId(page, "what-changed-teams")?.textContent).toBe("For your teams (1)");
    const card = byId(page, "team-note-r1")!;
    expect(card.textContent).toContain("For @supa");
    expect(card.textContent).toContain("Private beta opens to the waitlist on Oct 20");
    expect(card.textContent).toContain("New note · In Context private beta");
    expect(card.textContent).toContain("The original stays with you");
    expect(byId(page, "team-note-left-out-r1")?.textContent).toBe("Left out: 2 things");
    // The meeting opens for its owner, from the card.
    press(byId(page, "team-note-source-r1"));
    expect(calls.opened).toEqual([BETA.source.path]);
    // The card itself never shows the note's body: that is for the preview.
    expect(card.textContent).not.toContain(BETA.body);
  });

  test("Keep it here sends nothing", () => {
    const calls = fresh();
    const page = mount(view(calls), calls);
    press(byId(page, "team-note-keep-r1"));
    expect(calls.kept).toEqual(["r1"]);
    expect(calls.sent).toEqual([]);
  });

  test("with only team notes waiting, the page is not empty", () => {
    const calls = fresh();
    const page = mount(view(calls), calls);
    expect(byId(page, "what-changed-empty")).toBeNull();
    expect(byId(page, "what-changed-waiting")).toBeNull();
  });
});

describe("the preview", () => {
  test("Add opens the note as the team will read it, with what was left out and why", () => {
    const calls = fresh();
    const page = mount(view(calls), calls);
    press(byId(page, "team-note-add-r1"));
    // Opening it sends nothing.
    expect(calls.sent).toEqual([]);
    expect(byId(page, "what-changed-page")).toBeNull();
    const preview = byId(page, "team-note-preview")!;
    expect(preview.textContent).toContain("Before it goes to @supa");
    expect(byId(page, "team-note-goes-in")?.textContent).toBe("Goes in @supa › Context private beta");
    expect((byId(page, "team-note-title") as HTMLInputElement).value).toBe(BETA.title);
    expect((byId(page, "team-note-body") as HTMLTextAreaElement).value).toBe(BETA.body);
    expect(preview.textContent).toContain("From one of your meetings. Only you can open it.");
    const leftOut = byId(page, "team-note-left-out")!.textContent;
    expect(leftOut).toContain("something about a person's role");
    expect(leftOut).toContain("People’s jobs and roles stay private");
    expect(leftOut).toContain("Personal life stays private");
  });

  test("Add there sends the note with the person's edits", async () => {
    const calls = fresh();
    const page = mount(view(calls), calls);
    press(byId(page, "team-note-add-r1"));
    type(byId(page, "team-note-body"), "Invites start on October 20.");
    press(byId(page, "team-note-send"));
    await act(async () => {});
    expect(calls.sent).toEqual([["r1", BETA.title, "Invites start on October 20."]]);
  });

  test("an emptied note can't be sent, and Cancel goes back with nothing sent", () => {
    const calls = fresh();
    const page = mount(view(calls), calls);
    press(byId(page, "team-note-add-r1"));
    type(byId(page, "team-note-body"), "   ");
    expect(byId(page, "team-note-send")?.getAttribute("aria-disabled")).toBe("true");
    press(byId(page, "team-note-cancel"));
    expect(byId(page, "what-changed-page")).not.toBeNull();
    expect(calls.sent).toEqual([]);
  });
});

describe("the settings", () => {
  test("each team has a switch; the rule saves only when it changed", () => {
    const calls = fresh();
    const page = mount(view(calls), calls);
    const settings = byId(page, "team-settings")!;
    expect(settings.textContent).toContain("Sending to your teams");
    expect(byId(page, "team-switch-supa")?.getAttribute("aria-checked")).toBe("true");
    expect(byId(page, "team-switch-public-worship")?.getAttribute("aria-checked")).toBe("false");
    press(byId(page, "team-switch-public-worship"));
    expect(calls.toggled).toEqual([["@public-worship", true]]);
    expect(byId(page, "team-keep-save")?.getAttribute("aria-disabled")).toBe("true");
    type(byId(page, "team-keep"), "Fundraising and investors.");
    press(byId(page, "team-keep-save"));
    expect(calls.keeps).toEqual(["Fundraising and investors."]);
  });

  test("a workspace with no teams shows no team settings", () => {
    const calls = fresh();
    const page = mount(view(calls, { routes: [], teams: [] }), calls);
    expect(byId(page, "team-settings")).toBeNull();
    expect(byId(page, "what-changed-empty")).not.toBeNull();
  });
});
