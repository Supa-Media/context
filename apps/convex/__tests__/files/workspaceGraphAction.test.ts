/**
 * `files.workspaceGraph`, through the real action and the real credential
 * barrier: the map's graph is the caller's own scope's graph.
 *
 * `workspaceGraph.test.ts` proves the filter against a store. This proves the
 * wiring cannot undo it — a handler that dropped `authorizeFileAccess` and
 * passed `scope: "private"` would hand a member the owner's map, and the
 * private note's link to a shared one would be on it.
 */

import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { memoryS3 } from "../storeStub.helpers";
import { FAKE_STORAGE, asUser, copyTree, createUser, createWorkspace, setupTest, type TestConvex } from "../fixtures.helpers";
import { LINKS_BEHIND_MIN } from "../../functions/lib/fileOps/graph";
import { fixture, share } from "./fixtures.helpers";

/**
 * The bucket's notes are copied into the Convex tree, and their links are read
 * (the facts fill): the map draws from those and from nothing in the bucket
 * (decided by the owner, 2026-10-13).
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

describe("files.workspaceGraph", { timeout: 60_000 }, () => {
  test("a member's map holds only what their scope sees, and no edge to the rest", async () => {
    const f = await fixture();
    // A private note that links into the shared folder, and a shared note that
    // links back out to it.
    const owner = asUser(f.t, f.owner);
    const privateRead = await owner.action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "2-areas/private-note.md",
    });
    await owner.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "2-areas/private-note.md",
      text: "# Private\n\nSee [[../1-projects/shared]].\n",
      expectedEtag: privateRead.etag,
    });
    const sharedRead = await owner.action(api.functions.files.readNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
    });
    await owner.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
      text: "# Shared\n\nFrom [[../2-areas/private-note]] and [[README]].\n",
      expectedEtag: sharedRead.etag,
    });
    await share(f);
    await readLinks(f.t, f.workspaceId);

    const ownerGraph = await owner.action(api.functions.files.workspaceGraph, {
      workspaceId: f.workspaceId,
    });
    expect(ownerGraph.indexMissing).toBe(false);
    expect(ownerGraph.nodes.map((node) => node.path)).toContain("2-areas/private-note.md");
    const ownerEdges = ownerGraph.edges.map(([a, b]) => `${ownerGraph.nodes[a].path}>${ownerGraph.nodes[b].path}`);
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
    // "Behind" is `LINKS_BEHIND_MIN` notes whose links nobody has read yet. Writes
    // read their own links, so the notes must be in the tree before anything fills
    // their facts: a bucket of them, copied in as a first walk copies one.
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");
    const backend = memoryS3(FAKE_STORAGE.bucket);
    backend.seed("index.md", "# Context\n");
    for (let index = 0; index < LINKS_BEHIND_MIN; index += 1) {
      backend.seed(`1-projects/bulk-${String(index).padStart(2, "0")}.md`, `# Bulk ${index}\n`);
    }
    vi.stubGlobal("fetch", backend.fetchImpl);
    const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), { workspaceId });
    await t.run((ctx) =>
      ctx.db.insert("storageBindings", {
        workspaceId,
        provider: FAKE_STORAGE.provider,
        endpoint: FAKE_STORAGE.endpoint,
        region: FAKE_STORAGE.region,
        bucket: FAKE_STORAGE.bucket,
        accessKeyId: FAKE_STORAGE.accessKeyId,
        encryptedSecretAccessKey,
        capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
        status: "connected" as const,
        lastVerifiedAt: Date.now(),
        boundBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    await copyTree(t, workspaceId);

    const graph = await asUser(t, owner).action(api.functions.files.workspaceGraph, { workspaceId });
    expect(graph.nodes.map((node) => node.path)).toContain("1-projects/bulk-00.md");
    expect(graph.indexMissing).toBe(false);
    expect(graph.behind).toBe(true);
  });
});
