/**
 * `POST /gateway/moves/across`: an AI client moving a note into another
 * workspace through the console's engine, which handles a keyed end at either
 * side (`functions/lib/gatewayRoutes/moveAcross.ts`).
 *
 * The route answers one thing to every caller it will not serve, so a
 * workspace the grant cannot reach reads the same as one that does not exist.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { createUser, createWorkspace, gatewayPost } from "./fixtures.helpers";
import { danglingWorkspaceId, registerClient, seedConnectedClient, token } from "./controlPlane/fixtures.helpers";
import { pair, type Pair } from "./contextMove.helpers";
import { nodeAt as treeNodeAt } from "../functions/lib/nodes/paths";

const ACCESS = token("mover");
const OWNER_PRIVATE = ["context:read", "context:write", "context:private"];

async function connect(p: Pair, scopes: string[] = OWNER_PRIVATE): Promise<void> {
  await registerClient(p.t, "mcp_client_mover");
  await seedConnectedClient(p.t, { workspaceId: p.from, userId: p.mover, clientId: "mcp_client_mover", accessToken: ACCESS, scopes });
}

async function across(p: Pair, over: Record<string, unknown> = {}) {
  const response = await gatewayPost(p.t, "/gateway/moves/across", {
    accessToken: ACCESS,
    sourceWorkspaceId: p.from,
    destinationWorkspaceId: p.to,
    from: "1-projects/acme/note-000.md",
    to: "work/note-000.md",
    ...over,
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { move: unknown }).move;
}

async function liveAt(p: Pair, workspaceId: Id<"workspaces">, path: string) {
  return await p.t.run(async (ctx) => {
    const row = await treeNodeAt(ctx.db, workspaceId, path);
    return row !== null && row.goneAt === undefined ? row : null;
  });
}

/** Both workspaces are keyed by the copy every workspace gets. */
async function keyedPair(into: "own" | "shared" = "own"): Promise<Pair> {
  return await pair({ notes: 2, into });
}

describe("an AI client moving a note between keyed workspaces", { timeout: 30_000 }, () => {
  test("moves it: a new keyed note there, the old one in the trash here", async () => {
    const p = await keyedPair();
    await connect(p);

    expect(await across(p)).toEqual({ status: "complete", movedObjects: 1, skipped: [] });

    const landed = await liveAt(p, p.to, "work/note-000.md");
    expect(landed?.storageKey).toMatch(/^notes\/[0-9a-f-]+\.md$/);
    expect(p.destination.objects.get(landed!.storageKey!)?.body).toBe("# 0\n");
    expect(await liveAt(p, p.from, "1-projects/acme/note-000.md")).toBeNull();
  });

  test("into a shared workspace the mover edits", async () => {
    const p = await keyedPair("shared");
    await connect(p);

    expect(await across(p)).toMatchObject({ status: "complete", movedObjects: 1 });
    expect(await liveAt(p, p.to, "work/note-000.md")).not.toBeNull();
  });

  test("a name already taken there is the engine's refusal, and nothing moves", async () => {
    const p = await keyedPair();
    await connect(p);

    const move = (await across(p, { to: "work/README.md" })) as { status: string; error?: string };

    expect(move.status).toBe("failed");
    expect(move.error).toBeTruthy();
    expect(await liveAt(p, p.from, "1-projects/acme/note-000.md")).not.toBeNull();
  });
});

describe("who the route will not serve", { timeout: 30_000 }, () => {
  test.each([
    ["a read-only grant", ["context:read"]],
    ["a grant without private notes", ["context:read", "context:write"]],
  ])("%s", async (_name, scopes) => {
    const p = await keyedPair();
    await connect(p, scopes);
    expect(await across(p)).toBeNull();
    expect(await liveAt(p, p.from, "1-projects/acme/note-000.md")).not.toBeNull();
  });

  test("an unknown token", async () => {
    const p = await keyedPair();
    await connect(p);
    expect(await across(p, { accessToken: token("nobody") })).toBeNull();
  });

  test("a stranger's workspace reads exactly as a missing one", async () => {
    const p = await keyedPair();
    await connect(p);
    const stranger = await createUser(p.t, "stranger@example.invalid");
    const theirs = await createWorkspace(p.t, stranger, "dee-context");
    const missing = await danglingWorkspaceId(p.t);

    expect(await across(p, { destinationWorkspaceId: theirs })).toBeNull();
    expect(await across(p, { destinationWorkspaceId: missing })).toBeNull();
    expect(await across(p, { sourceWorkspaceId: theirs })).toBeNull();
    expect(await liveAt(p, p.from, "1-projects/acme/note-000.md")).not.toBeNull();
  });

  test("a source the caller only edits: moving out takes ownership", async () => {
    const p = await keyedPair("shared");
    await connect(p);
    // Backwards: out of the shared workspace, where the mover is an editor.
    expect(
      await across(p, { sourceWorkspaceId: p.to, destinationWorkspaceId: p.from, from: "work/README.md", to: "1-projects/x.md" }),
    ).toBeNull();
  });

  test("the same workspace at both ends", async () => {
    const p = await keyedPair();
    await connect(p);
    expect(await across(p, { destinationWorkspaceId: p.from, to: "1-projects/elsewhere.md" })).toBeNull();
  });
});
