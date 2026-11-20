/**
 * The ask card's page (`features/tex/page/TexAskScreen.tsx`): what it says before, after and when an answer does not go.
 */
import { describe, expect, it } from "@jest/globals";
import { ASK_KEY, askAnswerLine } from "../features/tex/page/texAsk";

describe("the ask card's page", () => {
  it("takes only a card's own key", () => {
    expect(ASK_KEY.test("1x9ab")).toBe(true);
    expect(ASK_KEY.test("")).toBe(false);
    expect(ASK_KEY.test("../me")).toBe(false);
    expect(ASK_KEY.test("abcdefghi")).toBe(false);
  });

  it("says the answer goes to the chat, then where Tex carries on", () => {
    expect(askAnswerLine({ kind: "asking" }, false)).toMatch(/same as replying yes or no/);
    expect(askAnswerLine({ kind: "done", yes: true }, false)).toMatch(/carry on in Messages/);
    expect(askAnswerLine({ kind: "done", yes: false }, false)).toMatch(/won't go ahead/);
  });

  it("says why when it did not go, never an error code", () => {
    expect(askAnswerLine({ kind: "failed", error: "stale" }, false)).toMatch(/newer/);
    expect(askAnswerLine({ kind: "failed", error: "no_ask" }, false)).toMatch(/Nothing is waiting/);
    expect(askAnswerLine({ kind: "failed", error: "status_503" }, false)).toMatch(/Reply yes or no to Tex in Messages/);
    expect(askAnswerLine({ kind: "asking" }, true)).toMatch(/Sign in with the account you text Tex from/);
  });
});
