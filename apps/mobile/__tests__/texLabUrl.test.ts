/**
 * The Lab's place lives in the address (Dev2, 2026-11-14: "please make sure we are tracking state in the url so that
 * when we refresh the page or try to go back it doesnt just take us to the lab homepage").
 */
import { describe, expect, test } from "@jest/globals";
import { placeOf, searchOf } from "../features/tex/lab/views/useLabUrl.web";

describe("the Lab's address", () => {
  test("Replay keeps its chat and moment; the Lab keeps its page; the defaults stay out of the address", () => {
    expect(searchOf({ mode: "replay", view: "canvas", chat: "g1", moment: "ev3" })).toBe("?mode=replay&chat=g1&moment=ev3");
    expect(searchOf({ mode: "replay", view: "canvas", chat: "me", moment: null })).toBe("?mode=replay");
    expect(searchOf({ mode: "lab", view: "sim", chat: "g1", moment: "ev3" })).toBe("?page=sim");
    expect(searchOf({ mode: "lab", view: "canvas", chat: "me", moment: null })).toBe("");
  });

  test("an address reads back as the place it was written from, and anything else falls back to the Lab's home", () => {
    for (const p of [
      { mode: "replay" as const, view: "canvas" as const, chat: "g1", moment: "ev3" },
      { mode: "lab" as const, view: "tests" as const, chat: "me", moment: null },
    ])
      expect(placeOf(searchOf(p))).toEqual(p);
    expect(placeOf("?mode=nope&page=<script>&chat=../x&moment=a b")).toEqual({ mode: "lab", view: "canvas", chat: "me", moment: null });
  });
});
