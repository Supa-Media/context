/**
 * @jest-environment jsdom
 */

/**
 * "FOR YOUR TEAMS", ON THE GLASS: boards 5–7 on a personal workspace's What
 * changed page.
 *
 * What a person must be able to trust before pressing Add (board 9, after
 * Dev2's "I can't see what notes or the gist ... I can't even see the original
 * source material ... there's not an accept all button", 2026-10-06): each row
 * says which team, the gist and what was kept back; Show original puts the
 * arrival's own lines beside it, the used ones marked and the held-back ones
 * struck with why; one button adds every ticked note and only those; Edit the
 * note opens it exactly as the team would read it; and Don't add sends nothing.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";
import { WhatChangedPage } from "../features/organizer/WhatChangedPage";
import { gist, teamsCopy } from "../features/organizer/teamCopy";
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
  body: "## Dates\n- Invites start on **October 20**, fifty a day",
  uses: ["We open the beta to the waitlist on October 20.", "Fifty invites a day."],
  leftOut: [
    { what: "something about a person's role", why: "people", quote: "Sam moves to part-time next month." },
    { what: "someone's time off", why: "personal" },
  ],
  source: { path: "0-inbox/meetings/2026-10-02-leadership-sync.md", title: "Leadership sync", kind: "meeting" },
  at: 0,
};

const EASTER: RouteCard = {
  id: "r2",
  team: "@public-worship",
  teamTitle: "Public Worship",
  folder: "",
  folderTitle: "",
  title: "The Easter set list is final",
  body: "Six songs are locked for Easter.",
  uses: [],
  leftOut: [],
  source: { path: "0-inbox/email/2026-10-04.md", title: "2026 10 04", kind: "messages", subject: "Easter set" },
  at: 0,
};

const TEAMS: RouteTeam[] = [
  { name: "@public-worship", title: "Public Worship", on: false },
  { name: "@supa", title: "Supa Media", on: true },
];

interface Calls {
  sent: [string, string, string][];
  batches: string[][];
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
    sendRoutes: async (cards: readonly RouteCard[]) => {
      calls.batches.push(cards.map((card) => card.id));
      return cards.length;
    },
    dismissRoute: (card: RouteCard) => calls.kept.push(card.id),
    dismissRoutes: (cards: readonly RouteCard[]) => calls.kept.push(...cards.map((card) => card.id)),
    setTeamOn: (team: string, on: boolean) => calls.toggled.push([team, on]),
    setKeep: (keep: string) => calls.keeps.push(keep),
  } as unknown as OrganizerView;
}

const fresh = (): Calls => ({ sent: [], batches: [], kept: [], toggled: [], keeps: [], opened: [] });

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

describe("a row", () => {
  test("names the team and folder, gives the gist, the source and what was kept back", () => {
    const calls = fresh();
    const page = mount(view(calls), calls);
    expect(byId(page, "what-changed-teams")?.textContent).toBe("For your teams (1)");
    const row = byId(page, "team-note-r1")!;
    expect(row.textContent).toContain("Private beta opens to the waitlist on Oct 20");
    expect(row.textContent).toContain("@supa › Context private beta");
    // The gist is the note in plain words, not its Markdown.
    expect(byId(page, "team-note-gist-r1")?.textContent).toContain("Dates. Invites start on October 20, fifty a day.");
    expect(row.textContent).not.toContain("**");
    expect(row.textContent).toContain("Meeting, Oct 2: Leadership sync");
    expect(byId(page, "team-note-left-out-r1")?.textContent).toContain("Kept back: ");
    expect(byId(page, "team-note-left-out-r1")?.textContent).toContain("someone's time off");
    // The original is closed until asked for.
    expect(byId(page, "team-note-original-r1")).toBeNull();
  });

  test("an email says which thread, and a note with nothing held back says so", () => {
    const calls = fresh();
    const page = mount(view(calls, { routes: [EASTER] }), calls);
    const row = byId(page, "team-note-r2")!;
    expect(row.textContent).toContain("“Easter set”");
    expect(row.textContent).toContain("@public-worship");
    expect(byId(page, "team-note-left-out-r2")?.textContent).toBe("Nothing kept back");
  });

  test("Show original marks the lines used and strikes the lines kept back, with why", () => {
    const calls = fresh();
    const page = mount(view(calls), calls);
    press(byId(page, "team-note-show-r1"));
    const original = byId(page, "team-note-original-r1")!;
    expect(original.textContent).toContain("The original · only you can see it");
    expect(byId(page, "team-note-use-r1-0")?.textContent).toContain(BETA.uses[0]);
    expect(byId(page, "team-note-use-r1-1")?.textContent).toContain(BETA.uses[1]);
    const struck = byId(page, "team-note-held-r1-0")!;
    expect(struck.textContent).toContain("Sam moves to part-time next month.");
    expect(struck.textContent).toContain("something about a person's role");
    // Held back with no line to show: named, with why, and nothing struck.
    expect(byId(page, "team-note-held-r1-1")?.textContent).toContain("someone's time off");
    expect(byId(page, "team-note-held-r1-1")?.textContent).toContain("Personal life stays private");
    expect(byId(page, "team-note-r1")?.textContent).toContain("What @supa gets");
    // The whole original is one press away, for its owner.
    expect(byId(page, "team-note-source-r1")?.textContent).toBe("Open meeting ↗");
    press(byId(page, "team-note-source-r1"));
    expect(calls.opened).toEqual([BETA.source.path]);
    press(byId(page, "team-note-hide-r1"));
    expect(byId(page, "team-note-original-r1")).toBeNull();
  });

  test("a note written before lines were kept says to open the original", () => {
    const calls = fresh();
    const page = mount(view(calls, { routes: [EASTER] }), calls);
    press(byId(page, "team-note-show-r2"));
    expect(byId(page, "team-note-original-r2")?.textContent).toContain("Open the original to read it.");
    expect(byId(page, "team-note-source-r2")?.textContent).toBe("Open email ↗");
  });

  test("Don't add sends nothing", () => {
    const calls = fresh();
    const page = mount(view(calls), calls);
    press(byId(page, "team-note-show-r1"));
    press(byId(page, "team-note-keep-r1"));
    expect(calls.kept).toEqual(["r1"]);
    expect(calls.sent).toEqual([]);
    expect(calls.batches).toEqual([]);
  });

  test("with only team notes waiting, the page is not empty", () => {
    const calls = fresh();
    const page = mount(view(calls), calls);
    expect(byId(page, "what-changed-empty")).toBeNull();
    expect(byId(page, "what-changed-waiting")).toBeNull();
  });
});

describe("adding them all", () => {
  const both = { routes: [BETA, EASTER] };

  test("everything starts ticked, and the button says where each note goes", async () => {
    const calls = fresh();
    const page = mount(view(calls, both), calls);
    expect(byId(page, "team-tick-all")?.textContent).toContain("2 of 2 ticked");
    expect(byId(page, "team-tick-r1")?.getAttribute("aria-checked")).toBe("true");
    expect(byId(page, "team-add-ticked")?.textContent).toBe("Add 2 ticked: 1 to @supa, 1 to @public-worship");
    expect(byId(page, "team-skip-rest")).toBeNull();
    press(byId(page, "team-add-ticked"));
    await act(async () => {});
    expect(calls.batches).toEqual([["r1", "r2"]]);
  });

  test("an unticked note is neither added nor skipped until Skip the rest", async () => {
    const calls = fresh();
    const page = mount(view(calls, both), calls);
    press(byId(page, "team-tick-r2"));
    expect(byId(page, "team-tick-r2")?.getAttribute("aria-checked")).toBe("false");
    expect(byId(page, "team-tick-all")?.textContent).toContain("1 of 2 ticked");
    expect(byId(page, "team-add-ticked")?.textContent).toBe("Add 1 to @supa");
    press(byId(page, "team-add-ticked"));
    await act(async () => {});
    expect(calls.batches).toEqual([["r1"]]);
    expect(calls.kept).toEqual([]);
    press(byId(page, "team-skip-rest"));
    expect(calls.kept).toEqual(["r2"]);
  });

  test("the box in the bar unticks and reticks everything; with none ticked nothing can be added", () => {
    const calls = fresh();
    const page = mount(view(calls, both), calls);
    press(byId(page, "team-tick-all"));
    expect(byId(page, "team-tick-all")?.textContent).toContain("0 of 2 ticked");
    expect(byId(page, "team-add-ticked")?.getAttribute("aria-disabled")).toBe("true");
    press(byId(page, "team-tick-all"));
    expect(byId(page, "team-tick-all")?.textContent).toContain("2 of 2 ticked");
  });

  test("a team filter shows that team's notes, and Add adds only those", async () => {
    const calls = fresh();
    const page = mount(view(calls, both), calls);
    expect(byId(page, "team-filter-all")?.textContent).toBe("All 2");
    press(byId(page, "team-filter-supa"));
    expect(byId(page, "team-note-r2")).toBeNull();
    expect(byId(page, "team-add-ticked")?.textContent).toBe("Add 1 to @supa");
    press(byId(page, "team-add-ticked"));
    await act(async () => {});
    expect(calls.batches).toEqual([["r1"]]);
  });

  test("on a phone the button is short, and still says where they go to a screen reader", () => {
    const calls = fresh();
    const page = mount(view(calls, both), calls, true);
    const add = byId(page, "team-add-ticked")!;
    expect(add.textContent).toBe("Add 2 ticked");
    expect(add.getAttribute("aria-label")).toBe("Add 2 ticked: 1 to @supa, 1 to @public-worship");
  });

  test("one team gets no filter", () => {
    const calls = fresh();
    const page = mount(view(calls), calls);
    expect(byId(page, "team-filter-all")).toBeNull();
  });
});

describe("the preview", () => {
  test("Edit the note opens it as the team will read it, with what was left out and why", () => {
    const calls = fresh();
    const page = mount(view(calls), calls);
    press(byId(page, "team-note-show-r1"));
    press(byId(page, "team-note-edit-r1"));
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
    press(byId(page, "team-note-show-r1"));
    press(byId(page, "team-note-edit-r1"));
    type(byId(page, "team-note-body"), "Invites start on October 20.");
    press(byId(page, "team-note-send"));
    await act(async () => {});
    expect(calls.sent).toEqual([["r1", BETA.title, "Invites start on October 20."]]);
  });

  test("an emptied note can't be sent, and Cancel goes back with nothing sent", () => {
    const calls = fresh();
    const page = mount(view(calls), calls);
    press(byId(page, "team-note-show-r1"));
    press(byId(page, "team-note-edit-r1"));
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

describe("the words", () => {
  const plain = (text: string) => text.replace(/[⁦-⁩]/g, "");

  test("a gist is the note's Markdown read as plain words, cut at a word", () => {
    expect(plain(gist("## Dates\n- Invites start **Oct 20**\n- See [the plan](https://x.test/p)"))).toBe(
      "Dates. Invites start Oct 20. See the plan.",
    );
    const long = plain(gist("word ".repeat(80), 40));
    expect(long.length).toBeLessThanOrEqual(41);
    expect(long.endsWith("word…")).toBe(true);
  });

  test("adding several says how many went where, and what is still here", () => {
    expect(teamsCopy.sentMany([BETA], 0)).toBe("Added 1 note to @supa.");
    expect(teamsCopy.sentMany([BETA, EASTER, { ...EASTER, id: "r3" }], 2)).toBe(
      "Added 3 notes: 2 to @public-worship, 1 to @supa. 2 couldn’t be added and are still here.",
    );
    expect(teamsCopy.failedMany(3)).toBe("None of the 3 notes could be added. They’re still here.");
  });

  test("kept back names two things and counts the rest", () => {
    const three = [...BETA.leftOut, { what: "a pay figure", why: "people" as const }];
    expect(plain(teamsCopy.keptBack(three))).toBe("Kept back: something about a person's role, someone's time off, 1 more");
  });
});
