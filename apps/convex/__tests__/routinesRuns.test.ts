import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, gatewayPost, seedStorageBinding } from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";
import { ROUTINE_LEASE_MS } from "../functions/lib/routines/model";
import {
  DAILY,
  DAILY_TEXT,
  agentPost,
  due,
  linkPhone,
  makeDue,
  routineFixture,
  rowAt,
  seededBucket,
  signal,
  stubBuckets,
  type RoutineFixture,
} from "./routines.helpers";

/** The personal workspace a fixture made for `userId` (its slug is their handle). */
async function personalWorkspaceOf(f: RoutineFixture, userId: RoutineFixture["owner"]) {
  return await f.t.run(async (ctx) => {
    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const membership of memberships) {
      const workspace = await ctx.db.get(membership.workspaceId);
      if (workspace?.kind === "personal") return workspace._id;
    }
    throw new Error("no personal workspace");
  });
}

/**
 * ROUTINES: HANDING DUE RUNS TO THE TEXTING WORKER, AND HEARING BACK.
 *
 * Through the real `/agent-texts/routines/*` routes. Everything that could
 * have changed since a row was written is asked again when a run is handed
 * out, and what comes back is a code from a closed list, never text.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `claimDueRoutinesHandler` not re-asking `writingRole` at claim time
 *     → "a writer who lost write access is not run" fails
 *   `claimDueRoutinesHandler` ignoring a live lease (`leaseIsLive` → false)
 *     → "a claim moves the next run on, and a live lease is not claimed twice" fails
 *   `applyRoutineGrant` matching any active grant instead of the routines client
 *     → "a routine's grant leaves the texting grant alone" fails
 *   recipients honouring `to:` whatever `writerSource` says
 *     → "a personal routine nobody was seen writing still texts its owner…" fails
 *   `fallsBackToOwner` → true for every workspace
 *     → "a shared routine nobody was seen writing texts nobody…" and
 *       "a shared routine left running as its owner…" fail
 *   `fallsBackToOwner` reading only `kind`, not who else may write
 *     → "a personal workspace shared with an editor does not fall back…" fails
 */

vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function dailyRoutine(f: RoutineFixture, writer = f.editor, text = DAILY_TEXT) {
  f.backend.seed(DAILY, text);
  await signal(f.t, { workspaceId: f.workspaceId, userId: writer, paths: [DAILY] });
  await makeDue(f.t, f.workspaceId, DAILY);
}

async function session(f: RoutineFixture, accessToken: string) {
  const response = await gatewayPost(f.t, "/gateway/session", { accessToken });
  return ((await response.json()) as { session: Record<string, unknown> | null }).session;
}

describe("handing out a due run", () => {
  test("carries a grant for the writer on the routine's workspace, and is audited by path", async () => {
    const f = await routineFixture();
    await dailyRoutine(f);
    const runs = await due(f.t);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ path: DAILY, timeZone: "America/New_York", send: "text" });
    expect(runs[0]!.accessToken).toMatch(/^cat_/);

    const grant = await f.t.run(async (ctx) =>
      (await ctx.db.query("oauthGrants").collect()).find((row) => row.clientId === "context_routines"),
    );
    expect(grant).toMatchObject({ workspaceId: f.workspaceId, userId: f.editor, status: "active" });
    expect(grant!.hashedAccessToken).toBe(await hashToken(runs[0]!.accessToken));
    // An editor's grant reaches what an editor reaches, and no further.
    expect(grant!.scopes).not.toContain("context:private");
    const resolved = await session(f, runs[0]!.accessToken);
    expect(resolved).not.toBeNull();

    const audit = await f.t.run((ctx) =>
      ctx.db.query("auditEvents").withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId)).collect(),
    );
    const run = audit.find((event) => event.action === "routine.run");
    expect(run).toMatchObject({ actorUserId: f.editor, actorClientId: "context_routines", details: { path: DAILY } });
    expect(JSON.stringify(audit)).not.toContain("Summarize");
  });

  test("a claim moves the next run on, and a live lease is not claimed twice", async () => {
    const f = await routineFixture();
    await dailyRoutine(f);
    const first = await due(f.t);
    expect(first).toHaveLength(1);
    const claimed = await rowAt(f.t, f.workspaceId, DAILY);
    expect(claimed!.nextRunAt).toBeGreaterThan(Date.now());
    expect(claimed!.lastRunAt).toBeLessThanOrEqual(Date.now());
    // Nothing more is due, and the next slot arriving inside the lease waits.
    expect(await due(f.t)).toHaveLength(0);
    await makeDue(f.t, f.workspaceId, DAILY);
    expect(await due(f.t)).toHaveLength(0);

    // The result releases it, and ends the run's token.
    const result = await agentPost(f.t, "/agent-texts/routines/result", {
      runId: first[0]!.runId,
      outcome: "answered",
      texted: 1,
    });
    expect(result.body).toEqual({ status: "recorded" });
    expect(await session(f, first[0]!.accessToken)).toBeNull();
    const again = await due(f.t);
    expect(again).toHaveLength(1);
    expect(again[0]!.runId).not.toBe(first[0]!.runId);
  });

  test("a lease that lapsed without a result can be claimed again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await routineFixture();
    await dailyRoutine(f);
    expect(await due(f.t)).toHaveLength(1);
    await makeDue(f.t, f.workspaceId, DAILY);
    vi.setSystemTime(Date.now() + ROUTINE_LEASE_MS + 1000);
    await makeDue(f.t, f.workspaceId, DAILY);
    expect(await due(f.t)).toHaveLength(1);
  });

  test("a writer who lost write access is not run", async () => {
    const f = await routineFixture();
    await dailyRoutine(f);
    await f.t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.workspaceId).eq("userId", f.editor))
        .unique();
      await ctx.db.delete(membership!._id);
    });
    expect(await due(f.t)).toEqual([]);
    expect(await rowAt(f.t, f.workspaceId, DAILY)).toMatchObject({ nextRunAt: null, lastOutcome: "writer_gone" });
    const grants = await f.t.run((ctx) => ctx.db.query("oauthGrants").collect());
    expect(grants.filter((grant) => grant.clientId === "context_routines")).toHaveLength(0);
  });

  test("a routine's grant leaves the texting grant alone", async () => {
    const f = await routineFixture();
    await dailyRoutine(f, f.owner);
    const textsToken = "cat_texts-token-for-this-test-only";
    // The same (workspace, person) pair the routine runs on: the case where
    // "one grant per pair" would have been one grant for both clients.
    await f.t.run(async (ctx) => {
      await ctx.db.insert("oauthClients", {
        clientId: "context_texts",
        clientName: "Texts (iMessage)",
        redirectUris: [],
        hashedClientSecret: null,
        tokenEndpointAuthMethod: "none",
        grantTypes: [],
        responseTypes: [],
        createdAt: Date.now(),
      });
      await ctx.db.insert("oauthGrants", {
        workspaceId: f.workspaceId,
        userId: f.owner,
        clientId: "context_texts",
        scopes: ["context:read", "context:write", "context:private"],
        hashedRefreshToken: await hashToken("unissued-refresh-for-this-test"),
        hashedAccessToken: await hashToken(textsToken),
        accessTokenExpiresAt: Date.now() + 10 * 60 * 1000,
        status: "active",
        createdAt: Date.now(),
      });
    });
    const runs = await due(f.t);
    expect(runs).toHaveLength(1);
    expect(await session(f, textsToken)).not.toBeNull();
    expect(await session(f, runs[0]!.accessToken)).not.toBeNull();
    const grants = await f.t.run((ctx) => ctx.db.query("oauthGrants").collect());
    expect(grants.map((grant) => grant.clientId).sort()).toEqual(["context_routines", "context_texts"]);
  });

  test("runs for one writer in one call share their token, and other writers get their own", async () => {
    const f = await routineFixture();
    f.backend.seed(DAILY, DAILY_TEXT);
    f.backend.seed("routines/daily/second.md", DAILY_TEXT);
    f.backend.seed("routines/daily/owners.md", DAILY_TEXT);
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: [DAILY, "routines/daily/second.md"] });
    await signal(f.t, { workspaceId: f.workspaceId, userId: f.owner, paths: ["routines/daily/owners.md"] });
    for (const path of [DAILY, "routines/daily/second.md", "routines/daily/owners.md"]) {
      await makeDue(f.t, f.workspaceId, path);
    }
    const runs = await due(f.t);
    expect(runs).toHaveLength(3);
    const byPath = new Map(runs.map((run) => [run.path, run.accessToken]));
    expect(byPath.get(DAILY)).toBe(byPath.get("routines/daily/second.md"));
    expect(byPath.get(DAILY)).not.toBe(byPath.get("routines/daily/owners.md"));
    for (const token of byPath.values()) expect(await session(f, token)).not.toBeNull();
  });
});

describe("who a run texts", () => {
  test("the people `to:` names who are members with a phone, and nobody else", async () => {
    const f = await routineFixture();
    await linkPhone(f.t, f.member, "+15555550101");
    await linkPhone(f.t, f.stranger, "+15555550102");
    await linkPhone(f.t, f.editor, "+15555550103");
    await dailyRoutine(f, f.owner, "---\nto: @studio-cy, @studio-dee, @studio-ada, @nobody-here\n---\nGo.\n");
    const runs = await due(f.t);
    // The stranger has a phone but is not in the workspace; the owner is but has none.
    expect(runs[0]!.phones).toEqual(["+15555550101"]);
  });

  test("a shared routine nobody was seen writing texts nobody, and runs once someone who can write saves it", async () => {
    // Reported 2026-10-18: one person's routine, its writer unseen, ran as
    // the shared workspace's owner and texted them what the other had asked for.
    const f = await routineFixture();
    await linkPhone(f.t, f.owner, "+15555550100");
    await linkPhone(f.t, f.editor, "+15555550103");
    // The editor's own signal was lost: the only one that arrives names a
    // member, who cannot be a writer, so nobody is known to have written it.
    await dailyRoutine(f, f.member, "---\nto: @studio-bo\n---\nText me everything in 4-archive.\n");
    expect(await rowAt(f.t, f.workspaceId, DAILY)).toMatchObject({ writerSource: "fallback", lastOutcome: "writer_unknown" });
    // Even made due, as a clock or an older row would: handed to nobody, and stopped again.
    expect(await due(f.t)).toEqual([]);
    expect(await rowAt(f.t, f.workspaceId, DAILY)).toMatchObject({ nextRunAt: null });

    // Once someone who can write is seen saving it, it is theirs, `to:` and all.
    await dailyRoutine(f, f.editor, "---\nto: @studio-bo\n---\nText me everything in 4-archive.\n");
    const row = await rowAt(f.t, f.workspaceId, DAILY);
    expect(row).toMatchObject({ writerUserId: f.editor, writerSource: "signal" });
    expect(row!.lastOutcome).toBeUndefined();
    expect((await due(f.t))[0]!.phones).toEqual(["+15555550103"]);
  });

  test("a shared routine left running as its owner by an earlier rule is stopped when it comes due", async () => {
    const f = await routineFixture();
    await linkPhone(f.t, f.owner, "+15555550100");
    await dailyRoutine(f, f.editor);
    const row = await rowAt(f.t, f.workspaceId, DAILY);
    // As a row written before the rule looked: the owner, by fallback, due now.
    await f.t.run((ctx) =>
      ctx.db.patch(row!._id, { writerUserId: f.owner, writerSource: "fallback", nextRunAt: Date.now() - 1000 }),
    );
    expect(await due(f.t)).toEqual([]);
    expect(await rowAt(f.t, f.workspaceId, DAILY)).toMatchObject({ nextRunAt: null, lastOutcome: "writer_unknown" });
  });

  // The owner is the only writer here, which is what lets the fallback run as them: a personal
  // workspace shared with an editor is two writers, and the case below.
  test("a personal routine nobody was seen writing still texts its owner, whatever its `to:` says", async () => {
    const f = await routineFixture();
    const personal = await personalWorkspaceOf(f, f.owner);
    await seedStorageBinding(f.t, { workspaceId: personal, boundBy: f.owner, bucket: "personal-bucket" });
    const backend = seededBucket("personal-bucket");
    stubBuckets(f.backend, backend);
    await linkPhone(f.t, f.owner, "+15555550100");
    await linkPhone(f.t, f.editor, "+15555550103");
    backend.seed(DAILY, "---\nto: @studio-bo\n---\nGo.\n");
    await signal(f.t, { workspaceId: personal, paths: [DAILY] });
    expect(await rowAt(f.t, personal, DAILY)).toMatchObject({ writerUserId: f.owner, writerSource: "fallback" });
    await makeDue(f.t, personal, DAILY);
    expect((await due(f.t))[0]!.phones).toEqual(["+15555550100"]);
  });

  test("a personal workspace shared with an editor does not fall back to its owner either", async () => {
    // The fallback runs the routine with the writer's reach, and a personal
    // workspace with an editor has two people who could have written it: the
    // owner's private reach would then run words that may be the editor's.
    const f = await routineFixture();
    const personal = await personalWorkspaceOf(f, f.owner);
    await addMember(f.t, personal, f.editor, "editor", f.owner);
    await seedStorageBinding(f.t, { workspaceId: personal, boundBy: f.owner, bucket: "shared-personal-bucket" });
    const backend = seededBucket("shared-personal-bucket");
    stubBuckets(f.backend, backend);
    await linkPhone(f.t, f.owner, "+15555550100");
    backend.seed(DAILY, "---\nto: @studio-bo\n---\nGo.\n");
    await signal(f.t, { workspaceId: personal, paths: [DAILY] });
    expect(await rowAt(f.t, personal, DAILY)).toMatchObject({ writerSource: "fallback", lastOutcome: "writer_unknown" });
    await makeDue(f.t, personal, DAILY);
    expect(await due(f.t)).toEqual([]);
  });

  test("the writer by default, and nobody for `send: note`", async () => {
    const f = await routineFixture();
    await linkPhone(f.t, f.editor, "+15555550103");
    await dailyRoutine(f);
    expect((await due(f.t))[0]!.phones).toEqual(["+15555550103"]);

    const g = await routineFixture();
    await linkPhone(g.t, g.editor, "+15555550103");
    await dailyRoutine(g, g.editor, "---\nsend: note\n---\nGo.\n");
    const runs = await due(g.t);
    expect(runs[0]).toMatchObject({ send: "note", phones: [] });
  });
});

describe("hearing how it went", () => {
  test("only a known code is kept, and never any text", async () => {
    const f = await routineFixture();
    await dailyRoutine(f);
    const [run] = await due(f.t);
    const refused = await agentPost(f.t, "/agent-texts/routines/result", {
      runId: run!.runId,
      outcome: "Here is what changed in 1-projects today",
    });
    expect(refused.status).toBe(400);
    expect((await rowAt(f.t, f.workspaceId, DAILY))!.lastOutcome).toBeUndefined();

    const recorded = await agentPost(f.t, "/agent-texts/routines/result", {
      runId: run!.runId,
      outcome: "finished",
      texted: 2,
      answer: "The launch shipped on Tuesday",
    });
    expect(recorded.body).toEqual({ status: "recorded" });
    const row = await rowAt(f.t, f.workspaceId, DAILY);
    expect(row).toMatchObject({ lastOutcome: "finished" });
    expect(row!.claimedAt).toBeUndefined();
    const everything = JSON.stringify(await f.t.run(async (ctx) => [
      await ctx.db.query("routines").collect(),
      await ctx.db.query("auditEvents").collect(),
    ]));
    expect(everything).not.toContain("launch shipped");
    expect(everything).not.toContain("what changed");

    // A run id that was already answered, or never existed, changes nothing.
    const stale = await agentPost(f.t, "/agent-texts/routines/result", { runId: run!.runId, outcome: "failed" });
    expect(stale.body).toEqual({ status: "unknown" });
    expect((await rowAt(f.t, f.workspaceId, DAILY))!.lastOutcome).toBe("finished");
  });

  test("a routine that is gone schedules a re-read of the folder", async () => {
    const f = await routineFixture();
    await dailyRoutine(f);
    const [run] = await due(f.t);
    f.backend.objects.delete(DAILY);
    await agentPost(f.t, "/agent-texts/routines/result", { runId: run!.runId, outcome: "routine_gone", texted: 0 });
    const queued = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(queued.some((job) => job.name.includes("reconcileRoutines") && job.state.kind === "pending")).toBe(true);
  });

  test("the routes need the texting Worker's secret", async () => {
    const f = await routineFixture();
    for (const path of ["/agent-texts/routines/due", "/agent-texts/routines/result"]) {
      const response = await gatewayPost(f.t, path, {});
      expect(response.status).toBe(401);
    }
  });
});

describe("the app", () => {
  test("shows the last outcome and the writer's handle", async () => {
    const f = await routineFixture();
    await dailyRoutine(f);
    const [run] = await due(f.t);
    await agentPost(f.t, "/agent-texts/routines/result", { runId: run!.runId, outcome: "skipped", texted: 0 });
    const view = await asUser(f.t, f.owner).query(api.functions.routines.routineForNote, {
      workspaceId: f.workspaceId,
      path: DAILY,
    });
    expect(view).toMatchObject({ lastOutcome: "skipped", writer: "@studio-bo" });
    expect(view!.lastRunAt).toEqual(expect.any(Number));
  });
});
