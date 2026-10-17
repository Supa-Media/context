/**
 * WHAT A MOVE INTO ANOTHER CONTEXT TELLS THE PERSON WHO STARTED IT.
 *
 * The only file operation whose outcome arrives as a *sentence*. Everything
 * else in the console finishes inside the press and reports itself by the tree
 * changing; this one is still running after the toast is gone, and can finish
 * while nobody is looking at the screen at all.
 *
 * So the wording is load-bearing, and these are the readings that would send
 * somebody to the wrong place:
 *
 *  - **"Moved" over a move that left things behind.** They go to the other
 *    context, the encrypted notes are not there, and the only honest place to
 *    learn that was a line that did not mention it.
 *  - **A failure that reads as "nothing happened".** A move that stopped at
 *    batch forty really did carry thirty-nine batches, and somebody who
 *    concludes otherwise looks for their notes in the context they left.
 *  - **A running move that reads as a finished one.** Or the reverse.
 *
 * And every line is short: it shares one row with its controls.
 */

import { describe, expect, test } from "@jest/globals";
import {
  contextMoveNotices,
  describeContextMove,
} from "../features/console/files/contextMoveNotice";
import type { ContextMoveProgress } from "../features/console/files/browser";

function move(over: Partial<ContextMoveProgress> = {}): ContextMoveProgress {
  return {
    id: "m1",
    from: "1-projects/acme",
    to: "work/acme",
    destination: "@work",
    status: "moving",
    objects: 0,
    skipped: [],
    ...over,
  };
}

describe("while it is running", () => {
  test("it says so, by the item's own name rather than its path", () => {
    const notice = describeContextMove(move());
    expect(notice.tone).toBe("hint");
    expect(notice.text).toBe("Moving acme to @work…");
    expect(notice.text).not.toContain("1-projects");
    // Nothing to act on and nothing to acknowledge.
    expect(notice.resumable).toBe(false);
    expect(notice.dismissible).toBe(false);
  });

  test("the count appears once there is one", () => {
    expect(describeContextMove(move({ objects: 240 })).text).toBe("Moving acme to @work, 240 notes so far…");
    expect(describeContextMove(move({ objects: 1 })).text).toContain("1 note so far");
    // Zero is left out rather than printed: "0 notes so far" reads as a move
    // that is stuck, and the first batch has simply not landed yet.
    expect(describeContextMove(move()).text).not.toContain("0 notes");
  });

  test("a note is named the way the tree names it, without .md", () => {
    expect(describeContextMove(move({ from: "1-projects/plan.md" })).text).toBe(
      "Moving plan to @work…",
    );
  });

  test("it cannot be dismissed, because dismissing it would hide live work", () => {
    const running = move({ id: "m9" });
    expect(contextMoveNotices([running], new Set(["m9"]))).toHaveLength(1);
  });
});

describe("when it finishes", () => {
  test("a clean move is a plain report", () => {
    const notice = describeContextMove(move({ status: "complete", objects: 312 }));
    expect(notice.tone).toBe("hint");
    expect(notice.text).toBe("Moved acme to @work.");
    expect(notice.dismissible).toBe(true);
  });

  test("something left behind is not reported as a clean move", () => {
    const notice = describeContextMove(
      move({
        status: "complete",
        objects: 9,
        skipped: [
          { path: "1-projects/acme/secret.md", reason: "encrypted" },
          { path: "1-projects/acme/pay.md", reason: "encrypted" },
        ],
      }),
    );

    // A warning rather than a report: there is something in the other context
    // that is not there, and only this line says which.
    expect(notice.tone).toBe("warn");
    expect(notice.text).toContain("Moved acme to @work.");
    expect(notice.text).toContain("2 encrypted notes stayed here");
    expect(notice.text).toContain("1-projects/acme/secret.md");
    expect(notice.text).toContain("1-projects/acme/pay.md");
  });

  test("a file too large to cross is named apart from the encrypted notes", () => {
    const notice = describeContextMove(
      move({
        status: "complete",
        objects: 4,
        skipped: [
          { path: "1-projects/acme/secret.md", reason: "encrypted" },
          { path: "1-projects/acme/talk.mp4", reason: "too_large" },
        ],
      }),
    );
    expect(notice.tone).toBe("warn");
    expect(notice.text).toContain("1 encrypted note stayed here: 1-projects/acme/secret.md.");
    expect(notice.text).toContain("1 file too large to move stayed here; upload it there");
    expect(notice.text).toContain("1-projects/acme/talk.mp4");
    expect(notice.text).not.toMatch(/encrypted[^.]*talk\.mp4/);
  });

  test("one of them is named in the singular", () => {
    const notice = describeContextMove(
      move({
        status: "complete",
        objects: 1,
        skipped: [{ path: "a.md", reason: "encrypted" }],
      }),
    );
    expect(notice.text).toBe("Moved acme to @work. 1 encrypted note stayed here: a.md.");
  });

  test("a dismissed one stops being drawn", () => {
    const done = move({ id: "m2", status: "complete", objects: 3 });
    expect(contextMoveNotices([done], new Set())).toHaveLength(1);
    expect(contextMoveNotices([done], new Set(["m2"]))).toHaveLength(0);
  });
});

describe("when it stops", () => {
  test("it leads with what did move, then the reason, and offers to try again", () => {
    const notice = describeContextMove(
      move({
        status: "failed",
        objects: 120,
        error: "A note changed while it was being moved, so the move stopped.",
      }),
    );

    expect(notice.tone).toBe("warn");
    expect(notice.text).toBe(
      "acme stopped partway: 120 notes are in @work. A note changed while it was being moved, so the move stopped.",
    );
    // Everything carried stays carried, so "Try again" picks up, not re-runs.
    expect(notice.resumable).toBe(true);
  });

  test("a failure that carried nothing says so in one sentence", () => {
    const notice = describeContextMove(move({ status: "failed", objects: 0 }));
    expect(notice.text).toBe("acme didn't move to @work.");
    expect(notice.resumable).toBe(true);
  });

  test("one note carried is singular, and a reason gets its full stop", () => {
    const notice = describeContextMove(
      move({ status: "failed", objects: 1, error: "  Not available in a keyed workspace yet " }),
    );
    expect(notice.text).toBe(
      "acme stopped partway: 1 note is in @work. Not available in a keyed workspace yet.",
    );
  });
});
