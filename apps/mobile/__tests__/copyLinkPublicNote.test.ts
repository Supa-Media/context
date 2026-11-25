/**
 * Copy link on a note set to "Anyone with the link" copies the link that opens
 * without signing in (Dev2, 2026-11-25). The ⋯ menu and the phone's quick bar
 * copied the workspace link instead, so a reader of a public note landed on
 * "Someone shared a note with you, sign in".
 *
 * SABOTAGE: make `copyTargetFor` always answer `team`, or pass `{ kind: "team" }`
 * from `runNoteAction` again. "a public note's Copy link copies its public
 * link" fails.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { copyTargetFor } from "../features/console/files/shareDialog/copyTarget";
import { runNoteAction } from "../features/console/layout/NoteActionsSheet";
import type { FileEntry } from "../features/console/files/types";

const PUBLIC = "inbox/meetings/2026-11-25-agents.md";
const MEMBERS_ONLY = "inbox/meetings/2026-11-21-weekly.md";

describe("which link Copy link copies", () => {
  test("the public link for a note with one, the workspace link otherwise", () => {
    const open = new Set([PUBLIC]);
    expect(copyTargetFor(PUBLIC, open)).toEqual({ kind: "link", path: PUBLIC });
    expect(copyTargetFor(MEMBERS_ONLY, open)).toEqual({ kind: "team", path: MEMBERS_ONLY });
    // A folder's public link is not this note's: the note's own path decides.
    expect(copyTargetFor(MEMBERS_ONLY, new Set(["inbox/meetings"]))).toEqual({ kind: "team", path: MEMBERS_ONLY });
  });

  const entry = (path: string): FileEntry => ({
    kind: "file",
    path,
    name: path.split("/").pop()!,
    visibility: "team",
    inherited: "team",
    exception: false,
    readOnly: false,
  });

  const run = (path: string) => {
    const copyShareLink = jest.fn(async (_target: unknown) => ({ ok: true, message: "Link copied." }));
    const data = {
      files: { copyShareLink, openLinkPaths: new Set([PUBLIC]), say: () => undefined, listings: {} },
    } as unknown as Parameters<typeof runNoteAction>[1]["data"];
    runNoteAction("copyLink", { data, entry: entry(path), contextLabel: "@supa", setBarDialog: () => undefined });
    return copyShareLink.mock.calls.map((call) => call[0]);
  };

  test("a public note's Copy link copies its public link", () => {
    expect(run(PUBLIC)).toEqual([{ kind: "link", path: PUBLIC }]);
  });

  test("a members-only note's Copy link copies the workspace link", () => {
    expect(run(MEMBERS_ONLY)).toEqual([{ kind: "team", path: MEMBERS_ONLY }]);
  });
});
