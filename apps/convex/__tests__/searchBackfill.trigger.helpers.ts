/**
 * The control-plane half of the search backfill fixtures: a context with a
 * provisioned index row, and the calls that drive and inspect its chain.
 *
 * Shared by `searchBackfill.test.ts` and `searchBackfillRecovery.test.ts`.
 */

import { vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { D1_ACCOUNT_SECRET, D1_TOKEN_SECRET } from "../functions/lib/d1";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import {
  FAKE_D1,
  FAKE_STORAGE,
  createUser,
  createWorkspace,
  seedAppSecret,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { d1AndBucketFetch, stubD1, type StubD1 } from "./searchBackfill.helpers";
import { memoryS3 } from "./storeStub.helpers";

/**
 * Every deployment `opted` stood up, so each test file's `afterEach` can put its
 * scheduler to bed.
 *
 * `convex-test` starts a `runAfter(0)` job on a **real** timer, and several
 * checks here deliberately end with one queued — asserting that a link was
 * scheduled is half the point of the file. Left alone, that timer fires during
 * whichever test is running by then, and reaches for `globalThis.fetch`, which
 * is that test's stub. The symptom is a check failing over statements sent by
 * a pass belonging to a context it has never heard of, and it passes when run
 * alone: the classic shape of a suite whose tests are not isolated.
 *
 * So every pending job is cancelled between tests. Cancelling rather than
 * draining, because draining would run work the test had just finished proving
 * should exist and had no intention of executing.
 */
const deployments: TestConvex[] = [];

export async function cancelPendingJobs(): Promise<void> {
  for (const t of deployments.splice(0)) {
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
  }
}

/** A context with a bucket, a provisioned index row, and the D1 credential set. */
export async function opted(
  options: { status?: Doc<"searchIndexes">["status"]; optedIn?: boolean; notes?: number } = {},
): Promise<{
  t: TestConvex;
  workspaceId: Id<"workspaces">;
  owner: Id<"users">;
  d1: StubD1;
  bucket: ReturnType<typeof memoryS3>;
}> {
  const t = setupTest();
  deployments.push(t);
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "quokka-notes");

  const bucket = memoryS3(FAKE_STORAGE.bucket);
  bucket.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  bucket.seed("index.md", "# Context\n");
  for (let n = 0; n < (options.notes ?? 3); n += 1) {
    bucket.seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nThe quokkaplan ships.\n`);
  }
  const d1 = stubD1();
  vi.stubGlobal("fetch", d1AndBucketFetch(d1, bucket.fetchImpl));

  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  await seedAppSecret(t, D1_TOKEN_SECRET, FAKE_D1.apiToken);
  await seedAppSecret(t, D1_ACCOUNT_SECRET, FAKE_D1.accountId);

  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: false,
      fastSearch: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("searchIndexes", {
      workspaceId,
      generation: "premium-v1",
      optedIn: options.optedIn ?? true,
      optedInBy: owner,
      optedInAt: now,
      status: options.status ?? "backfilling",
      databaseId: "example-database-0000",
      databaseName: "context-search-example",
      schemaVersion: 1,
      notesIndexed: 0,
      createdAt: now,
      updatedAt: now,
    });
  });
  return { t, workspaceId, owner, d1, bucket };
}

export function row(t: TestConvex, workspaceId: Id<"workspaces">) {
  return t.run(
    async (ctx) =>
      await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
  );
}

/** Jobs queued but not yet run, by function name. */
export async function queued(t: TestConvex, name: string) {
  const jobs = await t.run((ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return jobs.filter(
    (job) => job.name.includes(name) && job.state.kind === "pending",
  );
}

export async function project(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  passes = 4,
) {
  return await t.action(internal.functions.files.runFileOperation, {
    workspaceId,
    // Scope-blind, like `maintainIndex`: an index describes the bucket, and
    // the tier a note is copied at comes from `privacy.md` per note, never
    // from whoever happened to schedule the pass.
    scope: "private" as const,
    operation: { kind: "projectIndex" as const, passes },
  });
}
