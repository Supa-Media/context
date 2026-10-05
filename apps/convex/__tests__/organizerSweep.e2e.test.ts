/**
 * A WHOLE SWEEP, THROUGH THE CONTROL PLANE.
 *
 * `organizerEval.test.ts` scores the engine with the bucket in hand. This runs
 * the scheduled action itself — `organizer.runSweep` — the way production does:
 * the barrier (`authorizeFileAccess`, `runFileOperation`) against an S3 store
 * on a memory backend, Jev smarts' gate and meter, and the inference Worker's
 * real `/decide` route behind a stubbed `fetch`. Only the model is a stand-in.
 *
 * Dev2, 2026-10-05: "The last sort didn't finish. It couldn't read your notes."
 * The engine scored 100% with the real model the same hour, so whatever threw
 * was in this half, which no test ran end to end.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { handleRequest } from "../../../infra/transcribe-worker/src/index";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import { FAKE_STORAGE, type TestConvex, createUser, createWorkspace, setupTest } from "./fixtures.helpers";
import { NOTES, misses, organizationScore } from "./organizerEval/workspace.helpers";
import { type AiBinding, SECRET, knowsTheAnswers } from "./organizerEval/sweep.helpers";

const WORKER = "https://inference.example.invalid";
const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function premiumWorkspace(ai: AiBinding): Promise<{ t: TestConvex; workspaceId: Id<"workspaces">; backend: MemoryS3 }> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "northwind");
  // Saved when the fixture says, counted back from the real clock the sweep reads.
  const savedAt = new Map(NOTES.map((note) => [note.path, new Date(Date.now() - note.daysAgo * DAY)]));
  const backend = memoryS3(FAKE_STORAGE.bucket, { modifiedAt: (key) => savedAt.get(key) ?? new Date() });
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Northwind\n");
  for (const note of NOTES) backend.seed(note.path, note.text);

  vi.stubEnv("TRANSCRIBE_WORKER_URL", WORKER);
  vi.stubEnv("TRANSCRIBE_WORKER_SECRET", SECRET);
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(WORKER)) {
      return await handleRequest(new Request(url, init), { AI: ai, TRANSCRIBE_WORKER_SECRET: SECRET } as never);
    }
    return await backend.fetchImpl(input, init);
  });

  const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), { workspaceId });
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "connected" as const,
      lastVerifiedAt: now,
      boundBy: owner,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspacePlans", { workspaceId, managedStorage: false, fastSearch: false, status: "active", createdAt: now, updatedAt: now });
    await ctx.db.insert("organizerSettings", {
      workspaceId,
      noticeAt: now - 1,
      startsAt: now - 1,
      autopilot: { done: false, archive: false, file: false },
      pending: 0,
      updatedAt: now,
    });
  });
  return { t, workspaceId, backend };
}

async function sweepOf(t: TestConvex, workspaceId: Id<"workspaces">) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("organizerSettings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    return { sweep: row?.sweep ?? null, pending: row?.pending ?? 0 };
  });
}

describe("organizer.runSweep, end to end", () => {
  test("a Premium workspace's sweep reads its notes, asks, and finishes with suggestions waiting", async () => {
    const { t, workspaceId, backend } = await premiumWorkspace(knowsTheAnswers);
    await t.action(internal.functions.organizer.runSweep, { workspaceId, force: true });
    const { sweep, pending } = await sweepOf(t, workspaceId);
    expect(sweep, JSON.stringify(sweep)).toMatchObject({ state: "done" });
    expect(sweep!.total).toBeGreaterThan(0);
    expect(sweep!.read).toBe(sweep!.total);
    expect(pending).toBeGreaterThan(0);
    expect(Object.keys(backend.snapshot()).some((key) => key.startsWith(".context/organizer/"))).toBe(true);
  });
});

describe("organizer.runSweep, without asking", () => {
  test("with every kind switched on, the sweep organizes the workspace to 90% or better through the barrier", async () => {
    const { t, workspaceId, backend } = await premiumWorkspace(knowsTheAnswers);
    const before = organizationScore(backend.snapshot()).score;
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("organizerSettings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { autopilot: { done: true, archive: true, file: true } });
    });
    await t.action(internal.functions.organizer.runSweep, { workspaceId, force: true });
    const { sweep } = await sweepOf(t, workspaceId);
    expect(sweep, JSON.stringify(sweep)).toMatchObject({ state: "done" });
    const { score, items } = organizationScore(backend.snapshot());
    expect(score, misses(items)).toBeGreaterThanOrEqual(0.9);
    expect(score).toBeGreaterThan(before);
  });
});
