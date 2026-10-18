/**
 * The `access.md` a "Download as folders" archive carries in rows mode
 * (`lib/nodes/exportAccess.ts`). Plain Markdown, one line per row that carries
 * its own setting, generated from the rows rather than read from `privacy.md`.
 *
 * Sabotage: make `renderAccessMarkdown` print grantee names to a member
 * (`names: false`) and the "member sees no names" case fails.
 */

import { describe, expect, test } from "vitest";
import { renderAccessMarkdown } from "../../functions/lib/nodes/exportAccess";

describe("access.md", () => {
  test("one line per row, folders with a trailing slash, the setting after an em dash", () => {
    const text = renderAccessMarkdown(
      [
        { path: "notes/x.md", kind: "file", base: "team", grants: [] },
        { path: "1-projects/foo", kind: "folder", base: "private", grants: [] },
      ],
      { names: true },
    );
    expect(text).toContain("- 1-projects/foo/ — private\n");
    expect(text).toContain("- notes/x.md — team\n");
  });

  test("rows are sorted by path, whatever order they arrive in", () => {
    const text = renderAccessMarkdown(
      [
        { path: "b.md", kind: "file", base: "team", grants: [] },
        { path: "a.md", kind: "file", base: "private", grants: [] },
      ],
      { names: true },
    );
    expect(text.indexOf("- a.md")).toBeLessThan(text.indexOf("- b.md"));
  });

  test("a row with grants names each one with its role, after the base", () => {
    const text = renderAccessMarkdown(
      [
        {
          path: "a/b.md",
          kind: "file",
          base: "private",
          grants: ["@handle (view)", "group Design (edit)"],
        },
      ],
      { names: true },
    );
    expect(text).toContain("- a/b.md — private, plus @handle (view), group Design (edit)\n");
  });

  test("a member is not shown who was granted, only how many: the list is the owner's to read", () => {
    const text = renderAccessMarkdown(
      [{ path: "a/b.md", kind: "file", base: "private", grants: ["@handle (view)", "group Design (edit)"] }],
      { names: false },
    );
    expect(text).toContain("- a/b.md — private, plus 2 named people or groups\n");
    expect(text).not.toContain("handle");
    expect(text).not.toContain("Design");
  });

  test("a row with no base but a list is private, the way the engine reads it", () => {
    const text = renderAccessMarkdown([{ path: "a.md", kind: "file", grants: ["@kola (view)"] }], { names: true });
    expect(text).toContain("- a.md — private, plus @kola (view)\n");
  });

  test("the file is a titled Markdown page, and it never names privacy.md", () => {
    const text = renderAccessMarkdown([{ path: "a.md", kind: "file", base: "team", grants: [] }], { names: true });
    expect(text.startsWith("# Access\n")).toBe(true);
    expect(text).not.toContain("privacy.md");
  });
});
