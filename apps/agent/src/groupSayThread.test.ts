import { describe, expect, it } from "vitest";
import { threadUnder } from "./groupSay";

describe("groupSay threadUnder", () => {
  it("a routine's run (messageId '') threads under nothing, so no line is asked to reply under ''", () => {
    expect(threadUnder({ messageId: "" })).toBeUndefined();
  });

  it("a text threads under itself, and a tapback under the Tex text it was on", () => {
    expect(threadUnder({ messageId: "m1" })).toBe("m1");
    expect(threadUnder({ messageId: "t1", reaction: { how: "Liked", words: "" }, answersTapback: { on: "tex1" } })).toBe("tex1");
  });
});
