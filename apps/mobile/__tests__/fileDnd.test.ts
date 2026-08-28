/**
 * Dragging rows in the file tree.
 *
 * These rules exist as a pure table precisely so a test can hold them: the web
 * build drags with pointer events and the phone drags with a gesture, and the
 * only thing keeping the two honest is that both call `canDrop`. So the cases
 * pinned here are the ones a hand-written drag handler gets wrong — a folder
 * dropped into its own child, a move that renames itself out of a collision, a
 * multi-select drag that half-applies, and a drop onto another context, which
 * is a feature this product has deliberately not built yet and must therefore
 * say so out loud rather than snap back in silence.
 *
 * Fixture names are obviously fake; this repository is public.
 */

import { describe, expect, test } from "@jest/globals";
import {
  AUTO_EXPAND_MS,
  canDrop,
  contextDropTarget,
  externalDragPayload,
  planExternalDrop,
  type DragSource,
} from "../features/console/files/dnd";
import type { FileEntry, FolderListing } from "../features/console/files/types";

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

function file(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    kind: "file",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
    ...over,
  };
}

function folder(path: string): FileEntry {
  return {
    kind: "folder",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

function listing(path: string, entries: FileEntry[]): FolderListing {
  return { path, folderDefault: "private", entries, truncated: false, manifestUsable: true };
}

/** One expanded context: a root, a project folder with a child, and an area. */
const listings: Readonly<Record<string, FolderListing | undefined>> = {
  "": listing("", [folder("1-projects"), folder("2-areas"), file("privacy.md", { readOnly: true })]),
  "1-projects": listing("1-projects", [folder("1-projects/sub"), file("1-projects/plan.md")]),
  "1-projects/sub": listing("1-projects/sub", []),
  "2-areas": listing("2-areas", [file("2-areas/plan.md"), file("2-areas/notes.md")]),
};

function drag(...paths: string[]): DragSource {
  return { paths, readOnly: false };
}

/* -------------------------------------------------------------------------- */
/*                          a drop onto a folder                              */
/* -------------------------------------------------------------------------- */

describe("dropping onto a folder", () => {
  test("moves by default", () => {
    expect(canDrop(drag("1-projects/plan.md"), { kind: "folder", path: "2-areas" }, [], {})).toEqual(
      {
        ok: true,
        action: "move",
        moves: [{ from: "1-projects/plan.md", to: "2-areas/plan.md" }],
      },
    );
  });

  test("the copy modifier copies instead", () => {
    expect(
      canDrop(drag("1-projects/plan.md"), { kind: "folder", path: "2-areas" }, ["copy"], {}),
    ).toEqual({
      ok: true,
      action: "copy",
      moves: [{ from: "1-projects/plan.md", to: "2-areas/plan.md" }],
    });
  });

  test("a drop on the root lands at the root", () => {
    expect(canDrop(drag("1-projects/plan.md"), { kind: "root" }, [], listings)).toEqual({
      ok: true,
      action: "move",
      moves: [{ from: "1-projects/plan.md", to: "plan.md" }],
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                    the copy/move asymmetry on a collision                  */
/* -------------------------------------------------------------------------- */

describe("a collision means different things to a copy and to a move", () => {
  /** `2-areas` already has a `plan.md`. */
  test("a copy takes the next free duplicate name", () => {
    expect(
      canDrop(drag("1-projects/plan.md"), { kind: "folder", path: "2-areas" }, ["copy"], listings),
    ).toEqual({
      ok: true,
      action: "copy",
      moves: [{ from: "1-projects/plan.md", to: "2-areas/plan copy.md" }],
    });
  });

  /**
   * The same asymmetry `planPaste` already encodes: a move that renamed itself
   * out of a collision did something other than what was asked, and the
   * original is already gone.
   */
  test("a move is refused rather than renamed", () => {
    const verdict = canDrop(
      drag("1-projects/plan.md"),
      { kind: "folder", path: "2-areas" },
      [],
      listings,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/already has something called plan\.md/);
  });

  test("a copy back into its own folder is a duplicate, and is allowed", () => {
    expect(
      canDrop(drag("2-areas/plan.md"), { kind: "folder", path: "2-areas" }, ["copy"], listings),
    ).toEqual({
      ok: true,
      action: "copy",
      moves: [{ from: "2-areas/plan.md", to: "2-areas/plan copy.md" }],
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                    delegation to describeMoveProblem                       */
/* -------------------------------------------------------------------------- */

describe("the impossible moves are refused, by delegation not by rewriting", () => {
  /** The case the delegation exists for: a folder into its own descendant. */
  test("a folder cannot be dropped into its own child", () => {
    const verdict = canDrop(drag("1-projects"), { kind: "folder", path: "1-projects/sub" }, [], {});
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/A folder cannot be moved inside itself/);
    expect(verdict.ok === false && verdict.reason).toMatch(/1-projects/);
  });

  test("a folder cannot be dropped onto itself", () => {
    const verdict = canDrop(drag("1-projects"), { kind: "folder", path: "1-projects" }, [], {});
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/folder you are moving/);
  });

  test("a copy into a folder's own descendant is refused too", () => {
    const verdict = canDrop(
      drag("1-projects"),
      { kind: "folder", path: "1-projects/sub" },
      ["copy"],
      {},
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/inside itself/);
  });

  test("dropping a row back where it already is says so", () => {
    const verdict = canDrop(
      drag("1-projects/plan.md"),
      { kind: "folder", path: "1-projects" },
      [],
      listings,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/It is already there\./);
  });

  test("nothing dragged is nothing dropped", () => {
    expect(canDrop(drag(), { kind: "root" }, [], listings).ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                             read-only rows                                 */
/* -------------------------------------------------------------------------- */

describe("a generated file is not draggable anywhere", () => {
  const generated: DragSource = { paths: ["privacy.md"], readOnly: true };

  test("every target refuses it, and says why it is generated", () => {
    for (const target of [
      { kind: "folder", path: "2-areas" },
      { kind: "root" },
      { kind: "context", slug: "public-worship" },
      { kind: "external" },
    ] as const) {
      const verdict = canDrop(generated, target, [], listings);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toMatch(
        /generated from your visibility settings/,
      );
    }
  });

  /** One read-only row in a multi-select drag poisons the whole gesture. */
  test("a mixed selection is read-only as a whole", () => {
    const mixed: DragSource = { paths: ["1-projects/plan.md", "privacy.md"], readOnly: true };
    expect(canDrop(mixed, { kind: "root" }, [], listings).ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                          another context in the rail                       */
/* -------------------------------------------------------------------------- */

describe("dropping onto another context", () => {
  /**
   * Cross-context writes and mounts are "deliberately not yet" in the root
   * CLAUDE.md. The refusal has to be a sentence, because a drag that silently
   * snaps back is indistinguishable from a drop that missed.
   */
  test("is refused with a reason naming the context and what to do instead", () => {
    const verdict = canDrop(
      drag("1-projects/plan.md"),
      { kind: "context", slug: "public-worship" },
      [],
      listings,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("@public-worship");
    expect(verdict.ok === false && verdict.reason).toMatch(/not supported yet/);
    expect(verdict.ok === false && verdict.reason).toMatch(/separate, with its own bucket/);
  });

  test("the copy modifier does not unlock it", () => {
    expect(
      canDrop(drag("1-projects/plan.md"), { kind: "context", slug: "lk" }, ["copy"], listings).ok,
    ).toBe(false);
  });

  /** Dropping on the context you are already in is an ordinary root drop. */
  test("the context you are already in is a root drop, and works", () => {
    expect(contextDropTarget("seyi", "seyi")).toEqual({ kind: "root" });
    expect(contextDropTarget("public-worship", "seyi")).toEqual({
      kind: "context",
      slug: "public-worship",
    });
    const verdict = canDrop(
      drag("1-projects/plan.md"),
      contextDropTarget("seyi", "seyi"),
      [],
      listings,
    );
    expect(verdict).toEqual({
      ok: true,
      action: "move",
      moves: [{ from: "1-projects/plan.md", to: "plan.md" }],
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                              multi-path drags                              */
/* -------------------------------------------------------------------------- */

describe("a multi-select drag is one gesture, so it is all or nothing", () => {
  test("every path moves when every path can", () => {
    expect(
      canDrop(drag("2-areas/plan.md", "2-areas/notes.md"), { kind: "root" }, [], listings),
    ).toEqual({
      ok: true,
      action: "move",
      moves: [
        { from: "2-areas/plan.md", to: "plan.md" },
        { from: "2-areas/notes.md", to: "notes.md" },
      ],
    });
  });

  /**
   * The half-applied move is the thing somebody spends an afternoon undoing,
   * and afterwards it is indistinguishable from a move they made on purpose.
   */
  test("one colliding path refuses the whole drop and names that path", () => {
    const verdict = canDrop(
      drag("1-projects/sub", "1-projects/plan.md"),
      { kind: "folder", path: "2-areas" },
      [],
      listings,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("1-projects/plan.md");
    expect(verdict.ok === false && verdict.reason).toMatch(/already has something called plan\.md/);
    // And emphatically not a partial plan for the path that would have worked.
    expect(verdict).not.toHaveProperty("moves");
  });

  test("two dragged rows with the same name collide with each other, not just with the folder", () => {
    const verdict = canDrop(
      drag("1-projects/plan.md", "1-projects/sub/plan.md"),
      { kind: "root" },
      [],
      listings,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toContain("1-projects/sub/plan.md");
  });

  test("copying two rows with the same name gives the second a free name of its own", () => {
    expect(
      canDrop(
        drag("1-projects/plan.md", "1-projects/sub/plan.md"),
        { kind: "root" },
        ["copy"],
        listings,
      ),
    ).toEqual({
      ok: true,
      action: "copy",
      moves: [
        { from: "1-projects/plan.md", to: "plan.md" },
        { from: "1-projects/sub/plan.md", to: "plan copy.md" },
      ],
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                              out of the app                                */
/* -------------------------------------------------------------------------- */

describe("dragging out of Context", () => {
  test("carries the addressable @name/path form", () => {
    expect(externalDragPayload(["1-projects/foo.md"], "seyi")).toBe("@seyi/1-projects/foo.md");
  });

  test("several are newline-joined", () => {
    expect(externalDragPayload(["1-projects/foo.md", "2-areas/bar.md"], "seyi")).toBe(
      "@seyi/1-projects/foo.md\n@seyi/2-areas/bar.md",
    );
  });

  test("a slug that already carries its @ is not doubled", () => {
    expect(externalDragPayload(["index.md"], "@seyi")).toBe("@seyi/index.md");
  });

  test("the drop itself changes nothing here, and says so rather than animating", () => {
    const verdict = canDrop(drag("1-projects/plan.md"), { kind: "external" }, [], listings);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/Nothing here moves/);
  });
});

/* -------------------------------------------------------------------------- */
/*                          files dragged in from the OS                      */
/* -------------------------------------------------------------------------- */

describe("files dropped in from the OS", () => {
  test("markdown is accepted; anything else says attachments are not supported yet", () => {
    const plan = planExternalDrop(["notes.md", "diagram.png"], "1-projects", listings);
    expect(plan.accepted).toEqual(["notes.md"]);
    expect(plan.refused).toEqual([
      { name: "diagram.png", reason: expect.stringMatching(/Attachments are not supported yet/) },
    ]);
  });

  test("a name the bucket would refuse gets the name rule's own sentence", () => {
    const plan = planExternalDrop([".hidden.md", "privacy.md"], "1-projects", listings);
    expect(plan.accepted).toEqual([]);
    expect(plan.refused.map((entry) => entry.name)).toEqual([".hidden.md", "privacy.md"]);
    expect(plan.refused[0].reason).toMatch(/history and audit/);
    expect(plan.refused[1].reason).toMatch(/generated from your visibility settings/);
  });

  test("a name already in the destination is refused", () => {
    const plan = planExternalDrop(["plan.md"], "2-areas", listings);
    expect(plan.accepted).toEqual([]);
    expect(plan.refused[0].reason).toMatch(/2-areas already has something called plan\.md/);
    expect(planExternalDrop(["privacy.md"], "", listings).accepted).toEqual([]);
  });

  /**
   * Unlike `canDrop`, this is deliberately not all-or-nothing: nothing is
   * being taken away, so eleven notes should still land when the twelfth is a
   * screenshot.
   */
  test("the good files still land when one of them is refused", () => {
    const plan = planExternalDrop(["a.md", "b.md", "shot.png", "c.md"], "1-projects", listings);
    expect(plan.accepted).toEqual(["a.md", "b.md", "c.md"]);
    expect(plan.refused).toHaveLength(1);
  });

  test("two dropped files with the same name do not both get accepted", () => {
    const plan = planExternalDrop(["a.md", "a.md"], "1-projects", listings);
    expect(plan.accepted).toEqual(["a.md"]);
    expect(plan.refused[0].reason).toMatch(/already has something called a\.md/);
  });

  test("an unloaded destination cannot see collisions, and the server still checks", () => {
    expect(planExternalDrop(["plan.md"], "3-resources", listings).accepted).toEqual(["plan.md"]);
  });
});

describe("auto-expand", () => {
  /** A number both drag handlers share, rather than two components guessing. */
  test("is a named constant, long enough to drag across a folder", () => {
    expect(AUTO_EXPAND_MS).toBe(600);
  });
});
