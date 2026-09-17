import { describe, expect, test } from "@jest/globals";
import { CONTINUITY_STEPS, TEAM_THOUGHT } from "../features/landing/ContinuityDemo";
import {
  PROOF_BODY,
  PROOF_EYEBROW,
  PROOF_FOOT,
  PROOF_TITLE,
} from "../features/landing/copy";

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
    expect(CONTINUITY_STEPS[0].receipt).toMatch(/published to the team workspace/i);
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
    expect(teammate.receipt).toMatch(/yours hidden/i);
  });

  /**
   * Addressed to the copy constants rather than to `Landing.tsx`'s source.
   *
   * This read the component's text and matched literals in it, which was the
   * only way to ask the question before the page's words had names. They have
   * names now, and grepping a component for a sentence breaks the moment that
   * sentence is lifted into a constant — which is exactly what happened, and
   * is why this assertion is here in the same commit as that lift. The claim
   * is unchanged: the proof section still has to say what the product is
   * rather than implying magic.
   */
  test("the handoff is followed by an honest plain-markdown explanation", () => {
    expect(PROOF_EYEBROW).toMatch(/No magic layer/);
    expect(PROOF_TITLE).toMatch(/Just Markdown\. Yours to touch\./);
    expect(PROOF_FOOT).toMatch(/open in Obsidian/i);
    expect(PROOF_BODY).toMatch(/write,\s*rename, move, and shape it all by hand/);
  });
});
