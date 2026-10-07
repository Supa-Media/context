/**
 * Search by meaning's catch-up pass, as the control plane runs it: over a
 * bucket nothing has searched, at the tier `privacy.md` gives each note,
 * through the credential barrier, and restarted by the sweep when it stops.
 *
 * Cloudflare (Vectorize and Workers AI) is a fetch stub that records what it
 * was sent; the bucket is the in-memory S3 the other barrier tests use.
 *
 * Sabotage record (temporary local edits, reverted):
 *   the barrier falling through to open the bucket on a
 *     row that has no index to fill                         → "a row turned off is handed nothing, and no bucket is opened" fails
 *   `recordProgress` demoting a `ready` row to `backfilling` → "a ready index catching up stays ready" fails
 *   the sweep ignoring `enabled`                           → "the sweep restarts what stopped, and only that" fails
 *   the provisioner not scheduling the pass                → "provisioning schedules the first pass" fails
 *   the barrier not attaching the index to a search's store → "a console search through the barrier…" fails
 *   `meaningSearchDescriptor` recording NOT_CONFIGURED     → "a search with no credential searches words…" fails
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { D1_ACCOUNT_SECRET, D1_TOKEN_SECRET } from "../functions/lib/d1";
import { projectMeaningIndex } from "../functions/lib/fileOps/meaningProjection";
import { effectiveVisibility, PRIVACY_KEY } from "../functions/lib/privacy";
import { loadPrivacyState } from "../functions/lib/fileOps/privacyState";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import type { FileStore } from "../functions/lib/fileOps";
import { meaningTierFor } from "../../mcp/src/search/meaning/project.js";
import { MEANING_STATE_KEY } from "../../mcp/src/search/meaning/catchup.js";
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
import { memoryS3, memoryStore, type MemoryStore } from "./storeStub.helpers";

const DIMENSIONS = 1024;
const deployments: TestConvex[] = [];

afterEach(async () => {
  for (const t of deployments.splice(0)) {
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
  }
  vi.unstubAllGlobals();
});

interface Cloudflare {
  upserted: { id: string; metadata: { path: string; chunk: number; tier: string } }[];
  deleted: string[];
  embedded: number;
  fail: number | null;
  /** What `/query` answers, best first. */
  matches: string[];
  fetchImpl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
}

function cloudflare(next: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>): Cloudflare {
  const state: Cloudflare = {
    upserted: [],
    deleted: [],
    embedded: 0,
    fail: null,
    matches: [],
    fetchImpl: async (input, init = {}) => {
      const url = typeof input === "string" ? input : String(input);
      if (!url.startsWith("https://api.cloudflare.com/")) return await next(input, init);
      const respond = (result: unknown, status = 200) =>
        new Response(JSON.stringify(status === 200 ? { success: true, result } : { success: false, errors: [] }), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.includes("/ai/run/")) {
        const { text } = JSON.parse(String(init.body)) as { text: string[] };
        state.embedded += text.length;
        return respond({ shape: [text.length, DIMENSIONS], data: text.map(() => new Array(DIMENSIONS).fill(0.5)) });
      }
      if (state.fail !== null) return respond(null, state.fail);
      if (url.endsWith("/upsert")) {
        for (const line of String(init.body).split("\n").filter(Boolean)) state.upserted.push(JSON.parse(line));
        return respond({ mutationId: "m" });
      }
      if (url.endsWith("/query")) {
        return respond({
          matches: state.matches.map((path, i) => ({ id: `v${i}`, score: 0.9 - i * 0.05, metadata: { path, chunk: 0, tier: "team" } })),
        });
      }
      if (url.endsWith("/delete_by_ids")) {
        state.deleted.push(...(JSON.parse(String(init.body)) as { ids: string[] }).ids);
        return respond({ mutationId: "m" });
      }
      return respond({});
    },
  };
  return state;
}

function seedNotes(seed: (key: string, body: string) => void, count: number) {
  seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  seed("index.md", "# Context\n");
  seed("2-areas/README.md", "# Areas\n");
  for (let n = 0; n < count; n += 1) seed(`1-projects/note-${n}.md`, `# Note ${n}\n\nWe are hiring two engineers.\n`);
}

async function workspace(
  options: { status?: Doc<"meaningIndexes">["status"]; enabled?: boolean; notes?: number; secrets?: boolean } = {},
) {
  const t = setupTest();
  deployments.push(t);
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "meaning-notes");
  const bucket = memoryS3(FAKE_STORAGE.bucket);
  seedNotes((key, body) => bucket.seed(key, body), options.notes ?? 3);
  const cf = cloudflare(bucket.fetchImpl);
  vi.stubGlobal("fetch", cf.fetchImpl);
  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  if (options.secrets !== false) {
    await seedAppSecret(t, D1_TOKEN_SECRET, FAKE_D1.apiToken);
    await seedAppSecret(t, D1_ACCOUNT_SECRET, FAKE_D1.accountId);
  }
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("meaningIndexes", {
      workspaceId,
      enabled: options.enabled ?? true,
      enabledAt: 1_700_000_000_000,
      status: options.status ?? "backfilling",
      indexName: `context-meaning-${workspaceId}`,
      notesIndexed: 0,
      createdAt: now,
      updatedAt: now,
    });
  });
  return { t, workspaceId, bucket, cf };
}

const row = (t: TestConvex, workspaceId: Id<"workspaces">) =>
  t.run(
    async (ctx) =>
      await ctx.db
        .query("meaningIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
  );

const queued = (t: TestConvex, name: string) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) => job.state.kind === "pending" && job.name.includes(name),
    ),
  );

const pass = (t: TestConvex, workspaceId: Id<"workspaces">, passes = 0) =>
  t.action(internal.functions.files.runFileOperation, {
    workspaceId,
    scope: "private",
    operation: { kind: "projectMeaning", passes },
  });

describe("the pass itself", () => {
  test("embeds a bucket nothing has searched, at the tier privacy.md gives each note", async () => {
    const store = memoryStore() as MemoryStore & FileStore;
    seedNotes((key, body) => store.seed(key, body), 4);
    const upserted: { metadata: { path: string; tier: string } }[] = [];
    const client = {
      upsert: async (vectors: unknown[]) => {
        upserted.push(...(vectors as typeof upserted));
        return vectors.length;
      },
      deleteByIds: async (ids: string[]) => ids.length,
    };
    const embed = async (texts: string[]) => texts.map(() => new Array(DIMENSIONS).fill(0.5));

    let last = await projectMeaningIndex(store, { client, embed, generation: "g1" });
    for (let links = 1; last.moved && !last.ready && links < 10; links += 1) {
      last = await projectMeaningIndex(store, { client, embed, generation: "g1" });
    }
    expect(last.ready).toBe(true);
    expect(last.notesIndexed).toBe(6);
    expect(upserted.map((vector) => vector.metadata.path)).not.toContain(PRIVACY_KEY);

    const privacy = await loadPrivacyState(store);
    for (const vector of upserted) {
      const expected = meaningTierFor(effectiveVisibility(vector.metadata.path, privacy.rules, privacy.overrides));
      expect(vector.metadata.tier, vector.metadata.path).toBe(expected);
    }
    // The map lives with the other search plumbing in the customer's bucket.
    expect(JSON.parse(store.snapshot()[MEANING_STATE_KEY]).generation).toBe("g1");
  });
});

describe("through the barrier", () => {
  test("a pass fills the index and the row reaches ready", async () => {
    const { t, workspaceId, cf, bucket } = await workspace({ notes: 3 });
    const result = await pass(t, workspaceId, 5);
    expect(result).toMatchObject({ kind: "meaningProjected", ready: true, notesIndexed: 5 });
    expect(new Set(cf.upserted.map((vector) => vector.metadata.path)).size).toBe(5);
    const after = await row(t, workspaceId);
    expect(after?.status).toBe("ready");
    expect(after?.notesIndexed).toBe(5);
    expect(after?.notesPending).toBe(0);
    expect(JSON.parse(bucket.snapshot()[MEANING_STATE_KEY]).generation).toBe("1700000000000");
    // A finished pass schedules no next link.
    expect(await queued(t, "runFileOperation")).toHaveLength(0);
  });

  test("a row turned off is handed nothing, and no bucket is opened", async () => {
    const { t, workspaceId, bucket } = await workspace({ enabled: false, status: "releasing" });
    // Without a binding, opening the bucket would throw: the order is the guard.
    await t.run(async (ctx) => {
      for (const binding of await ctx.db.query("storageBindings").collect()) await ctx.db.delete(binding._id);
    });
    const result = await pass(t, workspaceId, 5);
    expect(result).toMatchObject({ kind: "meaningProjected", moved: false, embedded: 0 });
    expect(bucket.requests).toHaveLength(0);
  });

  test("with no credential the row says so, and nothing is opened", async () => {
    const { t, workspaceId, bucket } = await workspace({ secrets: false });
    await pass(t, workspaceId, 5);
    const after = await row(t, workspaceId);
    expect(after?.status).toBe("failed");
    expect(after?.errorCode).toBe("NOT_CONFIGURED");
    expect(bucket.requests).toHaveLength(0);
  });

  test("a blip is retried later and the row keeps waiting; a refusal lands on the row", async () => {
    const blip = await workspace();
    blip.cf.fail = 503;
    await pass(blip.t, blip.workspaceId, 5);
    expect((await row(blip.t, blip.workspaceId))?.status).toBe("backfilling");
    expect(await queued(blip.t, "runFileOperation")).toHaveLength(1);

    const refused = await workspace();
    refused.cf.fail = 403;
    await pass(refused.t, refused.workspaceId, 5);
    const after = await row(refused.t, refused.workspaceId);
    expect(after?.status).toBe("failed");
    expect(after?.errorCode).toBe("UNAUTHORIZED");
    expect(after?.error).not.toContain(FAKE_D1.apiToken);
  });

  test("a ready index catching up stays ready", async () => {
    const { t, workspaceId } = await workspace({ status: "ready" });
    await t.mutation(internal.functions.meaningSearch.recordProgress, {
      workspaceId,
      notesIndexed: 3,
      notesPending: 2,
      ready: false,
    });
    const after = await row(t, workspaceId);
    expect(after?.status).toBe("ready");
    expect(after?.notesPending).toBe(2);
  });

  test("provisioning schedules the first pass", async () => {
    const { t, workspaceId, cf } = await workspace({ status: "provisioning" });
    void cf;
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("meaningIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(existing!._id, { indexName: undefined });
    });
    await t.action(internal.functions.meaningProvision.provisionMeaningIndex, { workspaceId });
    expect((await row(t, workspaceId))?.status).toBe("backfilling");
    expect(await queued(t, "runFileOperation")).toHaveLength(1);
  });
});

describe("the sweep", () => {
  test("the sweep restarts what stopped, and only that", async () => {
    const t = setupTest();
    deployments.push(t);
    const long = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const rows: Array<Partial<Doc<"meaningIndexes">> & { slug: string }> = [
      { slug: "stalled", status: "backfilling", updatedAt: long },
      { slug: "fresh", status: "backfilling", updatedAt: Date.now() },
      { slug: "due-refresh", status: "ready", updatedAt: long },
      { slug: "switched-off", status: "backfilling", updatedAt: long, enabled: false },
      { slug: "waits", status: "failed", errorCode: "UNAVAILABLE", updatedAt: long },
      // Waiting cannot fix a refusal; somebody changing the credential can,
      // so it is tried again after hours rather than every sweep.
      { slug: "refused", status: "failed", errorCode: "UNAUTHORIZED", updatedAt: Date.now() - 60 * 60 * 1000 },
      { slug: "refused-long-ago", status: "failed", errorCode: "UNAUTHORIZED", updatedAt: long },
    ];
    for (const spec of rows) {
      const owner = await createUser(t, `${spec.slug}@example.invalid`);
      const workspaceId = await createWorkspace(t, owner, spec.slug);
      await t.run(async (ctx) => {
        await ctx.db.insert("meaningIndexes", {
          workspaceId,
          enabled: spec.enabled ?? true,
          enabledAt: 1,
          status: spec.status!,
          indexName: `context-meaning-${workspaceId}`,
          ...(spec.errorCode ? { errorCode: spec.errorCode } : {}),
          createdAt: 1,
          updatedAt: spec.updatedAt!,
        });
      });
    }
    const { started } = await t.mutation(internal.functions.meaningSearch.sweep, {});
    expect(started).toBe(4);
    expect(await queued(t, "runFileOperation")).toHaveLength(2);
    expect(await queued(t, "provisionMeaningIndex")).toHaveLength(2);
    // Touched, so the next sweep does not start a second chain.
    expect((await t.mutation(internal.functions.meaningSearch.sweep, {})).started).toBe(0);
  });
});

describe("a console search", () => {
  const search = (t: TestConvex, workspaceId: Id<"workspaces">, query: string) =>
    t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "search", query },
    });

  test("a console search through the barrier merges what the index found", async () => {
    const { t, workspaceId, bucket, cf } = await workspace({ status: "ready", notes: 2 });
    bucket.seed("2-areas/garden.md", "# Garden\n\nTomatoes by the fence.\n");
    await pass(t, workspaceId, 5);
    cf.matches = ["2-areas/garden.md"];
    const result = (await search(t, workspaceId, "hiring")) as {
      hits: { path: string; meaningOnly?: boolean }[];
    };
    expect(result.hits.filter((hit) => !hit.meaningOnly).length).toBeGreaterThan(0);
    expect(result.hits.find((hit) => hit.path === "2-areas/garden.md")?.meaningOnly).toBe(true);
  });

  test("a search with no credential searches words and leaves the row alone", async () => {
    const { t, workspaceId, cf } = await workspace({ status: "ready", notes: 2, secrets: false });
    await t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "maintainIndex" },
    }).catch(() => null);
    cf.matches = ["1-projects/note-0.md"];
    const result = (await search(t, workspaceId, "hiring")) as { hits: { meaningOnly?: boolean }[] };
    expect(result.hits.every((hit) => !hit.meaningOnly)).toBe(true);
    expect((await row(t, workspaceId))?.status).toBe("ready");
  });
});
