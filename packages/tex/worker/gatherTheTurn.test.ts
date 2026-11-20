/**
 * gatherTheTurn: ONE RULE FOR WHAT A TURN ANSWERS, 1:1 AND GROUP (`gatherTheTurn.ts`).
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. without `mustAnswer` on the skipped text → "a bare thanks it skipped is left" fails.
 *  2. without the "nothing named" fallback → "nothing named: the newest" fails.
 */

import { describe, expect, it } from "vitest";
import { gatherTheTurn } from "./gatherTheTurn";

type T = { id: string; must: boolean };
const t = (id: string, must = true): T => ({ id, must });
const ids = (entries: T[]) => entries.map((entry) => entry.id);
const gather = (burst: T[], covers: string[]) => {
  const out = gatherTheTurn(burst, (entry) => covers.includes(entry.id), (entry) => entry.must);
  return { answer: ids(out.answer), left: ids(out.left) };
};

describe("gatherTheTurn", () => {
  it("answers what decide named, and leaves what it skipped before that", () => {
    expect(gather([t("a", false), t("b"), t("c")], ["b", "c"])).toEqual({ answer: ["b", "c"], left: ["a"] });
  });

  it("an older text Tex must answer that decide skipped goes first, on its own", () => {
    expect(gather([t("a"), t("b"), t("c")], ["b", "c"])).toEqual({ answer: ["a"], left: [] });
    expect(gather([t("x"), t("a"), t("b")], ["x", "b"])).toEqual({ answer: ["x", "a"], left: [] });
  });

  it("a bare thanks it skipped is left, not answered first", () => {
    expect(gather([t("thanks", false), t("b")], ["b"])).toEqual({ answer: ["b"], left: ["thanks"] });
  });

  it("nothing named: the newest is answered", () => {
    expect(gather([t("a", false), t("b", false)], [])).toEqual({ answer: ["b"], left: ["a"] });
  });

  it("texts after the answer are neither answered nor left: they wait", () => {
    expect(gather([t("a"), t("b", false)], ["a"])).toEqual({ answer: ["a"], left: [] });
  });
});
