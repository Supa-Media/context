/**
 * The Lab canvas's edits (`features/tex/lab/views/canvas/actions.ts`), ported from the artifact's `delSel` and
 * `addStep`: deleting a step drops its wires and the reads of its output, the start and the send can't be deleted,
 * a wire deletes alone, an edit to main makes your own copy first, and undo brings it all back.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-13):
 *   delSel without the start/send guard          "the start and the send stay" fails
 *   delSel keeping `out:<id>` reads              "a step goes with its wires and reads" fails
 */
import { beforeEach, describe, expect, test } from "@jest/globals";
import {
  clone,
  G,
  lab,
  MAIN,
  node,
  undo,
} from "../features/tex/lab/engine/state";
import { addStep, delSel } from "../features/tex/lab/views/canvas/actions";

beforeEach(() => {
  lab.cur = clone(MAIN);
  lab.versions = [MAIN];
  lab.undoStack = [];
  lab.sel = null;
  lab.dirty = false;
});

describe("canvas edits", () => {
  test("a step goes with its wires and reads, on your own copy, and undo brings it back", () => {
    const reader = G().nodes.find((n) =>
      n.ctx.some((c) => c.startsWith("out:")),
    )!;
    const id = reader.ctx.find((c) => c.startsWith("out:"))!.slice(4);
    const before = JSON.stringify(G());
    lab.sel = { t: "node", id };
    delSel();
    expect(lab.cur.id).not.toBe("main");
    expect(node(id)).toBeUndefined();
    expect(G().edges.some((e) => e.from === id || e.to === id)).toBe(false);
    expect(G().nodes.some((n) => n.ctx.includes("out:" + id))).toBe(false);
    expect(lab.toastText).toBe("Deleted. Undo brings it back.");
    undo();
    expect(JSON.stringify(G())).toBe(before);
  });

  test("the start and the send stay", () => {
    for (const id of ["text", "send"]) {
      lab.sel = { t: "node", id };
      delSel();
      expect(node(id)).toBeDefined();
      expect(lab.toastText).toBe("Every version needs a start and a send");
    }
    expect(lab.cur.id).toBe("main");
  });

  test("a wire deletes alone", () => {
    const n = G().edges.length;
    const e = G().edges[2];
    lab.sel = { t: "edge", i: 2 };
    delSel();
    expect(G().edges.length).toBe(n - 1);
    expect(G().edges).not.toContainEqual(e);
    expect(lab.toastText).toBe("Wire deleted");
  });

  test("a new step lands in the middle, selected, with the next free name", () => {
    addStep("clef", { x: 0, y: 0, k: 1 }, { width: 800, height: 600 });
    addStep("code", { x: 0, y: 0, k: 1 }, { width: 800, height: 600 });
    expect(node("step1")).toMatchObject({
      label: "New step 1",
      model: "clef",
      x: 310,
      y: 270,
    });
    expect(node("step2")).toMatchObject({
      label: "New step 2",
      model: "code",
      ms: 200,
    });
    expect(lab.sel).toEqual({ t: "node", id: "step2" });
  });
});
