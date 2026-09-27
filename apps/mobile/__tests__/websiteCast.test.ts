import { describe, expect, test } from "@jest/globals";
import { MAX_CAST_STEPS, splitWebsiteCast, stripWebsiteCast } from "@context/shared";

const PAGE = [
  "# wth is this",
  "",
  "it's kind of like obsidian and notion had a baby",
  "",
  "```cast",
  "@maya adds to the line above: (the baby can read.)",
  "Claude writes: new here? [[getting-started]] is the tour.",
  "wait 2s",
  "Claude reads: pricing",
  "ChatGPT reads",
  "```",
  "",
  "[create a workspace](/workspace/new)",
  "",
].join("\n");

describe("splitWebsiteCast", () => {
  test("takes the block out and leaves one blank line where it was", () => {
    const { markdown, problems } = splitWebsiteCast(PAGE);
    expect(markdown).toBe(
      "# wth is this\n\nit's kind of like obsidian and notion had a baby\n\n[create a workspace](/workspace/new)\n",
    );
    expect(problems).toEqual([]);
  });

  test("anchors a new line where the block was, and an append at the end of the paragraph above", () => {
    const { markdown, steps } = splitWebsiteCast(PAGE);
    const [append, line] = steps;
    expect(append).toMatchObject({ kind: "append", actor: { name: "@maya", kind: "person" } });
    expect(line).toMatchObject({ kind: "line", actor: { name: "Claude", kind: "agent" } });
    if (append?.kind !== "append" || line?.kind !== "line") throw new Error("unreachable");
    expect(markdown.slice(0, append.at).endsWith("had a baby")).toBe(true);
    expect(markdown.slice(line.at).startsWith("[create a workspace]")).toBe(true);
  });

  test("reads, waits and an agent's name with a space", () => {
    const { steps } = splitWebsiteCast("```cast\nwait 1500ms\nGitHub Copilot reads: devlog\nClaude reads\n```\n");
    expect(steps).toEqual([
      { kind: "wait", ms: 1500 },
      { kind: "read", actor: { name: "GitHub Copilot", kind: "agent" }, page: "devlog" },
      { kind: "read", actor: { name: "Claude", kind: "agent" }, page: null },
    ]);
  });

  test("a new note takes the indented lines under it as its text", () => {
    const { steps } = splitWebsiteCast(
      "```cast\nClaude adds note: getting-started\n  # Getting started\n\n  The tour.\n@maya types: hi\n```\n",
    );
    expect(steps[0]).toEqual({
      kind: "note",
      actor: { name: "Claude", kind: "agent" },
      name: "getting-started",
      text: "# Getting started\n\nThe tour.",
    });
    expect(steps[1]).toMatchObject({ kind: "line", text: "hi" });
  });

  test("deleting the line an append was written against moves it to whatever is above now", () => {
    const edited = PAGE.replace("it's kind of like obsidian and notion had a baby\n\n", "");
    const { markdown, steps } = splitWebsiteCast(edited);
    const append = steps[0];
    if (append?.kind !== "append") throw new Error("expected an append");
    expect(markdown.slice(0, append.at).endsWith("# wth is this")).toBe(true);
  });

  test("an append with nothing above becomes a line of its own", () => {
    const { steps } = splitWebsiteCast("```cast\n@maya adds to the line above: hello\n```\nbody\n");
    expect(steps[0]).toMatchObject({ kind: "line", text: "hello", at: 0 });
  });

  test("lines it does not understand are reported and skipped, never shown", () => {
    const { markdown, steps, problems } = splitWebsiteCast("a\n\n```cast\nmaya dances\n@jon types: ok\n```\n");
    expect(markdown).toBe("a\n");
    expect(steps).toHaveLength(1);
    expect(problems).toEqual(["Not understood: maya dances"]);
  });

  test("an unclosed block is left as it is", () => {
    const source = "a\n\n```cast\n@maya types: hi\n";
    const { markdown, steps, problems } = splitWebsiteCast(source);
    expect(markdown).toBe(source);
    expect(steps).toEqual([]);
    expect(problems).toHaveLength(1);
  });

  test("a cast fence inside another code block is only code", () => {
    const source = "````md\n```cast\n@maya types: hi\n```\n````\n";
    expect(splitWebsiteCast(source)).toEqual({ markdown: source, steps: [], problems: [] });
    const tilde = "~~~\n```cast\n@maya types: hi\n```\n~~~\n";
    expect(stripWebsiteCast(tilde)).toBe(tilde);
  });

  test("the number of steps is bounded", () => {
    const many = Array.from({ length: MAX_CAST_STEPS + 5 }, () => "Claude reads").join("\n");
    const { steps, problems } = splitWebsiteCast("```cast\n" + many + "\n```\n");
    expect(steps).toHaveLength(MAX_CAST_STEPS);
    expect(problems).toHaveLength(1);
  });

  test("a page with no block is unchanged", () => {
    const source = "# Pricing\n\n```ts\nconst x = 1;\n```\n";
    expect(stripWebsiteCast(source)).toBe(source);
  });

  test("somebody's agent is an agent, with or without a curly apostrophe", () => {
    const { steps } = splitWebsiteCast("```cast\n@jon's Claude reads\n@maya\u2019s Codex writes: it\u2019s done\n@maya types: hi\n```\n");
    expect(steps).toEqual([
      { kind: "read", actor: { name: "@jon's Claude", kind: "agent" }, page: null },
      { kind: "line", actor: { name: "@maya's Codex", kind: "agent" }, text: "it\u2019s done", at: 0 },
      { kind: "line", actor: { name: "@maya", kind: "person" }, text: "hi", at: 0 },
    ]);
  });
});
