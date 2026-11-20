import { describe, expect, it } from "vitest";
import { REACT_EMOJI, reactionFor } from "./reactEmoji";

/** The control plane's list pins the same string (`apps/convex/__tests__/textDecideEmoji.test.ts`). */
const PINNED = "❤️👍👎😂🤣😊😁😉😍🤗🤔👀😮🤯😢😔☹️😬😅🤦🤷🙏👏🙌💪👌👋🫡🤝🤞🎉🥳🔥⭐✨💯🚀🏆💡‼️❓⏳📅⏰📝📚💻📱📧💰📈🏠✈️🚗☕🍕🥂🎂🎁🎵☀️🌙🐶🌱";

describe("the reaction emoji decide may choose", () => {
  it("are the control plane's 64, in its order", () => {
    expect(REACT_EMOJI.join("")).toBe(PINNED);
    expect(new Set(REACT_EMOJI).size).toBe(64);
  });

  it("only one of the 64 is sent; anything else falls back to the words' emoji", () => {
    expect(reactionFor("🎉", "👍")).toBe("🎉");
    for (const other of [undefined, "🦄", "🎉🎉", "", "hello"]) expect(reactionFor(other, "👍")).toBe("👍");
  });
});
