/**
 * A new note nobody wrote in is never written (Dev2, 2026-10-18: "new notes
 * created on mobile but nothing written in it doesn't get saved and is
 * discarded"), and that includes one made offline and left in the queue.
 *
 * SABOTAGE: return `false` from `isBlankNewNote` and every "blank" case here
 * fails; drop the check in `drainOutbox` and "is not sent" fails.
 */

import { describe, expect, test } from "@jest/globals";
import { isBlankNewNote } from "../features/offline/blankNewNote";
import { emptyOutbox, enqueue, type PendingWrite } from "../features/offline/outbox";
import { drainOutbox, type WriteOutcome } from "../features/offline/sync";

const NEW = "0-inbox/untitled-2026-10-18.md";

describe("a new note nobody wrote in", () => {
  test("is blank with only the heading it was made with, or nothing", () => {
    expect(isBlankNewNote(NEW, "# untitled-2026-10-18\n\n")).toBe(true);
    expect(isBlankNewNote(NEW, "")).toBe(true);
    expect(isBlankNewNote(NEW, "  \n\n")).toBe(true);
    expect(isBlankNewNote("untitled-2026-10-18-3.md", "# untitled-2026-10-18-3\n")).toBe(true);
  });

  test("is not blank once anything is written in it", () => {
    expect(isBlankNewNote(NEW, "# untitled-2026-10-18\n\nBuy milk\n")).toBe(false);
    expect(isBlankNewNote(NEW, "# Groceries\n")).toBe(false);
    expect(isBlankNewNote(NEW, "Buy milk")).toBe(false);
  });

  test("a note somebody named, or a drawing, is never one", () => {
    expect(isBlankNewNote("0-inbox/plan.md", "# plan\n\n")).toBe(false);
    expect(isBlankNewNote("0-inbox/untitled thoughts.md", "")).toBe(false);
    expect(isBlankNewNote("0-inbox/untitled-2026-10-18.excalidraw.md", "")).toBe(false);
  });

  test("made offline and left in the queue, is not sent; written in, it is", async () => {
    let outbox = enqueue(emptyOutbox("w1"), { path: NEW, text: "# untitled-2026-10-18\n\n", baseEtag: null, now: 1 });
    outbox = enqueue(outbox, { path: "0-inbox/untitled-2026-10-18-2.md", text: "# untitled-2026-10-18-2\n\nHi\n", baseEtag: null, now: 2 });
    const sent: string[] = [];
    const write = async (pending: PendingWrite): Promise<WriteOutcome> => {
      sent.push(pending.path);
      return { kind: "written", etag: "e1", conflictCheck: "conditional" };
    };
    const { outbox: after } = await drainOutbox(outbox, { write, now: () => 3 });
    expect(sent).toEqual(["0-inbox/untitled-2026-10-18-2.md"]);
    // Still on the device, for the person who may yet write in it.
    expect(after.writes.map((one) => one.path)).toEqual([NEW]);
  });
});
