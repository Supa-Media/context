/**
 * The Lab's place lives in the address (Dev2, 2026-11-14: "please make sure we are tracking state in the url so that
 * when we refresh the page or try to go back it doesnt just take us to the lab homepage").
 */
import { describe, expect, test } from "@jest/globals";
import { placeOf, searchOf } from "../features/tex/lab/views/useLabUrl.web";

describe("the Lab's address", () => {
  test("the Lab keeps its page, chat and text; the defaults stay out of the address", () => {
    expect(searchOf({ mode: "lab", view: "canvas", chat: "g1", moment: "ev3" })).toBe("?chat=g1&moment=ev3");
    expect(searchOf({ mode: "lab", view: "canvas", chat: "me", moment: null })).toBe("");
    expect(searchOf({ mode: "lab", view: "sim", chat: "me", moment: null })).toBe("?page=sim");
    expect(searchOf({ mode: "testing", view: "canvas", chat: "g1", moment: "ev3", set: "picnic" })).toBe("?mode=testing&conv=picnic");
  });

  test("Replay is not a mode: an old ?mode=replay address opens the Lab at the same chat and text", () => {
    expect(placeOf("?mode=replay&chat=g1&moment=ev3")).toEqual({ mode: "lab", view: "canvas", chat: "g1", moment: "ev3" });
    expect(placeOf("?mode=replay")).toEqual({ mode: "lab", view: "canvas", chat: "me", moment: null });
    // Written back, it is the Lab's own address, with no mode in it.
    expect(searchOf(placeOf("?mode=replay&chat=g1&moment=ev3"))).toBe("?chat=g1&moment=ev3");
  });

  test("an address reads back as the place it was written from, and anything else falls back to the Lab's home", () => {
    for (const p of [
      { mode: "lab" as const, view: "canvas" as const, chat: "g1", moment: "ev3" },
      { mode: "testing" as const, view: "canvas" as const, chat: "me", moment: null, set: "picnic" },
      { mode: "lab" as const, view: "canvas" as const, chat: "me", moment: null, node: "decide" },
      { mode: "lab" as const, view: "tests" as const, chat: "me", moment: null },
    ])
      expect(placeOf(searchOf(p))).toEqual(p);
    expect(placeOf("?mode=nope&page=<script>&chat=../x&moment=a b")).toEqual({ mode: "lab", view: "canvas", chat: "me", moment: null });
  });
});
