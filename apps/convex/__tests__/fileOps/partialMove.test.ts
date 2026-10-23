/**
 * A FOLDER MOVE THAT MEETS A NAME ALREADY AT ITS DESTINATION IS REFUSED WHOLE:
 * NOTHING MOVES, NOTHING IS OVERWRITTEN, AND THE PRIVATE NOTES STAY PRIVATE.
 *
 * In a keyed workspace a folder move is one row change (`rowMoveStart.ts`), so
 * the old copy-then-write walk, which could stop halfway and leave some notes
 * moved, no longer exists. What it guarded still does: a destination folder
 * holding a note of somebody's own is never written over, and a note that was
 * private at its old place does not turn team-visible by landing in a shared
 * folder. Both are asserted here.
 *
 * Sabotage (temporary local edits, reverted):
 *  - letting the row move take a destination that already holds a live note:
 *    the stranger's note is overwritten or merged;
 *  - dropping the destination check: the refusal is not the answer.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { movePath } from "../../functions/lib/fileOps";
import { NOW, capture, shareProjects } from "./fixtures.helpers";
import { keyedBucket, liveRowsUnder, PARA_SEEDS, textAt } from "./keyedFixture.fileops1.helpers";

describe("a folder move that meets a name already at its destination", () => {
  test("is refused whole: overwrites nothing, moves nothing, and a private note stays private", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    // Drawings, so the move carries them as it would carry any folder's notes.
    await f.store.put("2-areas/plans/a.excalidraw.md", "# A\n");
    await f.store.put("2-areas/plans/b.excalidraw.md", "# B\n");
    await f.store.put("1-projects/plans/b.excalidraw.md", "# Somebody's, a second old\n");

    const error = await capture(() =>
      movePath(f.store, { from: "2-areas/plans", to: "1-projects/plans", clearance: clearanceOf("private"), now: NOW }),
    );
    expect(error.code).toBe("DESTINATION_EXISTS");

    expect(await textAt(f, "1-projects/plans/b.excalidraw.md")).toBe("# Somebody's, a second old\n");
    expect(await textAt(f, "2-areas/plans/b.excalidraw.md")).toBe("# B\n");
    expect(await textAt(f, "2-areas/plans/a.excalidraw.md")).toBe("# A\n");
    expect(await liveRowsUnder(f, "1-projects/plans")).toEqual(["1-projects/plans", "1-projects/plans/b.excalidraw.md"]);

    // The team folder's exception still holds: a team caller may not read the private note by any name.
    const pay = await capture(() =>
      movePath(f.store, { from: "1-projects/pay.md", to: "2-areas/pay.md", clearance: clearanceOf("team"), now: NOW }),
    );
    expect(pay.code).toBe("FILE_NOT_FOUND");
    expect(await textAt(f, "1-projects/pay.md")).toBe("# Pay\n\nsalaries\n");
  });
});
