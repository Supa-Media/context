/**
 * `files.workspaceGraph`, through the real action and the real credential
 * barrier: the map's graph is the caller's own scope's graph.
 *
 * `workspaceGraph.test.ts` proves the filter against a store. This proves the
 * wiring cannot undo it — a handler that dropped `authorizeFileAccess` and
 * passed `scope: "private"` would hand a member the owner's map, and the
 * private note's link to a shared one would be on it.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { asUser, copyTree, type TestConvex } from "../fixtures.helpers";
import { fixture, share } from "./fixtures.helpers";

/**
 * What was written straight into the bucket reaches the Convex tree (a sweep),
 * and its links are read (the facts fill): the map draws from those and from
 * nothing in the bucket (decided by the owner, 2026-10-13).
 */
async function readLinks(t: TestConvex, workspaceId: Id<"workspaces">): Promise<void> {
  await copyTree(t, workspaceId);
  for (let pass = 0; pass < 12; pass += 1) {
    await t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private" as const,
      operation: { kind: "nodesFactFill" as const },
    });
    if (await t.query(internal.functions.nodeFacts.ready, { workspaceId })) return;
  }
  throw new Error("the facts never filled");
}

describe("files.workspaceGraph", () => {
  test("a member's map holds only what their scope sees, and no edge to the rest", async () => {
    const f = await fixture();
    // A private note that links into the shared folder, and a shared note that
    // links back out to it.
    f.backend.seed("2-areas/private-note.md", "# Private\n\nSee [[../1-projects/shared]].\n");
    f.backend.seed("1-projects/shared.md", "# Shared\n\nFrom [[../2-areas/private-note]] and [[README]].\n");
    await share(f);
    await readLinks(f.t, f.workspaceId);

    const owner = await asUser(f.t, f.owner).action(api.functions.files.workspaceGraph, {
      workspaceId: f.workspaceId,
    });
    expect(owner.indexMissing).toBe(false);
    expect(owner.nodes.map((node) => node.path)).toContain("2-areas/private-note.md");
    const ownerEdges = owner.edges.map(([a, b]) => `${owner.nodes[a].path}>${owner.nodes[b].path}`);
    expect(ownerEdges).toContain("2-areas/private-note.md>1-projects/shared.md");
    expect(ownerEdges).toContain("1-projects/shared.md>2-areas/private-note.md");

    const member = await asUser(f.t, f.reader).action(api.functions.files.workspaceGraph, {
      workspaceId: f.workspaceId,
    });
    expect(member.nodes.map((node) => node.path)).toEqual([
      "1-projects/README.md",
      "1-projects/shared.md",
    ]);
    expect(member.edges).toEqual([[1, 0]]);
    expect(JSON.stringify(member)).not.toContain("private-note");
    expect(JSON.stringify(member)).not.toContain("2-areas");
  });

  test("links not read yet: every note is drawn from the tree, and the map says it is behind", async () => {
    const f = await fixture();
    const graph = await asUser(f.t, f.owner).action(api.functions.files.workspaceGraph, {
      workspaceId: f.workspaceId,
    });
    expect(graph.nodes.map((node) => node.path)).toContain("1-projects/shared.md");
    expect(graph.indexMissing).toBe(false);
    expect(graph.behind).toBe(true);
  });
});
