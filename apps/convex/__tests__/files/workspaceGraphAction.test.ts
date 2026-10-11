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
import { asUser, type TestConvex } from "../fixtures.helpers";
import { fixture, share } from "./fixtures.helpers";

async function indexBucket(t: TestConvex, workspaceId: Id<"workspaces">): Promise<void> {
  for (let pass = 0; pass < 12; pass += 1) {
    const result = await t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private" as const,
      operation: { kind: "maintainIndex" as const },
    });
    if (result.kind === "indexMaintained" && result.complete) return;
  }
  throw new Error("the index never converged");
}

describe("files.workspaceGraph", () => {
  test("a member's map holds only what their scope sees, and no edge to the rest", async () => {
    const f = await fixture();
    // A private note that links into the shared folder, and a shared note that
    // links back out to it.
    f.backend.seed("2-areas/private-note.md", "# Private\n\nSee [[../1-projects/shared]].\n");
    f.backend.seed("1-projects/shared.md", "# Shared\n\nFrom [[../2-areas/private-note]] and [[README]].\n");
    await share(f);
    await indexBucket(f.t, f.workspaceId);

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

  test("a bucket nothing has indexed says so rather than drawing an empty map", async () => {
    const f = await fixture();
    const graph = await asUser(f.t, f.owner).action(api.functions.files.workspaceGraph, {
      workspaceId: f.workspaceId,
    });
    expect(graph).toEqual({
      kind: "workspaceGraph",
      nodes: [],
      edges: [],
      truncated: false,
      noteCount: 0,
      linksCut: false,
      behind: true,
      indexMissing: true,
    });
  });
});
