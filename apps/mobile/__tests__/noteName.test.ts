import { describe, expect, test } from "@jest/globals";
import { noteNameOf, renamedFileName, shownNoteName } from "../features/console/files/noteName";

/**
 * What the note's name field shows, and what typing in it renames the file to.
 * The field edits the name a person reads; the file keeps what is filing.
 */
describe("the name a note's header field shows", () => {
  test.each([
    ["1-projects/plan.md", "plan"],
    ["untitled-2026-10-13.md", "untitled-2026-10-13"],
    ["2-areas/01-intro.md", "intro"],
    ["3-resources/flow.excalidraw.md", "flow"],
    ["notes/01-.md", "01-"],
  ])("%s reads as %s", (path, text) => {
    expect(noteNameOf(path).text).toBe(text);
  });
});

describe("what a typed name renames the file to", () => {
  test("a new name keeps the note a note", () => {
    expect(renamedFileName("2-areas/untitled-2026-10-13.md", "Thinking about community")).toBe(
      "Thinking about community.md",
    );
  });

  test("a drawing stays a drawing", () => {
    expect(renamedFileName("3-resources/flow.excalidraw.md", "Signup flow")).toBe("Signup flow.excalidraw.md");
  });

  test("the sort number stays unless the new name brings its own", () => {
    expect(renamedFileName("2-areas/01-intro.md", "Welcome")).toBe("01-Welcome.md");
    expect(renamedFileName("2-areas/01-intro.md", "02-Welcome")).toBe("02-Welcome.md");
  });

  test("typing the extension back is typing the name", () => {
    expect(renamedFileName("1-projects/plan.md", "roadmap.md")).toBe("roadmap.md");
    expect(renamedFileName("1-projects/plan.md", "plan.md")).toBeNull();
  });

  test("an unchanged or emptied name does nothing", () => {
    expect(renamedFileName("1-projects/plan.md", "plan")).toBeNull();
    expect(renamedFileName("1-projects/plan.md", "  plan  ")).toBeNull();
    expect(renamedFileName("1-projects/plan.md", "   ")).toBeNull();
    expect(renamedFileName("1-projects/plan.md", ".md")).toBeNull();
  });

  test("a change of case alone is a rename", () => {
    expect(renamedFileName("1-projects/plan.md", "Plan")).toBe("Plan.md");
  });
});

describe("the name drawn while a rename is on its way", () => {
  test("follows the rename asked for, and falls back when it is refused", () => {
    const path = "1-projects/plan.md";
    expect(shownNoteName(path, null)).toBe("plan");
    expect(shownNoteName(path, { from: path, to: "1-projects/roadmap.md" })).toBe("roadmap");
    // A refusal says the rename again the other way round.
    expect(shownNoteName(path, { from: "1-projects/roadmap.md", to: path })).toBe("plan");
  });
});
