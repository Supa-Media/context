/**
 * `workspaceMoves` — notes moving between the caller's own workspaces, for
 * the console map.
 *
 * What is asserted, and why:
 *
 *  - **The gateway's report is not trusted further than the membership
 *    table.** `/gateway/moves` records a move only for an actor who can write
 *    both ends now; a member, a stranger, a malformed id or a plumbing path
 *    records nothing, and the route answers the same either way.
 *  - **Only moves between two of the caller's own workspaces**, and only those
 *    whose source and destination path the caller can see now, each through
 *    its own bucket's live `privacy.md`. A move that fails either end is
 *    absent — not shown with its path withheld — so a member cannot count the
 *    private moves either.
 *  - **Both sources**: a console move's `contextMoves` row and an AI client's
 *    audit pair, in one newest-first list, cut by the time range.
 *
 * Sabotage record (temporary local edits, reverted):
 *   `list` returning candidates without the visibility filter    2 failed
 *   `recordAgentMove` accepting a `member` role                    1 failed
 *   `moveCandidates` dropping the peer filter                      1 failed
 *     (only the direct check: `list`'s visibility pass drops a move into a
 *     workspace the caller is not in as well, which is the second layer)
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  type TestConvex,
  addMember,
  asUser,
  createUser,
  createWorkspace,
  gatewayPost,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ALICE_BUCKET = "moves-alice-bucket";
const BOB_BUCKET = "moves-bob-bucket";
const HOUR = 60 * 60 * 1000;

interface Fixture {
  t: TestConvex;
  alice: Id<"users">;
  bob: Id<"users">;
  carol: Id<"users">;
  aliceWs: Id<"workspaces">;
  bobWs: Id<"workspaces">;
  carolWs: Id<"workspaces">;
}

function seed(bucket: MemoryS3): void {
  bucket.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  bucket.seed("index.md", "# Context\n");
}

async function bind(t: TestConvex, workspaceId: Id<"workspaces">, boundBy: Id<"users">, bucket: string) {
  const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), {
    workspaceId,
  });
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/**
 * Alice owns her personal workspace and edits Bob's, where only `1-projects`
 * is shared. Carol's workspace is one Alice is not in.
 */
async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const alice = await createUser(t, "alice@example.invalid");
  const bob = await createUser(t, "bob@example.invalid");
  const carol = await createUser(t, "carol@example.invalid");
  const aliceWs = await createWorkspace(t, alice, "alice");
  const bobWs = await createWorkspace(t, bob, "bob-team", { kind: "shared" });
  const carolWs = await createWorkspace(t, carol, "carol");
  await addMember(t, bobWs, alice, "editor", bob);

  const aliceBucket = memoryS3(ALICE_BUCKET);
  const bobBucket = memoryS3(BOB_BUCKET);
  seed(aliceBucket);
  seed(bobBucket);
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const first = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
    if (first === BOB_BUCKET) return await bobBucket.fetchImpl(input, init);
    return await aliceBucket.fetchImpl(input, init);
  });
  await bind(t, aliceWs, alice, ALICE_BUCKET);
  await bind(t, bobWs, bob, BOB_BUCKET);
  await asUser(t, bob).action(api.functions.files.setDirectoryVisibility, {
    workspaceId: bobWs,
    path: "1-projects",
    visibility: "team",
  });
  return { t, alice, bob, carol, aliceWs, bobWs, carolWs };
}

async function report(
  f: Fixture,
  move: { from: Id<"workspaces">; to: Id<"workspaces">; fromPath: string; toPath: string; actor: Id<"users"> },
): Promise<void> {
  const response = await gatewayPost(f.t, "/gateway/moves", {
    fromWorkspaceId: move.from,
    toWorkspaceId: move.to,
    fromPath: move.fromPath,
    toPath: move.toPath,
    actorUserId: move.actor,
    actorClientId: "mcp_client_example",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
}

async function moveRows(f: Fixture) {
  return await f.t.run(async (ctx) =>
    (await ctx.db.query("auditEvents").collect()).filter((row) => row.action.startsWith("file.move")),
  );
}

describe("/gateway/moves", () => {
  test("records the console's audit pair for an actor who can write both ends", async () => {
    const f = await fixture();
    await report(f, {
      from: f.aliceWs,
      to: f.bobWs,
      fromPath: "1-projects/a.md",
      toPath: "1-projects/a.md",
      actor: f.alice,
    });
    const rows = await moveRows(f);
    expect(rows.map((row) => [row.workspaceId, row.action, row.paths])).toEqual([
      [f.aliceWs, "file.moveOut", ["1-projects/a.md"]],
      [f.bobWs, "file.moveIn", ["1-projects/a.md"]],
    ]);
    expect(rows[0].details).toMatchObject({ toWorkspaceId: f.bobWs, toPath: "1-projects/a.md", via: "agent" });
    // The destination's row does not name the context the note came from.
    expect(JSON.stringify(rows[1])).not.toContain(f.aliceWs);
    expect(rows.every((row) => row.actorUserId === f.alice)).toBe(true);
  });

  test("records nothing for a reader, a stranger, a bad id or a plumbing path — and says so to nobody", async () => {
    const f = await fixture();
    // Carol is a plain member of Bob's workspace: she can read it, not move out of or into it.
    await addMember(f.t, f.bobWs, f.carol, "member", f.bob);
    await report(f, { from: f.carolWs, to: f.bobWs, fromPath: "a.md", toPath: "a.md", actor: f.carol });
    // Bob is in no workspace of Carol's.
    await report(f, { from: f.bobWs, to: f.carolWs, fromPath: "a.md", toPath: "a.md", actor: f.bob });
    await report(f, {
      from: f.aliceWs,
      to: f.bobWs,
      fromPath: ".context/forwarding.json.md",
      toPath: "a.md",
      actor: f.alice,
    });
    await report(f, { from: f.aliceWs, to: f.bobWs, fromPath: "../a.md", toPath: "a.md", actor: f.alice });
    const response = await gatewayPost(f.t, "/gateway/moves", {
      fromWorkspaceId: "not-an-id",
      toWorkspaceId: f.bobWs,
      fromPath: "a.md",
      toPath: "a.md",
      actorUserId: f.alice,
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(await moveRows(f)).toEqual([]);
  });

  test("refuses a request without the gateway's secret", async () => {
    const f = await fixture();
    const response = await gatewayPost(
      f.t,
      "/gateway/moves",
      { fromWorkspaceId: f.aliceWs, toWorkspaceId: f.bobWs, fromPath: "a.md", toPath: "a.md", actorUserId: f.alice },
      { secret: null },
    );
    expect(response.status).not.toBe(200);
    expect(await moveRows(f)).toEqual([]);
  });
});

describe("workspaceMoves.list", () => {
  async function scenario() {
    const f = await fixture();
    // 1. An AI client's move into Bob's shared folder: visible at both ends.
    await report(f, {
      from: f.aliceWs,
      to: f.bobWs,
      fromPath: "1-projects/launch.md",
      toPath: "1-projects/launch.md",
      actor: f.alice,
    });
    // 2. Into a folder of Bob's that Alice, an editor there, cannot see.
    await report(f, {
      from: f.aliceWs,
      to: f.bobWs,
      fromPath: "2-areas/salary.md",
      toPath: "2-areas/salary-bands.md",
      actor: f.alice,
    });
    const now = Date.now();
    await f.t.run(async (ctx) => {
      // 3. A console folder move, finished.
      await ctx.db.insert("contextMoves", {
        sourceWorkspaceId: f.aliceWs,
        destinationWorkspaceId: f.bobWs,
        actorUserId: f.alice,
        from: "1-projects/research",
        to: "1-projects/research",
        status: "complete",
        movedObjects: 9,
        movedBytes: 900,
        skipped: [],
        createdAt: now - 2 * HOUR,
        updatedAt: now - HOUR,
        completedAt: now - HOUR,
      });
      // 4. One still moving: not a move yet.
      await ctx.db.insert("contextMoves", {
        sourceWorkspaceId: f.aliceWs,
        destinationWorkspaceId: f.bobWs,
        actorUserId: f.alice,
        from: "1-projects/half",
        to: "1-projects/half",
        status: "moving",
        movedObjects: 3,
        movedBytes: 300,
        skipped: [],
        createdAt: now,
        updatedAt: now,
      });
      // 5. Into Carol's workspace, which Alice is not in.
      await ctx.db.insert("auditEvents", {
        workspaceId: f.aliceWs,
        actorUserId: f.alice,
        action: "file.moveOut",
        paths: ["1-projects/to-carol.md"],
        at: now,
        details: { toWorkspaceId: f.carolWs, toPath: "1-projects/to-carol.md", via: "agent" },
      });
    });
    return f;
  }

  test("an editor sees the moves both of whose ends they can see, and no other", async () => {
    const f = await scenario();
    const answer = await asUser(f.t, f.alice).action(api.functions.workspaceMoves.list, {
      from: Date.now() - 24 * HOUR,
      to: Date.now() + HOUR,
    });
    expect(answer.truncated).toBe(false);
    expect(answer.moves.map((move) => [move.via, move.fromPath, move.toPath])).toEqual([
      ["agent", "1-projects/launch.md", "1-projects/launch.md"],
      ["console", "1-projects/research", "1-projects/research"],
    ]);
    for (const move of answer.moves) {
      expect(move.fromWorkspaceId).toBe(f.aliceWs);
      expect(move.toWorkspaceId).toBe(f.bobWs);
      expect(move.actorName).toBe("@alice");
    }
    const text = JSON.stringify(answer);
    expect(text).not.toContain("salary");
    expect(text).not.toContain("to-carol");
    expect(text).not.toContain(f.carolWs);
    expect(text).not.toContain("half");
  });

  test("the owner of the destination, who is not in the source, sees none of it", async () => {
    const f = await scenario();
    const answer = await asUser(f.t, f.bob).action(api.functions.workspaceMoves.list, {
      from: Date.now() - 24 * HOUR,
      to: Date.now() + HOUR,
    });
    expect(answer).toEqual({ moves: [], truncated: false });
  });

  test("a member of both who owns both sees the private move too", async () => {
    const f = await scenario();
    // Hand Alice Bob's workspace: her scope there becomes `private`.
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.bobWs).eq("userId", f.alice))
        .unique();
      await ctx.db.patch(row!._id, { role: "owner" });
    });
    const answer = await asUser(f.t, f.alice).action(api.functions.workspaceMoves.list, {
      from: Date.now() - 24 * HOUR,
      to: Date.now() + HOUR,
    });
    expect(answer.moves.map((move) => move.toPath)).toContain("2-areas/salary-bands.md");
  });

  test("the range cuts by time, and a bad range is refused", async () => {
    const f = await scenario();
    const later = await asUser(f.t, f.alice).action(api.functions.workspaceMoves.list, {
      from: Date.now() + HOUR,
      to: Date.now() + 2 * HOUR,
    });
    expect(later.moves).toEqual([]);
    const lastHalfHour = await asUser(f.t, f.alice).action(api.functions.workspaceMoves.list, {
      from: Date.now() - HOUR / 2,
      to: Date.now() + HOUR,
    });
    // The console move finished an hour ago; the agent's just now.
    expect(lastHalfHour.moves.map((move) => move.via)).toEqual(["agent"]);

    await expect(
      asUser(f.t, f.alice).action(api.functions.workspaceMoves.list, {
        from: 0,
        to: Date.now(),
      }),
    ).rejects.toThrow(/range/);
  });

  test("a caller who is not signed in is refused", async () => {
    const f = await scenario();
    await expect(
      f.t.action(api.functions.workspaceMoves.list, { from: Date.now() - HOUR, to: Date.now() }),
    ).rejects.toThrow();
  });

  test("the candidate query re-checks membership of the workspace it reads", async () => {
    const f = await scenario();
    const found = await f.t.query(internal.functions.workspaceMoves.moveCandidates, {
      actorUserId: f.bob,
      workspaceId: f.aliceWs,
      peers: [f.aliceWs, f.bobWs],
      from: 0,
      to: Date.now() + HOUR,
    });
    expect(found).toEqual({ moves: [], truncated: false });

    // And keeps only moves into `peers`: the move into Carol's workspace is
    // not a candidate at all, before any bucket is asked about its paths.
    const alices = await f.t.query(internal.functions.workspaceMoves.moveCandidates, {
      actorUserId: f.alice,
      workspaceId: f.aliceWs,
      peers: [f.aliceWs, f.bobWs],
      from: 0,
      to: Date.now() + HOUR,
    });
    expect(alices.moves.length).toBeGreaterThan(0);
    expect(alices.moves.every((move) => move.toWorkspaceId === f.bobWs)).toBe(true);
  });
});
