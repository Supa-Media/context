import { describe, expect, test } from "@jest/globals";
import { changedBy, movedStarts, scriptChange, scriptLines } from "../features/studio/scriptChanges";
import { outsideChangeLine } from "../features/studio/StudioScriptRail";
import { asOtherKind } from "../features/studio/StudioCastStrip";
import type { PresenceMember } from "../features/console/presence/protocol";

/*
  What the studio says when the script changes while it is open (Dev2,
  2026-09-30: "show any updates from connected agents to the script").
*/

const member = (name: string, isAgent: boolean): PresenceMember => ({
  id: name,
  name,
  color: null,
  anchor: null,
  head: null,
  canWrite: true,
  isAgent,
});

describe("what changed", () => {
  const before = scriptLines("---\ntitle: x\n---\n```cast\n@maya joins\n@maya types: hi\nwait 1s\n@jon leaves\n```");

  test("a rewritten step, a new one and a gone one", () => {
    const after = scriptLines("```cast\n@maya joins\n@maya types: hello\nwait 1s\n@ana joins\n```");
    // Two went and two came: both count as changed, none as taken out.
    expect(scriptChange(before, after)).toEqual({ changed: [1, 3], removed: 0 });
    const shorter = scriptLines("```cast\n@maya joins\n@maya types: hello\n```");
    expect(scriptChange(before, shorter)).toEqual({ changed: [1], removed: 2 });
  });

  test("steps that only moved are not changes, and repeated steps count one each", () => {
    expect(scriptChange(before, [before[2]!, before[0]!, before[1]!, before[3]!])).toEqual({ changed: [], removed: 0 });
    expect(scriptChange(["a"], ["a", "a"])).toEqual({ changed: [1], removed: 0 });
  });

  test("the words the rail shows", () => {
    expect(outsideChangeLine({ by: "Claude", changed: [2], removed: 0 })).toBe("Claude changed 1 step just now.");
    expect(outsideChangeLine({ by: "Claude and Codex", changed: [1, 2], removed: 1 })).toBe(
      "Claude and Codex changed 2 steps and took out 1 step just now.",
    );
    expect(outsideChangeLine({ by: null, changed: [], removed: 2 })).toBe("Someone took out 2 steps just now.");
  });
});

describe("who changed it", () => {
  test("the agents in the note, since a tool is only there while it writes", () => {
    expect(changedBy([member("@maya", false), member("@maya's Codex", true)])).toBe("@maya's Codex");
    expect(changedBy([member("Claude", true), member("Codex", true)])).toBe("Claude and Codex");
    expect(changedBy([member("a", true), member("b", true), member("c", true)])).toBe("a and 2 others");
  });

  test("otherwise the people in it, and nobody when the room shows nobody", () => {
    expect(changedBy([member("@jon", false)])).toBe("@jon");
    expect(changedBy([])).toBeNull();
  });
});

describe("starts that moved", () => {
  test("a step whose start changed, matched by what it says", () => {
    const before = [
      { line: "a", at: 0 },
      { line: "b", at: 1000 },
      { line: "c", at: 2000 },
    ];
    const after = [
      { line: "a", at: 0 },
      { line: "new", at: 1000 },
      { line: "b", at: 2500 },
      { line: "c", at: 3500 },
    ];
    expect(movedStarts(before, after)).toEqual([2, 3]);
  });
});

describe("person or agent", () => {
  test("flips the way the grammar reads names", () => {
    expect(asOtherKind({ name: "@maya", kind: "person" })).toBe("Maya");
    expect(asOtherKind({ name: "@jon's Claude", kind: "agent" })).toBe("@jon");
    expect(asOtherKind({ name: "Claude", kind: "agent" })).toBe("@claude");
  });
});
