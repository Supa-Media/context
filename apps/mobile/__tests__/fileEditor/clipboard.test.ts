/**
 * Copy, cut and paste, and copying into a folder with the source named rather
 * than remembered.
 *
 * Split out of `fileEditor.test.ts`; see `fixtures.ts` in this folder.
 */

import { describe, expect, test } from "@jest/globals";
import { describeMoveProblem } from "../../features/console/files/paths";
import { afterPaste, planPaste, put } from "../../features/console/files/clipboard";

describe("copy, cut and paste", () => {
  test("a copy into an empty folder keeps its name", () => {
    expect(planPaste(put("copy", "1-projects/a.md"), "2-areas", new Set())).toEqual({
      ok: true,
      action: "copy",
      from: "1-projects/a.md",
      to: "2-areas/a.md",
    });
  });

  test("a copy into its own folder takes the next free copy name", () => {
    expect(
      planPaste(put("copy", "1-projects/a.md"), "1-projects", new Set(["a.md", "a copy.md"])),
    ).toEqual({
      ok: true,
      action: "copy",
      from: "1-projects/a.md",
      to: "1-projects/a copy 2.md",
    });
  });

  test("a cut becomes a move", () => {
    expect(planPaste(put("cut", "1-projects/a.md"), "2-areas", new Set())).toEqual({
      ok: true,
      action: "move",
      from: "1-projects/a.md",
      to: "2-areas/a.md",
    });
  });

  /**
   * A move that renamed itself out of a collision would have done something
   * other than what was asked, and the original would be gone.
   */
  test("a cut onto an existing name is refused rather than renamed", () => {
    const plan = planPaste(put("cut", "1-projects/a.md"), "2-areas", new Set(["a.md"]));
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toMatch(/Rename one of them first/);
  });

  test("a cut into its own folder is a no-op, and says so", () => {
    const plan = planPaste(put("cut", "1-projects/a.md"), "1-projects", new Set(["a.md"]));
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toMatch(/already there/);
  });

  test("a folder cannot be pasted inside itself", () => {
    const plan = planPaste(put("copy", "1-projects"), "1-projects/plans", new Set());
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toMatch(/inside itself/);
  });

  test("pasting nothing says nothing has been copied", () => {
    const plan = planPaste(null, "1-projects", new Set());
    expect(plan.ok).toBe(false);
  });

  test("a cut is spent once it lands; a copy stays on the clipboard", () => {
    expect(afterPaste(put("cut", "1-projects/a.md"))).toBeNull();
    expect(afterPaste(put("copy", "1-projects/a.md"))).toEqual(put("copy", "1-projects/a.md"));
  });
});

/**
 * `copyTo(from, folder)` — the ⌥-drop — plans exactly like a copy-and-paste,
 * except that the source is an argument instead of the clipboard.
 *
 * That distinction is the whole point of the method, and it is here because
 * the drop handler used to spell it `files.copy(from); files.paste(folder)`.
 * `copy` is a state setter and `paste` reads the clipboard from the render
 * that scheduled it, so in one tick the paste never saw the copy: with an
 * empty clipboard it refused, and with somebody's pending **cut** on the
 * clipboard it moved *that* file into the drop folder — data movement nobody
 * asked for, from a gesture aimed at a different file entirely.
 *
 * These exercise the pure layer, which is where the property is provable: a
 * plan built from an explicit source is a function of that source, and the
 * clipboard is not one of its inputs.
 */
describe("copying into a folder, with the source named rather than remembered", () => {
  test("the plan follows the dragged path, whatever is on the clipboard", () => {
    const dragged = "1-projects/a.md";

    expect(planPaste(put("copy", dragged), "3-resources", new Set())).toEqual({
      ok: true,
      action: "copy",
      from: dragged,
      to: "3-resources/a.md",
    });

    // What the clipboard happens to hold at that moment — here a cut of an
    // entirely different file — would have produced this instead. Same
    // destination, wrong file, and a *move*: the old spelling's worst case,
    // kept next to the right answer so the difference is visible.
    expect(planPaste(put("cut", "2-areas/other.md"), "3-resources", new Set())).toEqual({
      ok: true,
      action: "move",
      from: "2-areas/other.md",
      to: "3-resources/other.md",
    });
  });

  test("an empty clipboard is no obstacle, because it is not consulted", () => {
    expect(planPaste(null, "3-resources", new Set()).ok).toBe(false);
    expect(planPaste(put("copy", "1-projects/a.md"), "3-resources", new Set()).ok).toBe(true);
  });

  test("a collision in the destination takes the next free copy name", () => {
    expect(
      planPaste(put("copy", "1-projects/a.md"), "2-areas", new Set(["a.md", "a copy.md"])),
    ).toEqual({
      ok: true,
      action: "copy",
      from: "1-projects/a.md",
      to: "2-areas/a copy 2.md",
    });
  });

  /**
   * Dropping a file onto the folder it already sits in is a legal copy — it is
   * how you duplicate something by dragging — where the same drop *without* ⌥
   * is refused as a move that would do nothing. The two answers differing is
   * the behaviour, not an inconsistency.
   */
  test("copying into its own folder renames; moving into it is refused", () => {
    const taken = new Set(["a.md"]);
    expect(planPaste(put("copy", "1-projects/a.md"), "1-projects", taken)).toEqual({
      ok: true,
      action: "copy",
      from: "1-projects/a.md",
      to: "1-projects/a copy.md",
    });
    expect(describeMoveProblem("1-projects/a.md", "1-projects", taken)).toMatch(/already there/);
  });
});
