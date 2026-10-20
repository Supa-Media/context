import { describe, expect, it } from "vitest";
import { ackEmoji } from "./ackEmoji";

describe("the tapback fits the text", () => {
  it("is sorry when they are upset with Tex (Dev, 2026-10-20)", () => {
    expect(["☹️", "😔"]).toContain(ackEmoji("did you see anything I said in this thread at all??? are you dumb???"));
    expect(["☹️", "😔"]).toContain(ackEmoji("this is useless"));
  });

  it("looks when they ask to find something, and thinks on a question", () => {
    expect(["🔎", "🕵️\u200D♂️"]).toContain(ackEmoji("can you find the lucky strike email"));
    expect(ackEmoji("what time is dinner on friday?")).toBe("🤔");
  });

  it("paints for a picture, codes for a site, and laughs along", () => {
    expect(["🎨", "🧑\u200D🎨"]).toContain(ackEmoji("make me a flyer for the picnic"));
    expect(ackEmoji("the website is down")).toBe("👨\u200D💻");
    expect(["😭", "😅"]).toContain(ackEmoji("lmao ok"));
    expect(ackEmoji("let's go, the deposit came in")).toBe("🤩");
  });

  it("is 👀 otherwise, the same every time, and never says done", () => {
    expect(ackEmoji("email her")).toBe("👀");
    expect(ackEmoji("make this guy blue")).toBe(ackEmoji("make this guy blue"));
    for (const text of ["yes send it", "add it to my calendar", "remind me at 9"]) expect(ackEmoji(text)).not.toBe("✅");
  });
});
