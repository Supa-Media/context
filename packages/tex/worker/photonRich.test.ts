import { describe, expect, it } from "vitest";
import { appCardWords, effectName, richWords, taggedWords } from "./photonRich";

describe("photonRich: what iMessage shows beyond the words", () => {
  it("marks each tagged range with an @, once, and skips a range it cannot place", () => {
    expect(taggedWords("Tex and Sam", [{ start: 0, length: 3 }, { start: 8, length: 3 }])).toBe("@Tex and @Sam");
    expect(taggedWords("@Tex hi", [{ start: 1, length: 3 }])).toBe("@Tex hi");
    expect(taggedWords("@Tex hi", [{ start: 0, length: 4 }])).toBe("@Tex hi");
    expect(taggedWords("Tex", [{ start: 2, length: 5 }, { start: -1, length: 1 }, { start: 0, length: 0 }, "x"])).toBe("Tex");
    // Overlapping ranges: only the later one is marked, never a split name.
    expect(taggedWords("Sam Lee", [{ start: 0, length: 7 }, { start: 4, length: 3 }])).toBe("Sam @Lee");
    // UTF-16 ranges, as Photon counts them: an emoji before the tag is two units.
    expect(taggedWords("👋 Tex", [{ start: 3, length: 3 }])).toBe("👋 @Tex");
  });

  it("names an effect as Messages does, and an unknown one generically", () => {
    expect(effectName("com.apple.MobileSMS.expressivesend.invisibleink")).toBe("Invisible Ink");
    expect(effectName("com.apple.messages.effect.CKConfettiEffect")).toBe("Confetti");
    expect(effectName("com.apple.messages.effect.CKSomethingNew")).toBe("an effect");
    expect(effectName(undefined)).toBeNull();
  });

  it("reads a card's own words, falling back to its summary, and nothing for an empty card", () => {
    expect(appCardWords({ bundle: "com.apple.findmy.FindMyMessagesApp", caption: "Sam's location", subcaption: "Sam's location" })).toBe("Find My card: Sam's location");
    expect(appCardWords({ name: "Trivia", summary: "Play Trivia with me" })).toBe("Trivia card: Play Trivia with me");
    expect(appCardWords({ name: "Empty" })).toBeNull();
    expect(appCardWords(null)).toBeNull();
  });

  it("puts the effect first, then the card, then the words", () => {
    expect(richWords({ text: " hi ", effect: "com.apple.messages.effect.CKHeartEffect", app: { name: "X", caption: "c" } }, true)).toBe("(sent with Love) (X card: c) hi");
    expect(richWords({ text: "hi", app: { name: "X", caption: "c" } }, false)).toBe("hi");
    expect(richWords({ text: "", effect: "com.apple.MobileSMS.expressivesend.impact" }, false)).toBe("");
  });
});
