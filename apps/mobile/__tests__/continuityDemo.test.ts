import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTINUITY_STEPS, TEAM_THOUGHT } from "../features/landing/ContinuityDemo";

describe("the landing-page continuity story", () => {
  test("moves one team-safe thought through three distinct AI relationships", () => {
    expect(CONTINUITY_STEPS.map((step) => step.product)).toEqual([
      "ChatGPT",
      "Claude Code",
      "Coworker’s Notion AI",
    ]);
    expect(CONTINUITY_STEPS.map((step) => step.access)).toEqual([
      "Private access",
      "Private access",
      "Team access",
    ]);
  });

  test("the first AI receives explicit permission before publishing to the team", () => {
    expect(CONTINUITY_STEPS[0].prompt).toMatch(/share that with the Context team/i);
    expect(CONTINUITY_STEPS[0].receipt).toMatch(/published to team context/i);
  });

  test("later AIs name the carried thought instead of implying magic", () => {
    expect(TEAM_THOUGHT).toBe("Show continuity, not storage.");
    expect(CONTINUITY_STEPS[1].reply).toContain(TEAM_THOUGHT);
    expect(CONTINUITY_STEPS[2].reply).toMatch(/cross-AI continuity/i);
  });

  test("team access demonstrates the privacy boundary as well as the handoff", () => {
    const teammate = CONTINUITY_STEPS[2];
    expect(teammate.access).toBe("Team access");
    expect(teammate.reply).toMatch(/private notes were never available/i);
    expect(teammate.receipt).toMatch(/private context hidden/i);
  });

  test("the handoff is followed by an honest plain-markdown explanation", () => {
    const landing = readFileSync(join(__dirname, "../features/landing/Landing.tsx"), "utf8");
    expect(landing).toMatch(/No magic layer/);
    expect(landing).toMatch(/Just Markdown\. Yours to touch\./);
    expect(landing).toMatch(/open in Obsidian/i);
    expect(landing).toMatch(/write,\s*rename, move, and shape the workspace by hand/);
  });
});
