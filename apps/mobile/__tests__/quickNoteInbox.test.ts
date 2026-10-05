import { describe, expect, test } from "@jest/globals";
import { quickNoteFolder } from "../features/console/ConsoleBottomBar";
import type { ConsoleData } from "../features/console/types";

/**
 * Where a quick note from Home goes, for the person pressing.
 *
 * The Inbox for an owner, and for anybody the Inbox is shared with; `null`,
 * so the button asks where, for somebody whose Inbox would be refused. The
 * refusal was "That file does not exist." on a phone in @context-lc, whose
 * top level is private and which has no Inbox (2026-10-02).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. Role ignored (team reader treated as owner). → "an editor with a private top and no Inbox is asked"
 *  2. Inbox row ignored, only the top's default.    → "an Inbox shared with the editor takes the note"
 */

type Visibility = "private" | "team";

function data(role: string, root: Visibility, inbox?: Visibility, selectedPath: string | null = null): ConsoleData {
  return {
    contexts: [{ id: "w", slug: "w", displayName: "W", role, kind: "shared" }],
    selectedContextId: "w",
    files: {
      selectedPath,
      listings: {
        "": {
          path: "",
          folderDefault: root,
          truncated: false,
          entries: [
            { kind: "folder", path: "guides", name: "guides", visibility: "team", inherited: root, exception: root !== "team", readOnly: false },
            ...(inbox === undefined
              ? []
              : [{ kind: "folder", path: "0-inbox", name: "0-inbox", visibility: inbox, inherited: root, exception: inbox !== root, readOnly: false }]),
          ],
        },
      },
    },
  } as unknown as ConsoleData;
}

describe("a quick note from Home", () => {
  test("an owner's goes to the Inbox, private or not", () => {
    expect(quickNoteFolder(data("owner", "private"))).toBe("0-inbox");
  });

  test("an editor with a private top and no Inbox is asked", () => {
    expect(quickNoteFolder(data("editor", "private"))).toBeNull();
    expect(quickNoteFolder(data("member", "private"))).toBeNull();
  });

  test("an Inbox shared with the editor takes the note", () => {
    expect(quickNoteFolder(data("editor", "private", "team"))).toBe("0-inbox");
  });

  test("so does a top shared with them, which an absent Inbox would be", () => {
    expect(quickNoteFolder(data("editor", "team"))).toBe("0-inbox");
  });

  test("inside a folder it is that folder, whoever presses", () => {
    expect(quickNoteFolder(data("editor", "private", undefined, "guides"))).toBe("guides");
  });
});
