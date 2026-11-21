/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { createElement, mountFrame, TogglesProbe } from "./fixtures";

/** A pointer width where the panel is no longer a column. */
const MEDIUM = 900;

/**
 * THE NOTE CARD AND THE FULL-HEIGHT PANEL (Dev2, 2026-11-20, the approved in-app Tex mock).
 *
 * At a pointer density the open notes sit inside the top of the note card rather than hanging from a bar across the
 * window, and the right panel runs the frame's full height beside the bar instead of starting under it.
 */
describe("the note card", () => {
  test("holds the tabs at a pointer density", () => {
    const frame = mountFrame(1280);
    const card = frame.find("frame-note-card-top");
    const tabs = frame.find("tabs");
    expect(card).not.toBeNull();
    expect(tabs).not.toBeNull();
    expect(card!.contains(tabs)).toBe(true);
    frame.unmount();
  });

  test("is not drawn on a phone", () => {
    const frame = mountFrame(390);
    expect(frame.find("frame-note-card-top")).toBeNull();
    frame.unmount();
  });
});

describe("the right panel as a column", () => {
  test("runs beside the top bar rather than under it", () => {
    const frame = mountFrame(1280);
    const column = frame.find("frame-aside-column");
    const bar = frame.find("app-top-bar");
    expect(column).not.toBeNull();
    expect(bar).not.toBeNull();
    // Neither holds the other, and the bar's column is the panel's sibling: they share a row.
    expect(bar!.contains(column)).toBe(false);
    expect(column!.parentElement!.contains(bar)).toBe(true);
    expect(column!.parentElement!.firstElementChild!.contains(bar)).toBe(true);
    frame.unmount();
  });
});

describe("the panel moving out of its column", () => {
  /*
    2026-11-21: the row holding the panel came and went with it, so a width where the panel stops being a column
    (medium density, where opening Tex overlays it) handed React a different tree and remounted the body. The note
    editor went with it, and a Tex run writing into that editor lost what it wrote.
  */
  test("keeps the note's own nodes rather than remounting them", () => {
    const frame = mountFrame(MEDIUM, [
      createElement(TogglesProbe, { key: "probe" }),
      createElement("span", { key: "note", "data-testid": "note-body" }, "the note"),
    ]);
    const before = frame.find("note-body");
    expect(before).not.toBeNull();
    // Shut, the panel is its strip in a column; opened at medium it comes in over the note instead.
    expect(frame.find("frame-aside-column")).not.toBeNull();
    frame.press("probe-toggle-aside");
    expect(frame.find("frame-aside-column")).toBeNull();
    expect(frame.find("note-body")).toBe(before);
    frame.unmount();
  });
});
