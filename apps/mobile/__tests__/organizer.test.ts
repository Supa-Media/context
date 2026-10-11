/**
 * AUTO-ORGANIZE'S WORDS AND RULES — `features/organizer/{copy,rules}.ts`.
 *
 * Everything auto-organize decides outside a component: what each line says
 * and when each surface is drawn. The rules that carry weight are the ones
 * that would put a count or a card in front of somebody who must never see
 * one — a member, a workspace that switched it off, one that is not paying —
 * so each of those has its own case.
 */

import { describe, expect, test } from "@jest/globals";
import {
  ORGANIZER_ACTOR,
  phoneLine,
  sortCopy,
  sortDone,
  sweepCount,
  sweepReadingTitle,
} from "../features/organizer/copy";
import {
  changesCount,
  existingNoticeVisible,
  isOrganizerEntry,
  organizerState,
  phoneChangesCount,
  settingsCard,
  shouldStartSweep,
  sortLine,
  sweepPhase,
  whatChangedPage,
} from "../features/organizer/rules";
import type { OrganizerStatus } from "../features/organizer/types";
import { rowText, type ActivityEntry } from "../features/console/activity/activity";

const STATUS: OrganizerStatus = {
  available: true,
  isOwner: true,
  on: true,
  noticeNeeded: false,
  startsAt: null,
  sweep: null,
  pending: 11,
  autopilot: { done: false, archive: false, file: false },
};

const with_ = (over: Partial<OrganizerStatus>): OrganizerStatus => ({ ...STATUS, ...over });

describe("copy", () => {
  test("the phone line counts, in the singular too", () => {
    expect(phoneLine(11)).toBe("11 changes to look over");
    expect(phoneLine(1)).toBe("1 change to look over");
  });

  test("a finished sort says when, and nothing about suggestions: there is no list to send anyone to", () => {
    expect(sortDone("3 hours ago")).toBe("Sorted 3 hours ago.");
  });

  test("the sweep names the workspace and how far it has read", () => {
    expect(sweepReadingTitle("seyi")).toBe("Tidying up @seyi");
    expect(sweepReadingTitle("@seyi")).toBe("Tidying up @seyi");
    expect(sweepCount({ read: 212, total: 450 })).toBe("212 of 450 notes");
    // A count that overran its total never reads as more than all of them.
    expect(sweepCount({ read: 460, total: 450 })).toBe("450 of 450 notes");
  });

  test("no copy names the machinery", () => {
    const every = [phoneLine(2), sweepReadingTitle("seyi"), sortDone("just now")].join(" ");
    expect(every).not.toMatch(/\b(model|inference|AI|brain)\b/i);
  });
});

describe("rules", () => {
  test("a status that threw is unavailable, not loading", () => {
    expect(organizerState(undefined)).toEqual({ kind: "loading" });
    expect(organizerState(new Error("Could not find public function"))).toEqual({ kind: "unavailable" });
    expect(organizerState(null)).toEqual({ kind: "unavailable" });
    expect(organizerState(STATUS)).toEqual({ kind: "ready", status: STATUS });
  });

  test("What changed switched off on the server: no page, no count, no way in (Dev2, 2026-10-09)", () => {
    const off = with_({ whatChanged: false, changes: 4 });
    expect(whatChangedPage(off)).toBe(false);
    expect(changesCount(off)).toBeNull();
    expect(phoneChangesCount(off, { compact: true, atRoot: true })).toBeNull();
    // A server older than the switch sends no field: the page stays as it was.
    expect(whatChangedPage(STATUS)).toBe(true);
    expect(changesCount(with_({ whatChanged: true, changes: 4 }))).toBe(4);
  });

  test("the one-time notice is the owner's, and only while it is needed", () => {
    expect(existingNoticeVisible(with_({ noticeNeeded: true }))).toBe(true);
    expect(existingNoticeVisible(with_({ noticeNeeded: true, isOwner: false }))).toBe(false);
    expect(existingNoticeVisible(STATUS)).toBe(false);
    expect(existingNoticeVisible(null)).toBe(false);
  });

  test("the settings card: the owner's switch, a member's read-out, nothing before Premium", () => {
    expect(settingsCard(STATUS)).toBe("owner");
    expect(settingsCard(with_({ isOwner: false }))).toBe("member");
    expect(settingsCard(with_({ available: false }))).toBeNull();
    expect(settingsCard(null)).toBeNull();
  });

  test("the sweep card: only while a sweep is running", () => {
    const running = with_({
      sweep: { state: "running", startedAt: 1, finishedAt: null, read: 212, total: 450, found: { done: 0, archive: 0, file: 0 } },
    });
    expect(sweepPhase(running)).toBe("reading");
    // A finished sweep leaves no card: what it found is What changed's.
    expect(sweepPhase(with_({ sweep: { ...running.sweep!, state: "done", finishedAt: 2 } }))).toBeNull();
    expect(sweepPhase(with_({ ...running, isOwner: false }))).toBeNull();
    expect(sweepPhase(with_({ ...running, on: false }))).toBeNull();
    expect(sweepPhase(STATUS)).toBeNull();
  });

  test("a sweep is asked for once, on the payment return, and never over a running one", () => {
    const now = 1_000;
    expect(shouldStartSweep(STATUS, { returned: "done", asked: false, now })).toBe(true);
    expect(shouldStartSweep(STATUS, { returned: "done", asked: true, now })).toBe(false);
    expect(shouldStartSweep(STATUS, { returned: null, asked: false, now })).toBe(false);
    expect(shouldStartSweep(with_({ on: false }), { returned: "done", asked: false, now })).toBe(false);
    expect(shouldStartSweep(with_({ isOwner: false }), { returned: "done", asked: false, now })).toBe(false);
    expect(shouldStartSweep(with_({ startsAt: now + 1 }), { returned: "done", asked: false, now })).toBe(false);
    expect(
      shouldStartSweep(
        with_({ sweep: { state: "running", startedAt: 1, finishedAt: null, read: 0, total: 1, found: { done: 0, archive: 0, file: 0 } } }),
        { returned: "done", asked: false, now },
      ),
    ).toBe(false);
  });

  test("the organizer's rows are recognised whichever field carries the name", () => {
    expect(isOrganizerEntry({ by: ORGANIZER_ACTOR, via: null })).toBe(true);
    expect(isOrganizerEntry({ by: null, via: ORGANIZER_ACTOR })).toBe(true);
    expect(isOrganizerEntry({ by: "@seyi", via: "Claude" })).toBe(false);
  });

  });

describe("auto-organize's rows in Activity", () => {
  const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({
    at: "2026-09-26T14:50:00.000Z",
    kind: "revised",
    paths: ["1-projects/code-decomposition/overview.md"],
    n: 1,
    vis: "team",
    by: ORGANIZER_ACTOR,
    via: null,
    note: "Every step is ticked off",
    ...over,
  });

  test("marking a project done names the project, with the reason as the note", () => {
    expect(rowText(entry({}))).toEqual({
      title: "Context organizer marked code-decomposition done",
      meta: "Every step is ticked off",
    });
    expect(rowText(entry({ kind: "status" })).title).toBe("Context organizer marked code-decomposition done");
  });

  test("a note that is its own project is named itself", () => {
    expect(rowText(entry({ paths: ["1-projects/website-folder/members-only-pages.md"] })).title).toBe(
      "Context organizer marked members-only-pages done",
    );
  });

  test("anybody else's revision still reads as a revision", () => {
    expect(rowText(entry({ by: "@seyi", via: "Claude" })).title).toBe("@seyi's Claude revised overview");
  });
});

describe("the sort line", () => {
  const NOW = 10 * 60 * 60 * 1000;
  const sweep = (over: Partial<NonNullable<OrganizerStatus["sweep"]>>) => ({
    state: "done" as const,
    startedAt: NOW - 60_000,
    finishedAt: NOW - 30_000,
    read: 40,
    total: 40,
    found: { done: 0, archive: 0, file: 0 },
    ...over,
  });

  test("on with no sweep ever is said, not hidden behind an On switch", () => {
    expect(sortLine(with_({ sweep: null }), NOW)).toEqual({ kind: "never" });
  });

  test("a live sweep is sorting now; one past the stale mark did not finish", () => {
    expect(sortLine(with_({ sweep: sweep({ state: "running", finishedAt: null, read: 3 }) }), NOW)).toEqual({ kind: "running", read: 3, total: 40 });
    const dead = sweep({ state: "running", startedAt: NOW - 31 * 60_000, finishedAt: null });
    expect(sortLine(with_({ sweep: dead }), NOW)).toEqual({ kind: "failed", at: NOW - 31 * 60_000 });
  });

  test("a finished sweep says when", () => {
    expect(sortLine(with_({ sweep: sweep({}), pending: 4 }), NOW)).toEqual({ kind: "done", at: NOW - 30_000 });
    expect(sortLine(with_({ sweep: sweep({ state: "failed" }) }), NOW)).toEqual({ kind: "failed", at: NOW - 30_000 });
  });

  test("a failed sweep says why, when the server knows", () => {
    expect(sortLine(with_({ sweep: sweep({ state: "failed", why: "daily_cap" }) }), NOW)).toEqual({
      kind: "failed",
      at: NOW - 30_000,
      why: "daily_cap",
    });
    expect(sortCopy.failed("just now", "no_answers")).toBe("The last sort didn’t finish (just now). The sorting service didn’t answer.");
    expect(sortCopy.failed("just now")).toBe("The last sort didn’t finish (just now).");
  });

  test("off, not paying, or not the owner: no line", () => {
    expect(sortLine(with_({ on: false }), NOW)).toBeNull();
    expect(sortLine(with_({ available: false }), NOW)).toBeNull();
    expect(sortLine(with_({ isOwner: false }), NOW)).toBeNull();
    expect(sortLine(null, NOW)).toBeNull();
  });
});
