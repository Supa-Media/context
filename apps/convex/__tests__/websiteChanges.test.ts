import { describe, expect, test } from "vitest";
import type {
  FileOperation,
  OperationResult,
} from "../functions/lib/filesFns/operationTypes";
import {
  operationMayRestrictWebsite,
  operationTouchesWebsite,
  websiteNarrowingPaths,
} from "../functions/lib/websites/changes";
import { MOVING_SCAN_MESSAGE, assertScanSawMoves } from "../functions/lib/websites/movingScan";

const written: OperationResult = {
  kind: "written",
  path: "irrelevant.md",
  etag: "etag",
  bytes: 1,
  conflictCheck: "conditional",
  forms: { created: [], occupied: [] },
};

function touches(operation: FileOperation, result = written): boolean {
  return operationTouchesWebsite(operation, result);
}

describe("website derivative invalidation", () => {
  test("covers direct writes and both sides of moves", () => {
    expect(
      touches({ kind: "write", path: "website/index.md", text: "page" }),
    ).toBe(true);
    expect(
      touches({ kind: "move", from: "notes/page.md", to: "website/page.md" }),
    ).toBe(true);
    expect(
      touches({ kind: "move", from: "website/page.md", to: "notes/page.md" }),
    ).toBe(true);
    expect(
      touches({
        kind: "delete",
        path: "/website/page.md",
        confirmation: "page",
      }),
    ).toBe(true);
  });

  test("distinguishes incomplete autosaves from explicit restrictions", () => {
    const write = (text: string) =>
      operationMayRestrictWebsite(
        { kind: "write", path: "website/index.md", text },
        written,
      );

    expect(write("---\ntitle: Home\n---\n\nHello\n")).toBe(false);
    expect(write("---\ntitle: Half written\n\nHello\n")).toBe(false);
    expect(write("---\ntitle: Home\ndraft: true\n---\n\nHello\n")).toBe(true);
    expect(
      write("---\ntitle: Home\naudience: members\n---\n\nHello\n"),
    ).toBe(true);
    expect(
      write(
        "---\ncontext_encryption: v1\n---\n\n```context-encrypted\n{}\n```\n",
      ),
    ).toBe(true);
    expect(
      operationMayRestrictWebsite(
        { kind: "delete", path: "website/index.md", confirmation: "index.md" },
        { kind: "deleted", paths: ["website/index.md"] },
      ),
    ).toBe(true);
  });

  test("reads the restriction, not the status that hides it", () => {
    const write = (text: string) =>
      operationMayRestrictWebsite(
        { kind: "write", path: "website/index.md", text },
        written,
      );

    // Every one of these is a page the route status calls a "problem", so the
    // last good release would keep answering for it. Each also says, in the
    // frontmatter, that it should stop being served to anyone.
    expect(write("---\ntitle: Home\naudience: members\n---\n")).toBe(true);
    expect(write("---\ntitle: \naudience: members\n---\n\nHello\n")).toBe(true);
    expect(write("---\ntitle: Home\ndraft: true\n---\n")).toBe(true);
    // A value the parser rejects leaves `audience` at its permissive default.
    // Not understanding an instruction is not permission to ignore it.
    expect(write("---\ntitle: Home\naudience: Members\n---\n\nHi\n")).toBe(true);
    expect(write("---\ntitle: Home\naudience:\n---\n\nHi\n")).toBe(true);
    expect(write("---\ntitle: Home\n  audience: members\n---\n\nHi\n")).toBe(true);
    // A restriction typed into a block whose closing marker is not there yet.
    expect(write("---\ntitle: Home\naudience: members\n\nHi\n")).toBe(true);

    // And the autosave cases the release exists for stay autosave cases.
    expect(write("---\ntitle: Home\naudience: public\n---\n")).toBe(false);
    expect(write("---\ntitle: Home\ndraft: false\nnav: x\n---\n\nHi\n")).toBe(false);
    expect(write("---\ntitle: Home\n---\n")).toBe(false);
    expect(write("---\ntitle: Audiences\n---\n\naudience: members\n")).toBe(false);
  });

  test("uses landed paths when an operation reports a move", () => {
    expect(
      touches(
        { kind: "duplicate", path: "notes/page.md" },
        {
          kind: "moved",
          from: "notes/page.md",
          to: "website/page.md",
          paths: ["website/page.md"],
        },
      ),
    ).toBe(true);
  });

  test("covers destructive vault writes without invalidating reads", () => {
    expect(touches({ kind: "clearVault", countOnly: false })).toBe(true);
    expect(touches({ kind: "clearVault", countOnly: true })).toBe(false);
    expect(touches({ kind: "read", path: "website/index.md" })).toBe(false);
    expect(
      touches({ kind: "write", path: "notes/page.md", text: "note" }),
    ).toBe(false);
  });
});

/*
  Outside `website/`, a privacy change, move or delete names its paths, and the
  route index decides whether they reach the site (`websites/routeChangeAt.ts`).
  SABOTAGE: returning [] for the visibility kinds fails the first case here and
  the console case in `websiteQueuedMoves.test.ts`.
*/
describe("changes outside website/ that may narrow a site", () => {
  const moved = { kind: "moved", from: "features", to: "capabilities" } as OperationResult;

  test("names the paths of moves and deletes (privacy changes come through the rows, not an operation)", () => {
    expect(websiteNarrowingPaths({ kind: "move", from: "features", to: "capabilities" }, moved)).toEqual([
      "features",
      "capabilities",
    ]);
    expect(
      websiteNarrowingPaths({ kind: "delete", path: "features/forms.md", confirmation: "forms" }, written),
    ).toEqual(["features/forms.md"]);
  });

  test("names nothing for a write, or for what operationTouchesWebsite already answers", () => {
    expect(websiteNarrowingPaths({ kind: "write", path: "features/forms.md", text: "x" }, written)).toEqual([]);
  });
});

/*
  SABOTAGE: dropping the `known.has` half of `assertScanSawMoves` fails
  "a move that began under the scan"; dropping `!drawn` fails the first case.
*/
describe("a website scan and the moves pending around it", () => {
  const blog = { from: "website/blog", to: "website/posts" };
  const elsewhere = { from: "2-areas/old", to: "2-areas/new" };
  const listed = (drawn: boolean) => [
    { folder: "website", drawn },
    { folder: "features", drawn },
  ];

  test("a listing that did not draw a move reaching the site fails the scan", () => {
    expect(() => assertScanSawMoves(listed(false), [blog], [blog])).toThrow(MOVING_SCAN_MESSAGE);
    expect(() => assertScanSawMoves(listed(true), [blog], [blog])).not.toThrow();
  });

  test("a move that began, or turned round, under the scan fails it", () => {
    expect(() => assertScanSawMoves(listed(true), [], [blog])).toThrow(MOVING_SCAN_MESSAGE);
    const undone = { from: blog.to, to: blog.from };
    expect(() => assertScanSawMoves(listed(true), [blog], [undone])).toThrow(MOVING_SCAN_MESSAGE);
    // Into a folder a page names counts as well.
    expect(() => assertScanSawMoves(listed(true), [], [{ from: "drafts", to: "features/drafts" }])).toThrow(
      MOVING_SCAN_MESSAGE,
    );
  });

  test("a move that finished under the scan, or one nowhere near the site, does not", () => {
    expect(() => assertScanSawMoves(listed(true), [blog], [])).not.toThrow();
    expect(() => assertScanSawMoves(listed(false), [elsewhere], [elsewhere])).not.toThrow();
  });
});
