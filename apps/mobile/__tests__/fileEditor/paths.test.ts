/**
 * Path arithmetic, name validation, move refusal and duplicate naming — the
 * pure path rules the console leans on before it ever talks to the bucket.
 *
 * Split out of `fileEditor.test.ts`; see `fixtures.ts` in this folder for
 * why this suite exists as pure modules in the first place.
 */

import { describe, expect, test } from "@jest/globals";
import {
  ancestorsOf,
  baseName,
  describeMoveProblem,
  describeNameProblem,
  duplicateName,
  ensureMarkdown,
  formatBytes,
  joinPath,
  moveTargetFor,
  parentPath,
  restoreTargetFor,
} from "../../features/console/files/paths";

describe("path arithmetic", () => {
  test("parent and base, including at the root", () => {
    expect(parentPath("1-projects/foo.md")).toBe("1-projects");
    expect(parentPath("index.md")).toBe("");
    expect(baseName("1-projects/foo.md")).toBe("foo.md");
    expect(baseName("index.md")).toBe("index.md");
    expect(joinPath("", "index.md")).toBe("index.md");
    expect(joinPath("1-projects", "foo.md")).toBe("1-projects/foo.md");
  });

  test("ancestors, root first, so the tree can expand to a selection", () => {
    expect(ancestorsOf("1-projects/plans/q3.md")).toEqual(["1-projects", "1-projects/plans"]);
    expect(ancestorsOf("index.md")).toEqual([]);
  });

  test("a new note becomes markdown whether or not you typed the extension", () => {
    expect(ensureMarkdown("plan")).toBe("plan.md");
    expect(ensureMarkdown("plan.md")).toBe("plan.md");
    expect(ensureMarkdown("  plan  ")).toBe("plan.md");
    expect(ensureMarkdown("plan.MD")).toBe("plan.MD");
  });

  test("bytes read as a glance, not an audit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(2_500_000)).toBe("2.4 MB");
    expect(formatBytes(undefined)).toBe("");
  });

  test("an archived path knows where it came from", () => {
    expect(restoreTargetFor("4-archive/2026-08-26T09-14-02-113Z/1-projects/foo.md")).toBe(
      "1-projects/foo.md",
    );
    expect(restoreTargetFor("1-projects/foo.md")).toBeNull();
  });
});

describe("names the bucket would refuse", () => {
  test("an empty name", () => {
    expect(describeNameProblem("   ")).toMatch(/Give it a name/);
  });

  test("a slash, with the alternative offered", () => {
    expect(describeNameProblem("a/b.md")).toMatch(/Use Move/);
  });

  /** `.history/` and `.audit/` are real folders they can see from Obsidian. */
  test("a leading dot, explained rather than just refused", () => {
    expect(describeNameProblem(".secret.md")).toMatch(/history and audit/);
  });

  test("privacy.md, because it is generated", () => {
    expect(describeNameProblem("privacy.md")).toMatch(/generated from your visibility settings/);
  });

  test("a control character", () => {
    expect(describeNameProblem("a\u0000b.md")).toMatch(/cannot store/);
    expect(describeNameProblem("a\\b.md")).toMatch(/cannot store/);
  });

  test("an ordinary name is fine", () => {
    expect(describeNameProblem("Q3 plan.md")).toBeNull();
  });
});

describe("moves that cannot work are refused before the round trip", () => {
  test("into itself", () => {
    expect(describeMoveProblem("1-projects", "1-projects/plans", new Set())).toMatch(
      /inside itself/,
    );
    expect(describeMoveProblem("1-projects", "1-projects", new Set())).toMatch(
      /folder you are moving/,
    );
  });

  test("to where it already is", () => {
    expect(describeMoveProblem("1-projects/a.md", "1-projects", new Set())).toMatch(
      /already there/,
    );
  });

  test("onto an existing name — a move never overwrites", () => {
    expect(describeMoveProblem("1-projects/a.md", "2-areas", new Set(["a.md"]))).toMatch(
      /already has something called a\.md/,
    );
  });

  test("a legal move says nothing and lands where you would expect", () => {
    expect(describeMoveProblem("1-projects/a.md", "2-areas", new Set(["b.md"]))).toBeNull();
    expect(moveTargetFor("1-projects/a.md", "2-areas")).toBe("2-areas/a.md");
    expect(moveTargetFor("1-projects/a.md", "")).toBe("a.md");
  });
});

describe("duplicate naming matches the server's", () => {
  test("Obsidian's convention", () => {
    expect(duplicateName("foo.md", new Set())).toBe("foo copy.md");
    expect(duplicateName("foo.md", new Set(["foo copy.md"]))).toBe("foo copy 2.md");
  });

  test("a folder keeps its whole name", () => {
    expect(duplicateName("plans", new Set())).toBe("plans copy");
  });
});
