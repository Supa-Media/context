/**
 * Shared fixtures for the blended search tests: two tenants, each with their own
 * bucket and fast search switched on. See blendedSearch.test.ts for the rules
 * these fixtures exist to exercise.
 */

import { vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  type TestConvex,
  copyTree,
  createUser,
  createWorkspace,
  setupTest,
} from "./fixtures.helpers";

/* -------------------------------------------------------------------------- */
/*                    the fan-out, through the control plane                  */
/* -------------------------------------------------------------------------- */

/**
 * Two tenants, each with their own bucket, both with fast search switched on.
 *
 * The buckets are addressed path-style, so one `fetch` stub can route by the
 * first path segment: a request for the wrong bucket reaches the wrong stub
 * and is answered `NoSuchBucket`, exactly as a provider would. That routing is
 * what lets the isolation tests below assert over one tenant's **recorded
 * requests** rather than over the response — a bucket that was read and then
 * omitted from the answer is still a bucket that was read.
 */
export interface Tenants {
  t: TestConvex;
  alice: Id<"users">;
  bob: Id<"users">;
  aliceWs: Id<"workspaces">;
  bobWs: Id<"workspaces">;
  aliceBucket: MemoryS3;
  bobBucket: MemoryS3;
}

export const ALICE_BUCKET = "alice-example-bucket";
export const BOB_BUCKET = "bob-example-bucket";

/** A word that appears only in Bob's private half. */
export const BOB_PRIVATE_WORD = "wallabyrate";
/** A word both tenants wrote about, so a blend has something to blend. */
export const SHARED_WORD = "quokkaplan";

export function seedBucket(bucket: MemoryS3, name: string): void {
  bucket.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  bucket.seed("index.md", `# ${name}\n`);
  bucket.seed("1-projects/README.md", "# Projects\n");
  bucket.seed("1-projects/plan.md", `# ${name} plan\n\nThe ${SHARED_WORD} ships in March.\n`);
  bucket.seed("2-areas/README.md", "# Areas\n");
}

export async function bindBucket(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  boundBy: Id<"users">,
  bucket: string,
): Promise<void> {
  const encryptedSecretAccessKey = await encryptSecret(
    FAKE_STORAGE.secretAccessKey,
    requireKeyset(),
    { workspaceId },
  );
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

/** A `searchIndexes` row in the one state `searchableContexts` accepts. */
export async function switchFastSearchOn(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  optedInBy: Id<"users">,
): Promise<void> {
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
      optedIn: true,
      optedInBy,
      optedInAt: now,
      status: "ready" as const,
      // Obviously fake, and never opened: this deployment has no Cloudflare
      // credential seeded, so `clientFor` returns null and every search falls
      // through to the R2 index in the customer's own bucket. That is the
      // honest arrangement for this file — the fan-out, the scope and the
      // privacy filter are what is under test, and they are identical either
      // way. `consoleSearch.test.ts` owns the projection's own behaviour.
      databaseId: "example0000d1000database000id00",
      databaseName: "context-search-example",
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Build the R2 shard index until it converges, so a search has one to read. */
export async function indexBucket(t: TestConvex, workspaceId: Id<"workspaces">): Promise<void> {
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

export async function twoTenants(): Promise<Tenants> {
  const t = setupTest();
  const alice = await createUser(t, "alice@example.invalid");
  const bob = await createUser(t, "bob@example.invalid");
  const aliceWs = await createWorkspace(t, alice, "alice-context");
  const bobWs = await createWorkspace(t, bob, "bob-context");

  const aliceBucket = memoryS3(ALICE_BUCKET);
  const bobBucket = memoryS3(BOB_BUCKET);
  seedBucket(aliceBucket, "Alice");
  seedBucket(bobBucket, "Bob");
  bobBucket.seed("2-areas/pay.md", `# Pay\n\nThe ${BOB_PRIVATE_WORD} is confidential.\n`);

  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const first = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
    if (first === BOB_BUCKET) return await bobBucket.fetchImpl(input, init);
    return await aliceBucket.fetchImpl(input, init);
  });

  await bindBucket(t, aliceWs, alice, ALICE_BUCKET);
  await bindBucket(t, bobWs, bob, BOB_BUCKET);
  // The census is the tree's names, not the bucket's listing (`keyedCensus.test.ts`): each tree copies its notes first.
  await copyTree(t, aliceWs);
  await copyTree(t, bobWs);
  await switchFastSearchOn(t, aliceWs, alice);
  await switchFastSearchOn(t, bobWs, bob);
  await indexBucket(t, aliceWs);
  await indexBucket(t, bobWs);

  return { t, alice, bob, aliceWs, bobWs, aliceBucket, bobBucket };
}
