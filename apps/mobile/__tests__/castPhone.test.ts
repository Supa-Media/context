import { describe, expect, test } from "@jest/globals";
import { castStepLine, splitWebsiteCast } from "@context/shared";
import { phoneShowsAfter, phoneShowsCut } from "../features/home/cast/castCamera";
import { paneMotion, phoneBoxes, phoneView } from "../features/home/cast/PhoneDesk";

/*
  A scene on a phone (Dev2, 2026-09-30): both apps split, or "full screen on
  a specific app", switching "like on ios", and whatever matters inside the
  Reels safe zone.
*/

const block = (lines: string) => `# Home\n\n\`\`\`cast\n${lines}\n\`\`\`\n`;
const parse = (lines: string) => splitWebsiteCast(block(lines));

describe("the script's words", () => {
  test("phone: split or one app, kept beside the chat's own framing, either order", () => {
    expect(parse("phone: one app\nchat: dark\n@maya asks Claude: hi").chat).toEqual({ layout: "side", look: "dark", phone: "one" });
    expect(parse("chat: cut\nphone: split\n@maya asks Claude: hi").chat).toEqual({ layout: "cut", look: "warm", phone: "split" });
    expect(parse("phone: full screen\n@maya asks Claude: hi").chat?.phone).toBe("one");
    expect(parse("chat: plain\n@maya asks Claude: hi").chat?.phone).toBeUndefined();
    const wrong = parse("phone: sideways\n@maya asks Claude: hi");
    expect(wrong.chat).toBeUndefined();
    expect(wrong.problems[0]).toMatch(/Try split or one app/);
  });

  test("shows: is a cut in the scene, done by nobody", () => {
    const { steps, problems } = parse("shows: Context\nshows: both\nshows: ChatGPT\nshows: the whole world!");
    expect(steps).toEqual([
      { kind: "shows", what: "context" },
      { kind: "shows", what: "both" },
      { kind: "shows", what: "ChatGPT" },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Not something a phone can show/);
  });

  test("a cut is written back the way it reads", () => {
    for (const line of ["shows: Context", "shows: both", "shows: Claude"]) {
      const step = parse(line).steps[0]!;
      expect(castStepLine(step)).toBe(line);
      expect(parse(castStepLine(step)).steps[0]).toEqual(step);
    }
  });
});

describe("what a phone shows", () => {
  const ask = { kind: "ask", agent: "Claude", from: "@maya", text: "hi" } as const;
  const working = { kind: "tool", agent: "Claude", id: 1, verb: "Added folder", what: "Beta", done: false } as const;
  const done = { ...working, done: true } as const;
  const answer = { kind: "answer", agent: "Claude", id: 2, text: "Done.", done: true } as const;

  test("split stays split whatever happens in the chat", () => {
    for (const event of [ask, working, done, answer]) expect(phoneShowsAfter(undefined, event, undefined)).toBe("both");
    expect(phoneShowsAfter("context", ask, "split")).toBe("context");
  });

  test("one app goes to the chat being asked, and to Context when a step starts there", () => {
    expect(phoneShowsAfter(undefined, ask, "one")).toBe("Claude");
    expect(phoneShowsAfter("Claude", working, "one")).toBe("context");
    // The step finishing, and the answer after it, stay where the film is.
    expect(phoneShowsAfter("context", done, "one")).toBe("context");
    expect(phoneShowsAfter("context", answer, "one")).toBe("context");
  });

  test("a cut to an assistant uses its window's name", () => {
    expect(phoneShowsCut("chatgpt", ["Claude", "ChatGPT"])).toBe("ChatGPT");
    expect(phoneShowsCut("context", ["Claude"])).toBe("context");
  });

  test("panes: an assistant's name is its chat", () => {
    expect(phoneView(undefined)).toBe("both");
    expect(phoneView("both")).toBe("both");
    expect(phoneView("context")).toBe("context");
    expect(phoneView("Claude")).toBe("chat");
  });
});

describe("inside the Reels safe zone", () => {
  // Instagram's zone on a 1080×1920 frame: 250 top, 420 bottom, 70 left,
  // 55 right, and 193 right below 1110 where the like and share buttons are.
  const px = (box: { top: string; bottom: string; left: string; right: string }) => ({
    top: (parseFloat(box.top) / 100) * 1920,
    bottom: 1920 - (parseFloat(box.bottom) / 100) * 1920,
    left: (parseFloat(box.left) / 100) * 1080,
    right: 1080 - (parseFloat(box.right) / 100) * 1080,
  });
  const inside = (box: ReturnType<typeof px>) => {
    expect(box.top).toBeGreaterThanOrEqual(250);
    expect(box.bottom).toBeLessThanOrEqual(1920 - 420);
    expect(box.left).toBeGreaterThanOrEqual(70);
    expect(box.right).toBeLessThanOrEqual(box.bottom > 1110 ? 1080 - 193 : 1080 - 55);
  };

  test("split: Context in the wide band above the buttons, the chat beside them", () => {
    const boxes = phoneBoxes("both", true);
    inside(px(boxes.context));
    inside(px(boxes.chat));
    expect(px(boxes.context).bottom).toBeLessThan(px(boxes.chat).top);
  });

  test("one app: clear of every button, top to bottom", () => {
    inside(px(phoneBoxes("context", true).context));
    inside(px(phoneBoxes("chat", true).chat));
  });

  test("off the stage it is only a margin", () => {
    expect(phoneBoxes("both", false).context.top).toBe("2%");
  });
});

describe("switching like an iPhone", () => {
  const at = (style: object) => (style as { transform: string }).transform;
  test("at rest the other app waits off its side", () => {
    expect(at(paneMotion("context", "context", { phase: "rest" }, 400))).toBe("translateX(0px) scale(1)");
    expect(at(paneMotion("chat", "context", { phase: "rest" }, 400))).toBe("translateX(400px) scale(1)");
    expect(at(paneMotion("context", "chat", { phase: "rest" }, 400))).toBe("translateX(-400px) scale(1)");
    expect(at(paneMotion("chat", "both", { phase: "rest" }, 400))).toBe("translateX(0px) scale(1)");
  });

  test("shrink to cards, slide across, grow", () => {
    const move = { from: "context", to: "chat" } as const;
    expect(at(paneMotion("context", "chat", { phase: "lift", ...move }, 400))).toMatch(/translateX\(0px\) scale\(0\.72\)/);
    expect(at(paneMotion("chat", "chat", { phase: "lift", ...move }, 400))).toMatch(/translateX\(\d+px\) scale\(0\.72\)/);
    expect(at(paneMotion("chat", "chat", { phase: "slide", ...move }, 400))).toMatch(/translateX\(0px\) scale\(0\.72\)/);
    expect(at(paneMotion("context", "chat", { phase: "slide", ...move }, 400))).toMatch(/translateX\(-\d+px\)/);
    expect(at(paneMotion("chat", "chat", { phase: "land", ...move }, 400))).toBe("translateX(0px) scale(1)");
  });
});
