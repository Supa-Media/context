/**
 * @jest-environment jsdom
 */
/**
 * The Meetings panel's Today and Past lists (owner, 2026-11-19: "meetings side
 * panel looks ugly ... less text, also it should show past meetings with a
 * button to open up where the note lives").
 *
 *  - Past lists meeting notes from the server, wherever they were filed, not
 *    only this device's recordings, and each opens its own note.
 *  - A recording whose note the server lists is one row, not two.
 *  - Today's rows say Join, not a sentence, and the panel has no paragraph
 *    over its lists.
 */
import { afterEach, describe, expect, jest, test } from "@jest/globals";

let mockRecords: unknown[] = [];
let mockPast: unknown[] | null = null;

jest.mock("../features/meetings/useMeetings", () => ({
  useMeetingsSnapshot: () => ({
    live: null,
    records: mockRecords,
    canContinue: false,
    ending: null,
    audio: {},
    offline: false,
  }),
  useTick: () => 0,
}));

jest.mock("../features/meetings/usePastMeetings", () => ({
  usePastMeetings: () => mockPast,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AsidePanel } from "../features/console/aside/AsidePanel";
import { forgetAsideChoice } from "../features/console/aside/asideChoice";
import { NO_MEETING } from "../features/console/aside/tabs";
import { clearScheduledMeetings, setScheduledMeetings } from "../features/meetings/scheduled";
import { meetingsFromNotes, newestMeetings, pastWhenLabel } from "../features/meetings/pastMeetings";

const SEYI = { id: "ws_seyi", slug: "seyi" };

const roots: (() => void)[] = [];
afterEach(() => {
  forgetAsideChoice();
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockRecords = [];
  mockPast = null;
  clearScheduledMeetings();
});

function mount(onOpenNote: (href: string, path: string) => void, onJoin: ((m: unknown) => void) | null = null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() =>
    root.render(
      createElement(AsidePanel, {
        started: null,
        onOpenNote,
        onJoin: onJoin as never,
        pastFrom: [SEYI],
      }),
    ),
  );
  const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return {
    find,
    text: () => container.textContent ?? "",
    press(id: string) {
      const node = find(id);
      if (node === null) throw new Error(`no ${id}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
  };
}

const NOTE_PATH = "areas/ministry/public-worship/2026-10-12-charisma-seyi-380xy9bq.md";

function pastNote() {
  return meetingsFromNotes(
    [
      {
        path: NOTE_PATH,
        properties: { type: "meeting", started: "2026-10-12T19:59:55.927Z", duration: "59m" },
        heading: "Charisma / Seyi",
        lede: null,
      },
    ],
    SEYI,
  );
}

describe("recognising a meeting note", () => {
  test("by its front matter, in any folder, with its title, length and folder", () => {
    const [meeting] = pastNote();
    expect(meeting).toMatchObject({
      path: NOTE_PATH,
      title: "Charisma / Seyi",
      duration: "59m",
      folder: "public-worship",
      slug: "seyi",
    });
  });

  test("by a dated name in a meetings folder, and never by a date alone", () => {
    const found = meetingsFromNotes(
      [
        { path: "areas/life/meetings/2026-09-25-lk-seyi.md", properties: {}, heading: "LK / Seyi", lede: null },
        { path: "projects/plan/2026-09-25-roadmap.md", properties: {}, heading: "Roadmap", lede: null },
        { path: "projects/plan/notes.md", properties: { type: "project" }, heading: "Notes", lede: null },
      ],
      SEYI,
    );
    expect(found.map((m) => m.title)).toEqual(["LK / Seyi"]);
  });

  test("newest first, and never one that has not started", () => {
    const at = (when: string, path: string) => ({ ...pastNote()[0], when, path });
    const now = Date.parse("2026-11-19T12:00:00Z");
    const list = newestMeetings(
      [at("2026-10-01T10:00:00Z", "a.md"), at("2026-11-30T10:00:00Z", "future.md"), at("2026-11-18", "b.md")],
      now,
      10,
    );
    expect(list.map((m) => m.path)).toEqual(["b.md", "a.md"]);
  });

  test("the when-column says Yesterday, a weekday, then a date", () => {
    const now = new Date(2026, 10, 19, 9, 0).getTime();
    expect(pastWhenLabel("2026-11-18", now)).toBe("Yesterday");
    expect(pastWhenLabel(new Date(2026, 10, 16, 15, 0).toISOString(), now)).toBe("Mon");
    expect(pastWhenLabel("2026-10-12", now)).toBe("12 Oct");
  });
});

describe("the panel", () => {
  test("lists past meeting notes from the server, and each opens its note", () => {
    mockPast = pastNote();
    const opened: [string, string][] = [];
    const panel = mount((href, path) => opened.push([href, path]));
    expect(panel.find("aside-past")).not.toBeNull();
    expect(panel.text()).toContain("Charisma / Seyi");
    // One line: what the second line used to say is in the row's name.
    expect(panel.text()).not.toContain("public-worship");
    expect(panel.find(`aside-past-note-${NOTE_PATH}`)?.getAttribute("aria-label")).toContain("59m · public-worship");
    // The open-note mark waits for hover; the row itself opens the note.
    expect(panel.find(`aside-past-open-${NOTE_PATH}`)).toBeNull();
    panel.press(`aside-past-note-${NOTE_PATH}`);
    expect(opened).toEqual([[`/console/@seyi?note=${encodeURIComponent(NOTE_PATH)}`, NOTE_PATH]]);
    // No paragraph over the lists.
    expect(panel.find("aside-no-meeting")).toBeNull();
  });

  test("a recording whose note the server lists is one row, not two", () => {
    mockPast = pastNote();
    mockRecords = [
      {
        session: {
          id: "m0",
          title: "Charisma / Seyi",
          state: "complete",
          startedAt: "2026-10-12T19:59:55.927Z",
          recordedMs: 3_540_000,
          attendees: [],
          source: { kind: "in-person" },
          notes: "",
          transcript: [],
          notePath: NOTE_PATH,
          enhanced: null,
          log: [],
        },
        runningSince: null,
        destination: { kind: "personalInbox", contextSlug: "seyi", folder: "0-inbox/meetings" },
      },
    ];
    const panel = mount(() => {});
    expect(panel.text().split("Charisma / Seyi").length - 1).toBe(1);
    expect(panel.find("aside-meeting-row-m0")).not.toBeNull();
  });

  test("only the meeting next up shows Join, and it joins", () => {
    const start = Date.now() + 30 * 60_000;
    setScheduledMeetings({
      status: "ready",
      reconnect: [],
      meetings: [
        {
          id: "e1",
          title: "1:1 with Michael",
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(start + 30 * 60_000).toISOString(),
          attendees: [{ name: "a" }, { name: "b" }],
          conferenceUrl: "https://meet.google.com/abc-defg-hij",
        } as never,
      ],
    });
    mockPast = [];
    const joined: unknown[] = [];
    const panel = mount(() => {}, (m) => joined.push(m));
    expect(panel.find("scheduled-join-e1")?.textContent).toBe("Join");
    expect(panel.text()).not.toContain("Join and take notes");
    panel.press("scheduled-join-e1");
    expect(joined).toHaveLength(1);
  });

  test("with nothing at all it says so in one short line", () => {
    mockPast = [];
    const panel = mount(() => {});
    expect(panel.find("aside-no-meeting")?.textContent).toBe(NO_MEETING);
  });
});
