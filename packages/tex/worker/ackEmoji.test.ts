import { describe, expect, it } from "vitest";
import { ackEmoji } from "./ackEmoji";

describe("the tapback fits the text", () => {
  it("is sorry when they are upset with Tex (Dev, 2026-10-20)", () => {
    expect(["☹️", "😔"]).toContain(ackEmoji("did you see anything I said in this thread at all??? are you dumb???"));
    expect(["☹️", "😔"]).toContain(ackEmoji("this is useless"));
  });

  it("cares when something hard happened, and never laughs at it", () => {
    expect(["🫂", "❤️\u200D🩹"]).toContain(ackEmoji("my grandma is in the hospital, can you move my meetings tomorrow"));
    expect(["🫂", "❤️\u200D🩹"]).toContain(ackEmoji("rough day. what's left on my list"));
  });

  it("laughs along, is warm to a thanks, and celebrates good news", () => {
    expect(["😂", "😭", "💀"]).toContain(ackEmoji("lmao ok"));
    expect(["🫶", "🥰"]).toContain(ackEmoji("thank you so much"));
    expect(["🥳", "🙌", "🤩"]).toContain(ackEmoji("let's go, the deposit came in"));
  });

  it("fits the errand (Dev2, 2026-10-25: not 👀 on everything)", () => {
    expect(ackEmoji("make me a flyer for the picnic")).toBe("🎨");
    expect(ackEmoji("the website is down")).toBe("🧑\u200D💻");
    expect(ackEmoji("remind me at 9 to call Sam")).toBe("⏰");
    expect(ackEmoji("move my 3pm meeting to thursday")).toBe("🗓️");
    expect(["🔎", "🕵️"]).toContain(ackEmoji("can you find the lucky strike email"));
    expect(["✍️", "📝"]).toContain(ackEmoji("email her back and say friday works"));
    expect(["✈️", "🧳"]).toContain(ackEmoji("get me a cheap flight to london on the 14th"));
    expect(["🍽️", "😋"]).toContain(ackEmoji("book a table for 4 somewhere nice saturday"));
    expect(["🛒", "💸"]).toContain(ackEmoji("order more paper towels"));
    expect(["🤔", "🧐"]).toContain(ackEmoji("what time is the show on friday?"));
  });

  it("says on it otherwise, in a few ways, the same one for the same text, and never done", () => {
    const onIt = ["🫡", "👌", "💪", "🤝", "👀"];
    const errands = ["handle it", "go ahead", "take care of the thing we talked about", "sort out the branding", "tidy my notes", "make this guy blue"];
    for (const text of errands) expect([...onIt, "🎨"]).toContain(ackEmoji(text));
    expect(new Set(["handle it", "go ahead", "take care of the thing we talked about", "sort out the branding", "tidy my notes"].map(ackEmoji)).size).toBeGreaterThan(1);
    expect(ackEmoji("make this guy blue")).toBe(ackEmoji("make this guy blue"));
    for (const text of ["yes send it", "add it to my calendar", "remind me at 9"]) expect(ackEmoji(text)).not.toBe("✅");
  });

  it("never taps a gendered person: Tex doesn't know who is reading", () => {
    for (const text of ["fix the site", "find my passport photo", "track down that email", "the app crashed"]) {
      expect(ackEmoji(text)).not.toMatch(/\u200D[♀♂]/u);
    }
  });
});
