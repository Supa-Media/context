import { describe, expect, test } from "@jest/globals";
import {
  castActorNamed,
  castActors,
  castStepLine,
  castStepSources,
  castStepWords,
  insertCastStep,
  moveCastStep,
  renameCastActor,
  replaceCastStep,
  splitWebsiteCast,
  withCastKind,
  withCastWords,
  type CastStep,
} from "@context/shared";

/*
  Editing the script from the studio (Dev2, 2026-09-30): each change rewrites
  the lines of one step and leaves every other line of the page as written.
*/

const PAGE = [
  "---",
  "title: Pricing",
  "---",
  "# Pricing",
  "",
  "Free is free.",
  "",
  "```cast",
  "pace: slow",
  "@maya goes to Pricing",
  "// a note to self",
  "Claude adds note: tour",
  "  # Tour",
  "",
  "  The 90-second tour.",
  "",
  "wait 1.5s",
  "@maya's Codex comments on \"Free is free\": you cheapo?",
  "@jon replies: eh, I don't really care :annoyed:",
  "```",
  "",
  "Tail.",
].join("\n");

const steps = (source: string) => splitWebsiteCast(source).steps;

describe("where each step was written", () => {
  test("one span per step, a note's body included, comments and pace lines not", () => {
    const lines = PAGE.split("\n");
    const spans = castStepSources(PAGE);
    expect(spans).toHaveLength(steps(PAGE).length);
    expect(spans.map((span) => lines.slice(span.from, span.to).join("\n"))).toEqual([
      "@maya goes to Pricing",
      "Claude adds note: tour\n  # Tour\n\n  The 90-second tour.\n",
      "wait 1.5s",
      "@maya's Codex comments on \"Free is free\": you cheapo?",
      "@jon replies: eh, I don't really care :annoyed:",
    ]);
  });

  test("steps across two blocks, and a fenced code block that only looks like one", () => {
    const two = "```cast\n@a joins\n```\n\n```\n@b joins\n```\n\n```cast\n@c leaves\n```";
    const lines = two.split("\n");
    expect(castStepSources(two).map((span) => lines[span.from])).toEqual(["@a joins", "@c leaves"]);
  });
});

describe("a step, written back", () => {
  const every: CastStep[] = [
    { kind: "line", actor: { name: "@maya", kind: "person" }, text: "hi there", at: 0 },
    { kind: "line", actor: { name: "Claude", kind: "agent" }, text: "hello", at: 0 },
    { kind: "append", actor: { name: "@maya", kind: "person" }, text: "(more)", at: 0 },
    { kind: "append", actor: { name: "@maya", kind: "person" }, text: "- item", at: 0, below: true },
    { kind: "read", actor: { name: "Claude", kind: "agent" }, page: null },
    { kind: "read", actor: { name: "Claude", kind: "agent" }, page: "pricing" },
    { kind: "note", actor: { name: "Claude", kind: "agent" }, name: "tour", text: "# Tour\n\nHi." },
    { kind: "comment", actor: { name: "@jon's Claude", kind: "agent" }, quote: "say \"free\"", text: "why?" },
    { kind: "comment", actor: { name: "Codex", kind: "agent" }, quote: "Free is free", text: "why?" },
    { kind: "reply", actor: { name: "@jon", kind: "person" }, text: "because" },
    { kind: "resolve", actor: { name: "@jon", kind: "person" } },
    { kind: "join", actor: { name: "@ana", kind: "person" } },
    { kind: "leave", actor: { name: "@ana", kind: "person" } },
    { kind: "click", actor: { name: "@ana", kind: "person" }, target: "@maya" },
    { kind: "tick", actor: { name: "@ana", kind: "person" }, quote: "send it" },
    { kind: "open", actor: { name: "@maya", kind: "person" }, page: "about us" },
    { kind: "wait", ms: 1500 },
  ];

  test("reads back as the same step, for every kind", () => {
    const block = "above\n\n```cast\n" + every.map(castStepLine).join("\n") + "\n```\n";
    const { steps: back, problems } = splitWebsiteCast(block);
    expect(problems).toEqual([]);
    const strip = (step: CastStep) => ("at" in step ? { ...step, at: 0 } : step);
    expect(back.map(strip)).toEqual(every);
  });

  test("words typed with line breaks stay on the step's one line", () => {
    const step = withCastWords(every[0]!, "two\nlines")!;
    expect(castStepLine(step)).toBe("@maya types: two lines");
  });
});

describe("changing the page", () => {
  test("new words for one step change its line and nothing else", () => {
    const reply = steps(PAGE)[4]!;
    const changed = replaceCastStep(PAGE, 4, withCastWords(reply, "fine, keep it")!);
    expect(changed).toBe(PAGE.replace("eh, I don't really care :annoyed:", "fine, keep it"));
  });

  test("a step taken out takes its lines with it, a note's body too", () => {
    const changed = replaceCastStep(PAGE, 1, null);
    expect(changed).not.toContain("adds note");
    expect(changed).not.toContain("90-second");
    expect(steps(changed).map((step) => step.kind)).toEqual(["open", "wait", "comment", "reply"]);
    expect(changed).toContain("// a note to self");
  });

  test("a step added goes where it is asked for, and after the last one at the end", () => {
    const join: CastStep = { kind: "join", actor: { name: "@ana", kind: "person" } };
    expect(steps(insertCastStep(PAGE, 0, join)).map((step) => step.kind)[0]).toBe("join");
    const last = insertCastStep(PAGE, 99, join);
    expect(steps(last).map((step) => step.kind)).toEqual(["open", "note", "wait", "comment", "reply", "join"]);
    expect(last).toContain(":annoyed:\n@ana joins\n```");
    // A step after a note is not read as part of its body.
    const afterNote = insertCastStep(PAGE, 2, join);
    expect(steps(afterNote).map((step) => step.kind)).toEqual(["open", "note", "join", "wait", "comment", "reply"]);
    expect(steps(afterNote)[1]).toMatchObject({ text: "# Tour\n\nThe 90-second tour." });
  });

  test("the first step of an empty block, and nothing at all without a block", () => {
    const join: CastStep = { kind: "join", actor: { name: "@ana", kind: "person" } };
    expect(steps(insertCastStep("x\n\n```cast\n```\n", 0, join))).toHaveLength(1);
    expect(insertCastStep("no cast here", 0, join)).toBe("no cast here");
  });

  test("steps move up and down, keeping their own lines", () => {
    const up = moveCastStep(PAGE, 3, 0);
    expect(steps(up).map((step) => step.kind)).toEqual(["comment", "open", "note", "wait", "reply"]);
    const down = moveCastStep(PAGE, 0, 4);
    expect(steps(down).map((step) => step.kind)).toEqual(["note", "wait", "comment", "reply", "open"]);
    expect(steps(down)[0]).toMatchObject({ text: "# Tour\n\nThe 90-second tour." });
    expect(moveCastStep(PAGE, 0, 9)).toBe(PAGE);
  });

  test("a rename reaches every step that names them, and only those", () => {
    const source = "```cast\n@maya joins\n@ana clicks @maya\n@maya types: hi\n@mayan joins\n```";
    const renamed = renameCastActor(source, "@maya", castActorNamed("@priya")!);
    expect(renamed).toBe("```cast\n@priya joins\n@ana clicks @priya\n@priya types: hi\n@mayan joins\n```");
    expect(castActors(renamed).map((actor) => actor.name)).toEqual(["@priya", "@ana", "@mayan"]);
    // A person made an agent writes rather than types.
    expect(renameCastActor(source, "@maya", castActorNamed("Claude")!)).toContain("Claude writes: hi");
  });

  test("names the grammar cannot read are refused", () => {
    expect(castActorNamed("@jon's Claude")).toEqual({ name: "@jon's Claude", kind: "agent" });
    expect(castActorNamed("")).toBeNull();
    expect(castActorNamed("two words: here")).toBeNull();
    expect(castActorNamed("@maya\n@jon types: x")).toBeNull();
  });

  test("words that would not make a step are refused", () => {
    const [open, , wait] = steps(PAGE);
    expect(withCastWords(open!, "  ")).toBeNull();
    expect(withCastWords(wait!, "soon")).toBeNull();
    expect(withCastWords(wait!, "2.5")).toEqual({ kind: "wait", ms: 2500 });
    expect(castStepWords(wait!)).toBe("1.5");
  });

  test("a step changes kind, keeping who does it and what they say", () => {
    const reply = steps(PAGE)[4]!;
    const maya = { name: "@maya", kind: "person" as const };
    expect(withCastKind(reply, "line", maya)).toMatchObject({ kind: "line", actor: { name: "@jon" }, text: "eh, I don't really care :annoyed:" });
    expect(withCastKind(steps(PAGE)[2]!, "join", maya)).toEqual({ kind: "join", actor: maya });
    expect(withCastKind(reply, "wait", maya)).toEqual({ kind: "wait", ms: 1000 });
  });
});
