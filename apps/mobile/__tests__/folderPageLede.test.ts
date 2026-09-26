/** A project's lede: the first paragraph of prose in its front note, as plain words. */

import { describe, expect, test } from "@jest/globals";
import { noteLede } from "../features/console/files/folderPage/lede";

describe("a note's lede", () => {
  test("is the first paragraph after the frontmatter and the title", () => {
    const text = "---\nstatus: active\n---\n# Custom domains\n\nLet a workspace publish\non a domain it owns.\n\nSecond paragraph.\n";
    expect(noteLede(text)).toBe("Let a workspace publish on a domain it owns.");
  });

  test("passes over fences, lists and quotes to reach prose", () => {
    const text = "# P\n\n```list\nfrom: p\n```\n\n- a\n- b\n\n> quoted\n\nThe real sentence.";
    expect(noteLede(text)).toBe("The real sentence.");
  });

  test("keeps the words of links and emphasis and drops the marks", () => {
    expect(noteLede("See [the plan](https://example.invalid) and [[notes|our notes]], **now** `today`.")).toBe(
      "See the plan and our notes, now today.",
    );
  });

  test("is null for a note with no prose", () => {
    expect(noteLede("---\nstatus: active\n---\n")).toBeNull();
    expect(noteLede("# Only a title\n")).toBeNull();
    expect(noteLede("")).toBeNull();
  });

  test("is capped", () => {
    const lede = noteLede("word ".repeat(200))!;
    expect(lede.length).toBeLessThanOrEqual(320);
    expect(lede.endsWith("…")).toBe(true);
  });
});
