/**
 * @jest-environment jsdom
 */

/**
 * THE HOMEPAGE'S EMAIL FIELD KEEPS ITS CARET WHILE THE DEMO TYPES.
 *
 * CodeMirror redraws the ```join box when the demo writes a line above it,
 * which throws the old box away. The card lives in one host element that is
 * moved into the new box, and a field that lost focus to that move gets it
 * back where the caret was (Dev2, 2026-09-29: "it should allow me to keep
 * writing my email").
 *
 * SABOTAGE: dropping the refocus in `place` fails the first test; portalling
 * into each box instead of one host fails the second.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import {
  addJoinSlot,
  currentJoinSlot,
  removeJoinSlot,
} from "../features/console/files/livePreview/joinSlot";

function drawBox() {
  const box = document.createElement("div");
  const label = document.createElement("div");
  box.append(label);
  document.body.append(box);
  addJoinSlot({ box, label });
  return box;
}

afterEach(() => {
  for (const box of Array.from(document.body.children)) removeJoinSlot(box as HTMLElement);
  document.body.innerHTML = "";
});

describe("a redraw of the join box", () => {
  test("gives the field back its focus and caret", () => {
    const first = drawBox();
    const field = document.createElement("input");
    currentJoinSlot()!.box.append(field);
    field.value = "me@exam";
    field.focus();
    field.setSelectionRange(7, 7);
    field.dispatchEvent(new Event("keyup", { bubbles: true }));

    // What CodeMirror does: draw the new box, then drop the old one.
    const second = drawBox();
    first.remove();
    removeJoinSlot(first);

    expect(second.contains(field)).toBe(true);
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([7, 7]);
  });

  test("keeps one host, so what is in it is never remounted", () => {
    const first = drawBox();
    const host = currentJoinSlot()!.box;
    const second = drawBox();
    first.remove();
    removeJoinSlot(first);
    expect(currentJoinSlot()!.box).toBe(host);
    expect(second.contains(host)).toBe(true);
  });

  test("does not take focus a person moved elsewhere", () => {
    const first = drawBox();
    const field = document.createElement("input");
    currentJoinSlot()!.box.append(field);
    const other = document.createElement("input");
    document.body.append(other);
    field.focus();
    other.focus();
    drawBox();
    first.remove();
    removeJoinSlot(first);
    expect(document.activeElement).toBe(other);
  });
});
