/**
 * @jest-environment jsdom
 *
 * Putting the caret back in a table cell never lets the browser pick the
 * scroll: a cell focused right after its table was redrawn (a row or column
 * deleted) could take the note to its top. The browser end of this is
 * `e2e/webkit/pasting.spec.ts`; this pins the call.
 */
import { describe, expect, jest, test } from "@jest/globals";

import { focusCell } from "../features/console/files/livePreview/gridDom";

function grid(): { wrap: HTMLElement; cell: HTMLElement } {
  const wrap = document.createElement("div");
  const cell = document.createElement("div");
  cell.setAttribute("data-lp-row", "0");
  cell.setAttribute("data-lp-column", "1");
  cell.setAttribute("contenteditable", "true");
  cell.textContent = "2";
  wrap.append(cell);
  document.body.append(wrap);
  return { wrap, cell };
}

describe("focusCell", () => {
  test("focuses the cell without letting the browser scroll", () => {
    const { wrap, cell } = grid();
    const focus = jest.spyOn(cell, "focus");
    expect(focusCell(wrap, 0, 1, "end")).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(cell);
  });

  test("a cell with no box yet is not scrolled to", () => {
    const { wrap, cell } = grid();
    const scroll = jest.fn();
    cell.scrollIntoView = scroll;
    focusCell(wrap, 0, 1, "start");
    expect(scroll).not.toHaveBeenCalled();
  });

  test("a laid-out cell below the screen is brought into view, nearest edge only", () => {
    const { wrap, cell } = grid();
    const scroll = jest.fn();
    cell.scrollIntoView = scroll;
    cell.getBoundingClientRect = () =>
      ({ top: 5000, bottom: 5020, left: 0, right: 40, width: 40, height: 20 }) as DOMRect;
    focusCell(wrap, 0, 1, "start");
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });
});
