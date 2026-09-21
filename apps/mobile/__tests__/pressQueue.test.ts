/**
 * THE CONTROL PRESSED FASTER THAN THE SERVER ANSWERS.
 *
 * Reported from the console: clicking through the sharing options for a folder
 * quickly left it in the wrong state. It is two defects wearing one symptom,
 * and this file covers the sequencing half — `pressQueue.ts` has the argument.
 *
 * What a press does is not one write. Closing a note is revoke-then-narrow and
 * opening one is the reverse, and `stepsTo` settles that order because getting
 * it wrong leaves a note the owner believes is private with a live link on it.
 * Nothing stopped a second press starting inside the first, so two sequences
 * interleaved and the outcome was whichever step landed last.
 */

import { describe, expect, test } from "@jest/globals";
import { createPressQueue } from "../features/console/files/pressQueue";

/**
 * Let whatever is queued actually begin.
 *
 * A press is queued synchronously and starts on a microtask, so a test that
 * queues two in one tick is testing "two presses arrived before either began" —
 * a real case, and the one `a press superseded before it starts` is about, but
 * not the case where a sequence is *interrupted*. Reaching that needs the first
 * press to be running, which is what this waits for.
 */
async function begun(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** A promise a test resolves by hand, so ordering is decided here. */
function gate() {
  let open: () => void = () => {};
  const waited = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, waited };
}

describe("presses on one control", () => {
  test("two presses never run at the same time", async () => {
    const queue = createPressQueue<string>();
    const order: string[] = [];
    const first = gate();

    const a = queue.run("note.md", async () => {
      order.push("a:start");
      await first.waited;
      order.push("a:end");
      return "a";
    });
    await begun();
    // Queued while `a` is still inside its await. If this ran now, the two
    // sequences would interleave — which is the bug.
    const b = queue.run("note.md", async () => {
      order.push("b:start");
      order.push("b:end");
      return "b";
    });

    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  test("a press superseded before it starts never runs at all", async () => {
    /*
      The half that makes serializing usable. A queue that faithfully replayed
      a burst — private, team, link, team, private — would mint a share and
      revoke it for positions nobody is still asking for, and arrive slowly
      back where the person started.
    */
    const queue = createPressQueue<string>();
    const ran: string[] = [];
    const first = gate();

    const a = queue.run("note.md", async () => {
      ran.push("a");
      await first.waited;
      return "a";
    });
    await begun();
    const b = queue.run("note.md", async () => {
      ran.push("b");
      return "b";
    });
    const c = queue.run("note.md", async () => {
      ran.push("c");
      return "c";
    });

    first.open();
    await Promise.all([a, b, c]);
    // `b` was superseded by `c` while both waited behind `a`.
    expect(ran).toEqual(["a", "c"]);
  });

  test("a press superseded mid-sequence is told, so it can stop at its next step", async () => {
    const queue = createPressQueue<string>();
    const steps: string[] = [];
    const started = gate();

    const a = queue.run("note.md", async ({ live }) => {
      steps.push("a:step1");
      await started.waited;
      if (!live()) return undefined;
      steps.push("a:step2");
      return "a";
    });
    await begun();
    const b = queue.run("note.md", async () => {
      steps.push("b:step1");
      return "b";
    });

    started.open();
    await Promise.all([a, b]);
    // `a` stopped rather than writing a second time for a position nobody is
    // still asking for, and `b` did the whole job from the live state.
    expect(steps).toEqual(["a:step1", "b:step1"]);
  });

  test("the position a press left behind reaches the next one in the burst", async () => {
    /*
      A sequence's writes have landed by the time the next starts, but the
      subscription that tells the screen has not necessarily ticked — so the
      next press would compute its steps from a position two writes old.
    */
    const queue = createPressQueue<string>();
    const seen: (string | undefined)[] = [];
    const first = gate();

    const a = queue.run("note.md", async ({ carried }) => {
      seen.push(carried);
      await first.waited;
      return "team";
    });
    await begun();
    const b = queue.run("note.md", async ({ carried }) => {
      seen.push(carried);
      return "private";
    });

    first.open();
    await Promise.all([a, b]);
    expect(seen).toEqual([undefined, "team"]);
  });

  test("...and is forgotten once the burst drains", async () => {
    // Past the end of a burst the live state is the better answer, and
    // somebody else changing the same note is the likelier difference.
    const queue = createPressQueue<string>();
    const seen: (string | undefined)[] = [];

    await queue.run("note.md", async ({ carried }) => {
      seen.push(carried);
      return "team";
    });
    await queue.run("note.md", async ({ carried }) => {
      seen.push(carried);
      return "private";
    });

    expect(seen).toEqual([undefined, undefined]);
  });

  test("a press that threw carries nothing, because it left the position unknown", async () => {
    const queue = createPressQueue<string>();
    const seen: (string | undefined)[] = [];
    const first = gate();

    const a = queue.run("note.md", async () => {
      await first.waited;
      throw new Error("the server refused");
    });
    await begun();
    const b = queue.run("note.md", async ({ carried }) => {
      seen.push(carried);
      return "private";
    });

    first.open();
    await Promise.all([a, b]);
    expect(seen).toEqual([undefined]);
  });

  test("a throw does not take the queue with it", async () => {
    const queue = createPressQueue<string>();
    await queue.run("note.md", async () => {
      throw new Error("refused");
    });
    let reached = false;
    await queue.run("note.md", async () => {
      reached = true;
      return undefined;
    });
    expect(reached).toBe(true);
  });

  test("two different notes do not wait for each other", async () => {
    // Keyed per entry: somebody sharing one folder must not be held up by a
    // press on another, and neither can supersede the other.
    const queue = createPressQueue<string>();
    const ran: string[] = [];
    const held = gate();

    const a = queue.run("a.md", async () => {
      ran.push("a");
      await held.waited;
      return undefined;
    });
    await begun();
    const b = queue.run("b.md", async () => {
      ran.push("b");
      return undefined;
    });

    await b;
    expect(ran).toEqual(["a", "b"]);
    held.open();
    await a;
  });
});
