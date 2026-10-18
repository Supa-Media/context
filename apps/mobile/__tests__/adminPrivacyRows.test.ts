import { describe, expect, test } from "@jest/globals";
import {
  checkedLine,
  checkedAtLabel,
  orphanNote,
  settingLabel,
  settingNote,
  slugLabel,
  statusLabel,
  summaryLine,
  switchButtons,
  switchedWords,
  type PrivacyRowsReport,
  type PrivacyRowsRow,
} from "../features/admin/privacyRows";

/**
 * The "Privacy on rows" card's pure helpers (`features/admin/privacyRows.ts`):
 * the three settings and their words, the check's words per workspace, and
 * which switch buttons the card offers. The rules worth a red test: Use rows
 * is offered only while the readers are not on rows, and carries the server's
 * reason when it is refused; Back to Off is offered whenever the setting is
 * not Off; an orphan is shown without blocking.
 */

const row = (fields: Partial<PrivacyRowsRow> & { workspaceId: string }): PrivacyRowsRow => ({
  slug: null,
  archived: false,
  status: "unchecked",
  checked: 0,
  differences: 0,
  orphans: 0,
  checkedAt: null,
  ...fields,
});

const report = (fields: Partial<PrivacyRowsReport>): PrivacyRowsReport => ({
  source: "file",
  truncated: false,
  ready: { ok: false, reason: "Start keeping rows first." },
  rows: [],
  ...fields,
});

describe("the setting", () => {
  test("reads Off, Shadow or On, each with its plain meaning", () => {
    expect(settingLabel("file")).toBe("Off");
    expect(settingLabel("shadow")).toBe("Shadow");
    expect(settingLabel("rows")).toBe("On");
    expect(settingNote("shadow")).toBe("Rows are kept up to date with the rules, but nothing reads them yet.");
    expect(settingNote("rows")).toBe("Rows decide who sees what.");
    expect(settingNote("file")).toBe("The rules decide who sees what. Rows are not kept.");
  });
});

describe("each workspace's check", () => {
  test("says what its check found, in words", () => {
    expect(statusLabel("unchecked")).toBe("Not checked yet");
    expect(statusLabel("stale")).toBe("Changed since the check. Check again");
    expect(statusLabel("differs")).toBe("Differs from the rules");
    expect(statusLabel("clean")).toBe("Matches the rules");
  });

  test("a workspace with no count and no check reads as not checked, and one that was counted reads its rows", () => {
    expect(checkedLine(row({ workspaceId: "a" }))).toBe("Not checked yet");
    expect(checkedLine(row({ workspaceId: "a", checked: 1204, checkedAt: 1 }))).toBe("Checked 1,204 rows");
  });

  test("a handle is shown with one @, or as no handle", () => {
    expect(slugLabel("maya")).toBe("@maya");
    expect(slugLabel("@maya")).toBe("@maya");
    expect(slugLabel(null)).toBe("(no handle)");
  });

  test("the last check reads Never until one has finished", () => {
    expect(checkedAtLabel(null)).toBe("Never");
  });

  test("orphans are a note only when there are some, and never block", () => {
    expect(orphanNote(0)).toBeNull();
    expect(orphanNote(1)).toBe("1 rule names nothing in the tree");
    expect(orphanNote(3)).toBe("3 rules name nothing in the tree");
  });

  test("the summary counts matching, differing and waiting workspaces", () => {
    expect(summaryLine([])).toBe("No workspaces yet");
    expect(
      summaryLine([
        row({ workspaceId: "a", status: "clean" }),
        row({ workspaceId: "b", status: "differs" }),
        row({ workspaceId: "c", status: "stale" }),
      ]),
    ).toBe("3 workspaces · 1 match · 1 differ · 1 need a check");
  });
});

describe("the switch's buttons", () => {
  test("Start and Check are always offered", () => {
    const buttons = switchButtons(report({ source: "file" }));
    expect(buttons.start.label).toBe("Start keeping rows");
    expect(buttons.check.label).toBe("Check every workspace");
  });

  test("Use rows is offered while the readers are not on rows, and carries the reason when refused", () => {
    const refused = switchButtons(report({ source: "shadow", ready: { ok: false, reason: "2 workspaces differ from the rules." } }));
    expect(refused.useRows).toEqual({ shown: true, enabled: false, reason: "2 workspaces differ from the rules." });
    const allowed = switchButtons(report({ source: "shadow", ready: { ok: true, reason: null } }));
    expect(allowed.useRows).toEqual({ shown: true, enabled: true, reason: null });
    expect(switchButtons(report({ source: "rows", ready: { ok: true, reason: null } })).useRows.shown).toBe(false);
  });

  test("Back to Off is offered whenever the setting is not Off", () => {
    expect(switchButtons(report({ source: "file" })).off.shown).toBe(false);
    expect(switchButtons(report({ source: "shadow" })).off).toEqual({ shown: true, label: "Back to Off" });
    expect(switchButtons(report({ source: "rows" })).off.shown).toBe(true);
  });

  test("after a switch, the card says where things stand", () => {
    expect(switchedWords("rows")).toBe("Rows decide who sees what now.");
    expect(switchedWords("shadow")).toBe("Keeping rows. Nothing reads them yet.");
    expect(switchedWords("file")).toBe("Off. The rules decide who sees what.");
  });
});
