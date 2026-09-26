/**
 * AUTO-ORGANIZE'S WORDS AND RULES — `features/organizer/{copy,rules}.ts`.
 *
 * Everything auto-organize decides outside a component: what each line says,
 * when each surface is drawn, which toast follows a press. The rules that
 * carry weight are the ones that would put a suggestion in front of somebody
 * who must never see one — a member, a workspace that switched it off, one
 * that is not paying — so each of those has its own case.
 */

import { describe, expect, test } from "@jest/globals";
import {
  ORGANIZER_ACTOR,
  acceptLabel,
  acceptedToast,
  offerToast,
  phoneLine,
  previewWhy,
  reviewMeta,
  suggestionsLine,
  sweepCount,
  sweepFoundTitle,
  sweepReadingTitle,
} from "../features/organizer/copy";
import {
  existingNoticeVisible,
  footCount,
  groupSuggestions,
  isOrganizerEntry,
  organizerState,
  phoneEntryCount,
  previewSuggestions,
  resolveToast,
  settingsCard,
  shouldStartSweep,
  sweepPhase,
} from "../features/organizer/rules";
import type { OrganizerStatus, OrganizerSuggestion } from "../features/organizer/types";
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

const DONE: OrganizerSuggestion = {
  id: "d1",
  kind: "done",
  path: "1-projects/code-decomposition/overview.md",
  title: "Code decomposition",
  reason: "Every step is ticked off",
  status: "active",
};
const ARCHIVE: OrganizerSuggestion = {
  id: "a1",
  kind: "archive",
  path: "1-projects/old-site",
  title: "Old site",
  reason: "Quiet for 3 weeks",
};
const FILE: OrganizerSuggestion = {
  id: "f1",
  kind: "file",
  path: "0-inbox/sayo-dns-questions.md",
  title: "sayo-dns-questions",
  reason: "Sayo's DNS questions",
  target: { path: "1-projects/custom-domains", title: "Custom domains" },
};

describe("copy", () => {
  test("the foot line and the phone line count, in the singular too", () => {
    expect(suggestionsLine(11)).toBe("11 suggestions");
    expect(suggestionsLine(1)).toBe("1 suggestion");
    expect(phoneLine(11)).toBe("11 suggestions to look over");
    expect(phoneLine(1)).toBe("1 suggestion to look over");
  });

  test("the sweep names the workspace and how far it has read", () => {
    expect(sweepReadingTitle("seyi")).toBe("Tidying up @seyi");
    expect(sweepReadingTitle("@seyi")).toBe("Tidying up @seyi");
    expect(sweepCount({ read: 212, total: 450 })).toBe("212 of 450 notes");
    // A count that overran its total never reads as more than all of them.
    expect(sweepCount({ read: 460, total: 450 })).toBe("450 of 450 notes");
  });

  test("what the sweep found reads as one sentence, only naming what it found", () => {
    expect(sweepFoundTitle({ done: 4, archive: 0, file: 7 })).toBe(
      "Found 4 projects that look done and 7 inbox notes to file",
    );
    expect(sweepFoundTitle({ done: 1, archive: 0, file: 0 })).toBe("Found 1 project that looks done");
    expect(sweepFoundTitle({ done: 2, archive: 1, file: 1 })).toBe(
      "Found 2 projects that look done, 1 finished project to archive and 1 inbox note to file",
    );
  });

  test("a row's second line asks the question; filing names the folder", () => {
    expect(reviewMeta(DONE)).toBe("Mark done? Every step is ticked off");
    expect(reviewMeta(ARCHIVE)).toBe("Archive? Quiet for 3 weeks");
    expect(reviewMeta(FILE)).toBe("File in Custom domains?");
    expect(reviewMeta({ ...FILE, target: undefined })).toBe("Sayo's DNS questions");
  });

  test("the sweep's preview states the finding rather than asking", () => {
    expect(previewWhy(DONE)).toBe("Looks done. Every step is ticked off");
    expect(previewWhy(FILE)).toBe("File in Custom domains?");
  });

  test("the accept button names what it does to what", () => {
    expect(acceptLabel(DONE)).toBe("Mark done: Code decomposition");
    expect(acceptLabel(ARCHIVE)).toBe("Archive: Old site");
    expect(acceptLabel(FILE)).toBe("File sayo-dns-questions in Custom domains");
  });

  test("the toast after an accept says what happened", () => {
    expect(acceptedToast(DONE)).toBe("Marked Code decomposition done.");
    expect(acceptedToast(ARCHIVE)).toBe("Archived Old site.");
    expect(acceptedToast(FILE)).toBe("Filed sayo-dns-questions in Custom domains.");
  });

  test("the offer gives the reason for asking, per kind", () => {
    expect(offerToast("done")).toBe(
      "You’ve marked 3 projects done. Do this automatically from now on?",
    );
    expect(offerToast("archive")).toContain("archived 3 finished projects");
    expect(offerToast("file")).toContain("filed 3 inbox notes");
  });

  test("no copy names the machinery", () => {
    const every = [
      suggestionsLine(2),
      sweepFoundTitle({ done: 1, archive: 1, file: 1 }),
      offerToast("done"),
      acceptedToast(DONE),
    ].join(" ");
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

  test("the foot line is for a paying owner with it switched on and something waiting", () => {
    expect(footCount(STATUS)).toBe(11);
    expect(footCount(with_({ isOwner: false }))).toBeNull();
    expect(footCount(with_({ on: false }))).toBeNull();
    expect(footCount(with_({ available: false }))).toBeNull();
    expect(footCount(with_({ pending: 0 }))).toBeNull();
    expect(footCount(null)).toBeNull();
  });

  test("the phone's entry is the foot line's twin, on the workspace page only", () => {
    expect(phoneEntryCount(STATUS, { compact: true, atRoot: true })).toBe(11);
    expect(phoneEntryCount(STATUS, { compact: false, atRoot: true })).toBeNull();
    expect(phoneEntryCount(STATUS, { compact: true, atRoot: false })).toBeNull();
    expect(phoneEntryCount(with_({ isOwner: false }), { compact: true, atRoot: true })).toBeNull();
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

  test("the sweep card: running always, found only on the payment return", () => {
    const running = with_({
      sweep: { state: "running", startedAt: 1, finishedAt: null, read: 212, total: 450, found: { done: 0, archive: 0, file: 0 } },
    });
    const found = with_({
      sweep: { state: "done", startedAt: 1, finishedAt: 2, read: 450, total: 450, found: { done: 4, archive: 0, file: 7 } },
    });
    const nothing = with_({
      sweep: { state: "done", startedAt: 1, finishedAt: 2, read: 450, total: 450, found: { done: 0, archive: 0, file: 0 } },
    });
    expect(sweepPhase(running, { returned: null, later: false })).toBe("reading");
    expect(sweepPhase(found, { returned: "done", later: false })).toBe("found");
    expect(sweepPhase(found, { returned: null, later: false })).toBeNull();
    expect(sweepPhase(found, { returned: "done", later: true })).toBeNull();
    expect(sweepPhase(nothing, { returned: "done", later: false })).toBeNull();
    expect(sweepPhase(with_({ ...running, isOwner: false }), { returned: "done", later: false })).toBeNull();
    expect(sweepPhase(with_({ ...running, on: false }), { returned: "done", later: false })).toBeNull();
    expect(sweepPhase(STATUS, { returned: "done", later: false })).toBeNull();
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

  test("projects and inbox are grouped, and an empty group is not drawn", () => {
    expect(groupSuggestions([FILE, DONE, ARCHIVE])).toEqual([
      { key: "projects", label: "Projects · 2", items: [DONE, ARCHIVE] },
      { key: "inbox", label: "Inbox · 1", items: [FILE] },
    ]);
    expect(groupSuggestions([FILE])).toEqual([{ key: "inbox", label: "Inbox · 1", items: [FILE] }]);
    expect(groupSuggestions([])).toEqual([]);
  });

  test("the preview is two projects and an inbox note, then whatever there is", () => {
    const d2 = { ...DONE, id: "d2" };
    const d3 = { ...DONE, id: "d3" };
    const f2 = { ...FILE, id: "f2" };
    expect(previewSuggestions([d2, d3, DONE, FILE, f2]).map((s) => s.id)).toEqual(["d2", "d3", "f1"]);
    expect(previewSuggestions([FILE, f2, { ...FILE, id: "f3" }, DONE]).map((s) => s.id)).toEqual(["d1", "f1", "f2"]);
    expect(previewSuggestions([FILE]).map((s) => s.id)).toEqual(["f1"]);
  });

  test("the organizer's rows are recognised whichever field carries the name", () => {
    expect(isOrganizerEntry({ by: ORGANIZER_ACTOR, via: null })).toBe(true);
    expect(isOrganizerEntry({ by: null, via: ORGANIZER_ACTOR })).toBe(true);
    expect(isOrganizerEntry({ by: "@seyi", via: "Claude" })).toBe(false);
  });

  describe("which toast follows a press", () => {
    const undo = () => {};
    test("an accept says what happened, with Undo when there is a way back", () => {
      expect(resolveToast(DONE, "accept", { applied: true, offer: null, undo: "t" }, { undo })).toEqual({
        message: "Marked Code decomposition done.",
        tone: "neutral",
        undo,
      });
      expect(resolveToast(DONE, "accept", { applied: true, offer: null, undo: null }, { undo })).toEqual({
        message: "Marked Code decomposition done.",
        tone: "neutral",
      });
    });

    test("the third in a row asks instead, and keeps the way back", () => {
      const spec = resolveToast(DONE, "accept", { applied: true, offer: "done", undo: "t" }, { undo });
      expect(spec).toEqual({ message: offerToast("done"), tone: "neutral", offer: "done", undo });
    });

    test("a dismiss is silent", () => {
      expect(resolveToast(DONE, "dismiss", { applied: true, offer: null, undo: null }, { undo })).toBeNull();
    });

    test("a refusal says so in our words, never the server's", () => {
      const spec = resolveToast(
        DONE,
        "accept",
        { applied: false, offer: null, undo: null, error: "ETAG_MISMATCH at functions/organizer:resolve" },
        { undo },
      );
      expect(spec?.tone).toBe("warn");
      expect(spec?.message).not.toContain("functions/");
    });
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
