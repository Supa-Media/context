import { describe, expect, test } from "@jest/globals";
import { castStepLine, splitWebsiteCast } from "@context/shared";
import { NO_COMMENTS, commentsAfter, pressedKey } from "../features/home/cast/castComments";
import type { CastSaid } from "../features/home/cast/castRun";

/*
  A comment on a phone (Dev2, 2026-10-01): "you can hear the typing sounds
  but you cant see it, since its mobile we should probably have the keyboard
  come up and simulated", "make sure the cast script can dictate if they want
  the keyboard shown", and "at least see one other previous comment in a
  ghost state".
*/

const block = (lines: string) => `# Home\n\n\`\`\`cast\n${lines}\n\`\`\`\n`;
const parse = (lines: string) => splitWebsiteCast(block(lines));

describe("keyboard: in the script", () => {
  test("on or off, from that line on, done by nobody", () => {
    const { steps, problems } = parse("keyboard: off\nphone keyboard: on\nkeyboard: hidden\nkeyboard: shown\nkeyboard: sometimes");
    expect(steps).toEqual([
      { kind: "keyboard", on: false },
      { kind: "keyboard", on: true },
      { kind: "keyboard", on: false },
      { kind: "keyboard", on: true },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Try on or off/);
  });

  test("written back the way it reads", () => {
    for (const line of ["keyboard: on", "keyboard: off"]) {
      const step = parse(line).steps[0]!;
      expect(castStepLine(step)).toBe(line);
      expect(parse(castStepLine(step)).steps[0]).toEqual(step);
    }
  });
});

const said = (over: Partial<CastSaid>): CastSaid => ({ who: "@maya", quote: "launch email", text: "", resolved: false, ...over });

describe("the comments a phone shows", () => {
  test("the first comment has nothing behind it", () => {
    const typing = commentsAfter(NO_COMMENTS, said({ text: "Cl", draft: true }));
    expect(typing.current?.text).toBe("Cl");
    expect(typing.ghost).toBeNull();
  });

  test("the comment before stays as a ghost while the next is typed, and after", () => {
    let shown = commentsAfter(NO_COMMENTS, said({ text: "Claude, draft this", draft: true }));
    shown = commentsAfter(shown, said({ text: "Claude, draft this" }));
    expect(shown.ghost).toBeNull();
    shown = commentsAfter(shown, said({ who: "@jon", text: "", draft: true }));
    expect(shown.ghost?.text).toBe("Claude, draft this");
    shown = commentsAfter(shown, said({ who: "@jon", text: "On it", draft: true }));
    shown = commentsAfter(shown, said({ who: "@jon", text: "On it" }));
    expect(shown.current?.text).toBe("On it");
    expect(shown.ghost?.text).toBe("Claude, draft this");
  });

  test("a comment that lands whole (an agent's) pushes the last one back too", () => {
    let shown = commentsAfter(NO_COMMENTS, said({ text: "first" }));
    shown = commentsAfter(shown, said({ who: "Claude", text: "second" }));
    expect(shown.ghost?.text).toBe("first");
    expect(shown.current?.text).toBe("second");
  });
});

describe("pressedKey", () => {
  test("the key the last letter was typed on", () => {
    expect(pressedKey("Claude, dra")).toBe("a");
    expect(pressedKey("Hi T")).toBe("t");
    expect(pressedKey("Hi ")).toBe("space");
    expect(pressedKey("ok?")).toBeNull();
    expect(pressedKey("")).toBeNull();
  });
});
