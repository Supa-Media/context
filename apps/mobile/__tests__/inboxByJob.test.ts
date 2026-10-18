/**
 * The app finds the Inbox and the Archive by job, not by name: an Inbox
 * renamed Capture still takes the quick note and is still the page the phone
 * goes back to; an Archive renamed still restores.
 *
 * SABOTAGE: return "0-inbox" from `quickNoteInbox` → "a
 * renamed Inbox takes the quick note" fails; drop the `archive` branch in
 * `restoreTargetFor` → "a renamed Archive still restores" fails.
 */
import { afterEach, describe, expect, test } from "@jest/globals";
import { quickNoteFolder } from "../features/console/ConsoleBottomBar";
import { restoreTargetFor } from "../features/console/files/paths";
import { setJobFoldersNow, inboxFolderNow, archiveFolderNow } from "../features/console/files/jobIcons/jobFoldersNow";
import { phoneBackLevels } from "../features/console/home/phoneBack";
import type { ConsoleData } from "../features/console/types";
import { downloadsPath } from "../features/offline/downloadChoice";

afterEach(() => setJobFoldersNow({ inbox: "0-inbox", archive: "9-archive" }));

function data(role: string, entries: object[]): ConsoleData {
  return {
    contexts: [{ id: "w", slug: "w", displayName: "W", role, kind: "shared" }],
    selectedContextId: "w",
    files: {
      selectedPath: null,
      listings: { "": { path: "", folderDefault: "private", truncated: false, entries } },
    },
  } as unknown as ConsoleData;
}

const folder = (path: string, extra: object = {}) => ({
  kind: "folder",
  path,
  name: path,
  visibility: "private",
  inherited: "private",
  exception: false,
  readOnly: false,
  ...extra,
});

describe("the Inbox by job", () => {
  test("a renamed Inbox takes the quick note", () => {
    expect(quickNoteFolder(data("owner", [folder("Capture", { role: "inbox" }), folder("inbox")]))).toBe("Capture");
  });

  test("for an editor, whether it takes notes is read off the renamed Inbox's own row", () => {
    expect(quickNoteFolder(data("editor", [folder("Capture", { role: "inbox", visibility: "team" })]))).toBe("Capture");
    expect(quickNoteFolder(data("editor", [folder("Capture", { role: "inbox" })]))).toBeNull();
  });

  test("before the root has listed, the old name, which the server reads as the Inbox", () => {
    const empty = { ...data("owner", []), files: { selectedPath: null, listings: {} } } as unknown as ConsoleData;
    expect(quickNoteFolder(empty)).toBe("0-inbox");
    expect(inboxFolderNow()).toBe("0-inbox");
    expect(archiveFolderNow()).toBe("9-archive");
  });

  test("the phone goes back from a note in the renamed Inbox to Inbox itself", () => {
    setJobFoldersNow({ inbox: "Capture", archive: "9-archive" });
    expect(phoneBackLevels("Capture/idea.md").map((level) => level.label)).toHaveLength(1);
    expect(phoneBackLevels("0-inbox/idea.md").length).toBeGreaterThan(1);
  });
});

describe("the Archive by job", () => {
  test("a renamed or moved Archive still restores", () => {
    expect(restoreTargetFor("Old stuff/2026-10-18T09-00-00-000Z/1-projects/a.md", "Old stuff")).toBe("1-projects/a.md");
    expect(restoreTargetFor("2-areas/Archive/2026-10-18T09-00-00-000Z/x/b.md", "2-areas/Archive")).toBe("x/b.md");
    setJobFoldersNow({ inbox: "0-inbox", archive: "Old stuff" });
    expect(restoreTargetFor("Old stuff/2026-10-18T09-00-00-000Z/a.md")).toBe("a.md");
  });

  test("the old names still restore, and nothing else does", () => {
    expect(restoreTargetFor("4-archive/2026-08-26T09-14-02-113Z/1-projects/foo.md", "Old stuff")).toBe("1-projects/foo.md");
    expect(restoreTargetFor("Old stuff/a.md", "Old stuff")).toBeNull();
    expect(restoreTargetFor("Recipes/2026/soup.md", "Old stuff")).toBeNull();
  });

  test("a renamed Archive stays online, like the old one", () => {
    expect(downloadsPath("Old stuff/2026/a.md", "Old stuff")).toBe(false);
    expect(downloadsPath("9-archive/2026/a.md", "Old stuff")).toBe(false);
    expect(downloadsPath("Recipes/soup.md", "Old stuff")).toBe(true);
  });
});
