/**
 * Make a component from steps (Dev, 2026-11-27: "there's no way to create new components?"; artboard
 * /lab-new-component-artboards). Several steps are picked on the canvas (`engine/picks.ts`), and Make component wraps
 * them into a new component as one undoable draft change, written as the ops `tex_dev` uses (`engine/makeComponent.ts`).
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-27):
 *   FIELD_NAMES without "group"                    "the moved steps are marked changed ..." fails
 *   whyNot skipping the shared componentRefusal    "a start, a step already in a component ..." fails
 *   setPicks keeping sel while several are picked  "shift-click adds and takes out ..." fails
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { clone, deleteSteps, focusOn, G, lab, MAIN, stepsOf, undo, unfocus } from "@context/lab/app/engine/state";
import { addPicks, clearPicks, inBox, picked, setPicks, togglePick } from "@context/lab/app/engine/picks";
import { componentId, fromWhere, GROUP_CARD, makeComponent, whyNot } from "@context/lab/app/engine/makeComponent";
import { computeMarks } from "@context/lab/app/engine/changeMarks";
import { groupsOf } from "@context/lab/app/data/graph";
import { isGroupFocus, unfoldGroups } from "@context/lab/app/engine/groups";
import { renderGroupFocusHtml } from "@context/lab/app/views/canvas/groupView";
import { renderGraphHtml } from "@context/lab/app/views/canvas/render";
import { simulate } from "@context/lab/app/engine/sim";

(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);
// The toasts' timers and the canvas's fit frames never outlive the run.
jest.useFakeTimers();

const PICK = ["claimChecks", "reviewer", "roomCheck"];

beforeEach(() => {
  lab.cur = clone(MAIN);
  lab.versions = [MAIN];
  lab.undoStack = [];
  lab.sel = null;
  lab.picks = [];
  lab.makeOpen = false;
  lab.cfocus = null;
  lab.view = "canvas";
  lab.chg = "marks";
  lab.chgVs = "main";
  lab.dirty = false;
});

describe("picking several steps", () => {
  test("shift-click adds and takes out; one pick is the ordinary selection, two or more close the step panel", () => {
    focusOn("checkFinish");
    togglePick("claimChecks");
    expect(lab.sel).toEqual({ t: "node", id: "claimChecks" });
    expect(lab.picks).toEqual([]);
    togglePick("reviewer");
    togglePick("roomCheck");
    expect(lab.picks).toEqual(PICK);
    expect(lab.sel).toBeNull();
    togglePick("reviewer");
    expect(picked()).toEqual(["claimChecks", "roomCheck"]);
    togglePick("claimChecks");
    expect(lab.picks).toEqual([]);
    expect(lab.sel).toEqual({ t: "node", id: "roomCheck" });
    clearPicks();
    expect(picked()).toEqual([]);
  });

  test("a box picks every thing it touches, any overlap counting, and adds to what was picked", () => {
    const items = [
      { id: "a", x: 0, y: 0, w: 180, h: 64 },
      { id: "b", x: 0, y: 112, w: 180, h: 64 },
      { id: "c", x: 400, y: 0, w: 180, h: 64 },
    ];
    // Dragged up and to the left: the box is the same.
    expect(inBox(items, { x0: 200, y0: 130, x1: 170, y1: 10 })).toEqual(["a", "b"]);
    expect(inBox(items, { x0: 190, y0: 0, x1: 390, y1: 200 })).toEqual([]);
    focusOn("checkFinish");
    setPicks(["claimChecks"]);
    addPicks(["reviewer", "roomCheck", "reviewer"]);
    expect(lab.picks).toEqual(PICK);
  });

  test("the picked steps are each drawn with the canvas's selected ring", () => {
    focusOn("checkFinish");
    const groups = groupsOf(G());
    const html = renderGroupFocusHtml(G(), simulate(G(), "own", null), "checkFinish", groups, { tags: [], sel: null, lit: null, counts: null, marks: null, picked: new Set(PICK) }).html;
    for (const id of PICK) expect(html).toMatch(new RegExp(`<g class="nd[^"]* sel [^"]*" data-id="${id}"`));
    expect(html).not.toMatch(/<g class="nd[^"]* sel [^"]*" data-id="answerCheck"/);
    const whole = renderGraphHtml(G(), simulate(G(), "own", null), [], null, null, "off", null, null, { groups, picked: null });
    expect(whole).not.toMatch(/ sel /);
  });

  test("Delete removes every one picked as one undo", () => {
    focusOn("checkFinish");
    setPicks(["claimChecks", "reviewer"]);
    deleteSteps(lab.picks);
    const ids = stepsOf(G()).nodes.map((n) => n.id);
    expect(ids).not.toContain("claimChecks");
    expect(ids).not.toContain("reviewer");
    expect(lab.picks).toEqual([]);
    expect(lab.undoStack).toHaveLength(1);
    undo();
    expect(stepsOf(G()).nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["claimChecks", "reviewer"]));
  });
});

describe("why a pick cannot become a component", () => {
  test("a start, a step already in a component, and a group's card each say why, naming the step", () => {
    focusOn("checkInLook");
    expect(whyNot(["checkin", "quietCheck", "checkinResearch"])).toEqual({ text: "Check-in starts a turn, so it can't go in a component.", bold: "Check-in" });
    focusOn("jobs");
    expect(whyNot(["jobStart", "job"])).toEqual({ text: "Job start is already in Jobs.", bold: "Job start" });
    unfocus();
    expect(whyNot(["intake", "checkFinish"])).toEqual({ text: GROUP_CARD, bold: null });
    focusOn("checkFinish");
    expect(whyNot(PICK)).toBeNull();
    expect(fromWhere()).toBe("Check & finish");
  });

  test("the id comes from the name, with a number when it is taken", () => {
    expect(componentId("Reply checks", new Set())).toBe("replyChecks");
    expect(componentId("Reply checks", new Set(["replyChecks", "replyChecks2"]))).toBe("replyChecks3");
    expect(componentId("Check & finish", new Set())).toBe("checkFinish");
    expect(componentId("2 fast", new Set())).toBe("component2Fast");
  });
});

describe("Create", () => {
  test("one undoable change, as tex_dev's ops: a component group and each step in it; the canvas opens it", () => {
    focusOn("checkFinish");
    setPicks(PICK);
    const id = makeComponent(lab.picks, "Reply checks", "Check a reply before it goes.");
    expect(id).toBe("replyChecks");
    expect(lab.cur.id).not.toBe("main");
    expect(lab.cfocus).toBe("replyChecks");
    expect(isGroupFocus(G(), "replyChecks", groupsOf(G()))).toBe(true);
    expect(lab.picks).toEqual([]);
    const full = unfoldGroups(G());
    expect(full.groups?.replyChecks).toMatchObject({ label: "Reply checks", goal: "Check a reply before it goes.", component: true });
    expect(full.groups?.replyChecks?.parent).toBeUndefined();
    expect(full.nodes.filter((n) => n.group === "replyChecks").map((n) => n.id).sort()).toEqual([...PICK].sort());
    // Their settings and wires stay.
    const was = unfoldGroups(MAIN.graph);
    for (const s of PICK) {
      const a = was.nodes.find((n) => n.id === s)!;
      const b = full.nodes.find((n) => n.id === s)!;
      expect({ ...b, group: a.group, x: a.x, y: a.y }).toEqual(a);
    }
    expect(full.edges.length).toBe(was.edges.length);
    expect(lab.undoStack).toHaveLength(1);
    expect(lab.toastText).toBe("Made Reply checks from 3 steps");
    expect(lab.toastBold).toBe("Reply checks");
    // Undo puts it all back and goes back to where the steps were picked.
    lab.toastUndo!();
    expect(groupsOf(G()).replyChecks).toBeUndefined();
    expect(lab.cfocus).toBe("checkFinish");
    expect(unfoldGroups(G()).nodes.find((n) => n.id === "claimChecks")?.group).toBe("checkFinish");
  });

  test("a refused pick makes nothing", () => {
    focusOn("checkInLook");
    expect(makeComponent(["checkin", "quietCheck"], "Nope")).toBeNull();
    expect(lab.cur.id).toBe("main");
    expect(lab.toastText).toBe("Check-in starts a turn, so it can't go in a component.");
  });

  test("the moved steps are marked changed, the box they left too, and the new component's cards are new", () => {
    focusOn("checkFinish");
    makeComponent(PICK, "Reply checks");
    const open = computeMarks(G(), MAIN.graph, "marks", "main");
    for (const id of PICK) expect(open.nodes[id]).toMatchObject({ kind: "changed", fields: expect.arrayContaining(["group"]) });
    expect([...open.newGroups]).toEqual(["replyChecks"]);
    unfocus();
    const whole = computeMarks(G(), MAIN.graph, "marks", "main");
    expect(whole.nodes.checkFinish?.kind).toBe("changed");
    expect(whole.nodes.checkFinish?.fields).toContain("Claim checks moved to Reply checks");
    focusOn("checkFinish");
    const groups = groupsOf(G());
    const marks = computeMarks(G(), MAIN.graph, "marks", "main");
    const html = renderGroupFocusHtml(G(), simulate(G(), "own", null), "checkFinish", groups, { tags: [], sel: null, lit: null, counts: null, marks }).html;
    expect(html).toMatch(/<g class="gref chg-new" data-gport="replyChecks"[^>]*><title>[^<]*<\/title><rect class="chgo"/);
    expect(html).not.toMatch(/<g class="gref chg-new" data-gport="jobs"/);
  });
});
