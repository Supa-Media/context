/**
 * The Lab's Conversations view against the artifact's `renderConvo` (Dev2, 2026-11-13: "EXACTLY like the artifact").
 * The "In the prompt" column: yes and no as written, and the names-only rule for tool entries follows the setting.
 */
import { expect, test } from "@jest/globals";
import { CV_KINDS } from "../features/tex/lab/data/convo";
import { inPrompt } from "../features/tex/lab/views/convoRows";

test("a tool entry is named only when tool calls are slim, and whole when they are not", () => {
  expect(inPrompt("tool", "names only", true)).toBe("names only");
  expect(inPrompt("tool", "names only", false)).toBe("whole");
});

test("yes and no entries read the same whatever the setting", () => {
  for (const slim of [true, false]) {
    expect(inPrompt("text", "yes", slim)).toBe("yes");
    expect(inPrompt("thinking", "no", slim)).toBe("no");
  }
});

test("every ledger row resolves to a value the table can show", () => {
  const cells = CV_KINDS.map(([k, , , sh]) => inPrompt(k, sh, true));
  expect(cells).toHaveLength(CV_KINDS.length);
  expect(cells.filter((c) => c === "whole")).toEqual([]);
});
