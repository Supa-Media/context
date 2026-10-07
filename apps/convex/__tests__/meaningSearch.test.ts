/**
 * Search by meaning: a workspace's index is created, adopted, failed honestly,
 * and deleted before its row is forgotten.
 *
 * Cloudflare is a fake that records every request, so these are about what we
 * ask for and what the row says afterwards, never about Vectorize itself.
 *
 * Sabotage record (temporary local edits, reverted):
 *   the release forgetting the row before the delete      → "a failed delete keeps the row" fails
 *   the provisioner skipping the tier filter              → "an index is created with its tier filter" fails
 *   `enable` re-scheduling an already-enabled row         → "turning it on twice sets up once" fails
 *   the workspace cascade deleting the row directly       → "deleting a workspace releases its index" fails
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  asUser,
  createUser,
  createWorkspace,
  seedAppSecret,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { meaningIndexNameFor } from "../functions/lib/vectorize";

const TOKEN = "vectorize_operator_obviously_fake";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

async function configured(t: TestConvex) {
  await seedAppSecret(t, "SEARCH_D1_API_TOKEN", TOKEN);
  await seedAppSecret(t, "SEARCH_D1_ACCOUNT_ID", ACCOUNT);
}

async function workspace(t: TestConvex, slug: string) {
  const owner = await createUser(t, `${slug}-owner@example.com`);
  const workspaceId = await createWorkspace(t, owner, slug);
  return { owner, workspaceId };
}

async function row(t: TestConvex, workspaceId: Id<"workspaces">): Promise<Doc<"meaningIndexes"> | null> {
  return await t.run((ctx) =>
    ctx.db
      .query("meaningIndexes")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );
}

async function scheduledNames(t: TestConvex): Promise<string[]> {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs.filter((job) => job.state.kind === "pending").map((job) => job.name);
}

async function cancelScheduled(t: TestConvex) {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
}

interface Recorded {
  method: string;
  url: string;
  body: unknown;
  authorization: string | undefined;
}

/** A Cloudflare whose answers the test chooses per request. */
function stubCloudflare(answer: (request: Recorded) => { status: number; body: unknown }) {
  const requests: Recorded[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const request: Recorded = {
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
    };
    requests.push(request);
    const { status, body } = answer(request);
    return {
      ok: status < 400,
      status,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => body,
    };
  });
  return requests;
}

const ok = (result: unknown = {}) => ({ status: 200, body: { success: true, errors: [], result } });
const fail = (status: number, message = "nope") => ({
  status,
  body: { success: false, errors: [{ code: 1000, message }] },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("turning search by meaning on", () => {
  test("turning it on twice sets up once", async () => {
    const t = setupTest();
    const { workspaceId } = await workspace(t, "twice");
    const first = await t.mutation(internal.functions.meaningSearch.enable, { workspaceId });
    const second = await t.mutation(internal.functions.meaningSearch.enable, { workspaceId });
    expect(first.scheduled).toBe(true);
    expect(second.scheduled).toBe(false);
    expect((await scheduledNames(t)).filter((name) => name.includes("provisionMeaningIndex"))).toHaveLength(1);
    expect((await row(t, workspaceId))?.status).toBe("provisioning");
    await cancelScheduled(t);
  });

  test("a workspace that is gone gets no row", async () => {
    const t = setupTest();
    const { workspaceId } = await workspace(t, "gone");
    await t.run((ctx) => ctx.db.delete(workspaceId));
    const result = await t.mutation(internal.functions.meaningSearch.enable, { workspaceId });
    expect(result.scheduled).toBe(false);
    expect(await row(t, workspaceId)).toBeNull();
  });
});

describe("setting up the index", () => {
  test("an index is created with its tier filter, named after the workspace", async () => {
    const t = setupTest();
    await configured(t);
    const { workspaceId } = await workspace(t, "created");
    await t.mutation(internal.functions.meaningSearch.enable, { workspaceId });
    await cancelScheduled(t);
    const name = meaningIndexNameFor(workspaceId);
    const requests = stubCloudflare((request) => {
      if (request.url.endsWith("/metadata_index/list")) return ok({ metadataIndexes: [] });
      if (request.url.endsWith("/vectorize/v2/indexes")) return ok({ name });
      return ok({});
    });

    const result = await t.action(internal.functions.meaningProvision.provisionMeaningIndex, { workspaceId });

    expect(result.status).toBe("backfilling");
    const create = requests.find((request) => request.url.endsWith(`/accounts/${ACCOUNT}/vectorize/v2/indexes`));
    expect(create?.method).toBe("POST");
    expect(create?.body).toMatchObject({ name, config: { dimensions: 1024, metric: "cosine" } });
    const filter = requests.find((request) => request.url.endsWith("/metadata_index/create"));
    expect(filter?.body).toEqual({ propertyName: "tier", indexType: "string" });
    for (const request of requests) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.url).not.toContain(TOKEN);
    }
    const after = await row(t, workspaceId);
    expect(after?.status).toBe("backfilling");
    expect(after?.indexName).toBe(name);
    expect(after?.notesIndexed).toBe(0);
  });

  test("an index that already has our name is adopted, not refused", async () => {
    const t = setupTest();
    await configured(t);
    const { workspaceId } = await workspace(t, "adopted");
    await t.mutation(internal.functions.meaningSearch.enable, { workspaceId });
    await cancelScheduled(t);
    const name = meaningIndexNameFor(workspaceId);
    stubCloudflare((request) => {
      if (request.method === "POST" && request.url.endsWith("/vectorize/v2/indexes")) return fail(409, "already exists");
      if (request.method === "GET" && request.url.endsWith(`/indexes/${name}`)) return ok({ name });
      if (request.url.endsWith("/metadata_index/list")) return ok({ metadataIndexes: [{ propertyName: "tier" }] });
      return ok({});
    });
    const result = await t.action(internal.functions.meaningProvision.provisionMeaningIndex, { workspaceId });
    expect(result.status).toBe("backfilling");
    expect((await row(t, workspaceId))?.indexName).toBe(name);
  });

  test("no credential records NOT_CONFIGURED and asks Cloudflare nothing", async () => {
    const t = setupTest();
    const { workspaceId } = await workspace(t, "unconfigured");
    await t.mutation(internal.functions.meaningSearch.enable, { workspaceId });
    await cancelScheduled(t);
    const requests = stubCloudflare(() => ok());
    await t.action(internal.functions.meaningProvision.provisionMeaningIndex, { workspaceId });
    expect(requests).toHaveLength(0);
    const after = await row(t, workspaceId);
    expect(after?.status).toBe("failed");
    expect(after?.errorCode).toBe("NOT_CONFIGURED");
  });

  test("a refused token fails with our words, not Cloudflare's", async () => {
    const t = setupTest();
    await configured(t);
    const { workspaceId } = await workspace(t, "refused");
    await t.mutation(internal.functions.meaningSearch.enable, { workspaceId });
    await cancelScheduled(t);
    stubCloudflare(() => fail(403, `token ${TOKEN} lacks vectorize on account ${ACCOUNT}`));
    await t.action(internal.functions.meaningProvision.provisionMeaningIndex, { workspaceId });
    const after = await row(t, workspaceId);
    expect(after?.status).toBe("failed");
    expect(after?.errorCode).toBe("UNAUTHORIZED");
    expect(after?.error).not.toContain(TOKEN);
    expect(after?.error).not.toContain(ACCOUNT);
  });

  test("a Cloudflare that is down is retried, not failed", async () => {
    const t = setupTest();
    await configured(t);
    const { workspaceId } = await workspace(t, "down");
    await t.mutation(internal.functions.meaningSearch.enable, { workspaceId });
    await cancelScheduled(t);
    stubCloudflare(() => fail(503));
    const result = await t.action(internal.functions.meaningProvision.provisionMeaningIndex, { workspaceId });
    expect(result.status).toBe("provisioning");
    expect((await row(t, workspaceId))?.status).toBe("provisioning");
    expect((await scheduledNames(t)).some((name) => name.includes("provisionMeaningIndex"))).toBe(true);
    await cancelScheduled(t);
  });

  test("turned off before it ran, it creates nothing", async () => {
    const t = setupTest();
    await configured(t);
    const { workspaceId } = await workspace(t, "raced");
    await t.mutation(internal.functions.meaningSearch.enable, { workspaceId });
    await t.mutation(internal.functions.meaningSearch.disable, { workspaceId });
    await cancelScheduled(t);
    const requests = stubCloudflare(() => ok());
    const result = await t.action(internal.functions.meaningProvision.provisionMeaningIndex, { workspaceId });
    expect(result.status).toBe("skipped");
    expect(requests).toHaveLength(0);
  });
});

describe("turning it off", () => {
  async function ready(t: TestConvex, slug: string) {
    const { owner, workspaceId } = await workspace(t, slug);
    await t.mutation(internal.functions.meaningSearch.enable, { workspaceId });
    await t.mutation(internal.functions.meaningSearch.recordProvisionResult, {
      workspaceId,
      status: "ready",
      indexName: meaningIndexNameFor(workspaceId),
    });
    await cancelScheduled(t);
    return { owner, workspaceId };
  }

  test("the index is deleted, then the row is forgotten", async () => {
    const t = setupTest();
    await configured(t);
    const { workspaceId } = await ready(t, "off");
    expect((await t.mutation(internal.functions.meaningSearch.disable, { workspaceId })).releasing).toBe(true);
    await cancelScheduled(t);
    expect((await row(t, workspaceId))?.status).toBe("releasing");
    const requests = stubCloudflare(() => ok());
    const result = await t.action(internal.functions.meaningProvision.releaseMeaningIndex, { workspaceId });
    expect(result.released).toBe(true);
    expect(requests.map((request) => request.method)).toEqual(["DELETE"]);
    expect(requests[0].url).toContain(`/vectorize/v2/indexes/${meaningIndexNameFor(workspaceId)}`);
    expect(await row(t, workspaceId)).toBeNull();
  });

  test("an index that is already gone counts as deleted", async () => {
    const t = setupTest();
    await configured(t);
    const { workspaceId } = await ready(t, "already-gone");
    await t.mutation(internal.functions.meaningSearch.disable, { workspaceId });
    await cancelScheduled(t);
    stubCloudflare(() => fail(404));
    expect((await t.action(internal.functions.meaningProvision.releaseMeaningIndex, { workspaceId })).released).toBe(true);
    expect(await row(t, workspaceId)).toBeNull();
  });

  test("a failed delete keeps the row", async () => {
    const t = setupTest();
    await configured(t);
    const { workspaceId } = await ready(t, "kept");
    await t.mutation(internal.functions.meaningSearch.disable, { workspaceId });
    await cancelScheduled(t);
    stubCloudflare(() => fail(503));
    expect((await t.action(internal.functions.meaningProvision.releaseMeaningIndex, { workspaceId })).released).toBe(false);
    const after = await row(t, workspaceId);
    expect(after?.status).toBe("releasing");
    expect(after?.indexName).toBe(meaningIndexNameFor(workspaceId));
  });

  test("turned back on mid-release, the index is kept", async () => {
    const t = setupTest();
    await configured(t);
    const { workspaceId } = await ready(t, "back-on");
    await t.mutation(internal.functions.meaningSearch.disable, { workspaceId });
    await t.mutation(internal.functions.meaningSearch.enable, { workspaceId });
    await cancelScheduled(t);
    const requests = stubCloudflare(() => ok());
    expect((await t.action(internal.functions.meaningProvision.releaseMeaningIndex, { workspaceId })).released).toBe(false);
    expect(requests).toHaveLength(0);
    expect((await row(t, workspaceId))?.enabled).toBe(true);
  });

  test("a late provision result for a turned-off row still records the index name", async () => {
    const t = setupTest();
    const { workspaceId } = await workspace(t, "late-name");
    await t.mutation(internal.functions.meaningSearch.enable, { workspaceId });
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("meaningIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      await ctx.db.patch(existing!._id, { enabled: false, status: "releasing" });
    });
    await t.mutation(internal.functions.meaningSearch.recordProvisionResult, {
      workspaceId,
      status: "ready",
      indexName: "context-meaning-late",
    });
    await cancelScheduled(t);
    const after = await row(t, workspaceId);
    expect(after?.status).toBe("releasing");
    expect(after?.indexName).toBe("context-meaning-late");
  });

  test("deleting a workspace releases its index", async () => {
    const t = setupTest();
    const owner = await createUser(t, "teardown-owner@example.com");
    const workspaceId = await createWorkspace(t, owner, "teardown", { kind: "shared" });
    await t.mutation(internal.functions.meaningSearch.enable, { workspaceId });
    await t.mutation(internal.functions.meaningSearch.recordProvisionResult, {
      workspaceId,
      status: "ready",
      indexName: meaningIndexNameFor(workspaceId),
    });
    await cancelScheduled(t);
    await asUser(t, owner).mutation(api.functions.account.deleteWorkspace, {
      workspaceId,
      confirmSlug: "teardown",
    });
    const after = await row(t, workspaceId);
    expect(after?.status).toBe("releasing");
    expect(after?.enabled).toBe(false);
    expect((await scheduledNames(t)).some((name) => name.includes("releaseMeaningIndex"))).toBe(true);
    await cancelScheduled(t);
  });
});

describe("naming", () => {
  test("the name is the workspace id, whole, and refuses what will not fit", () => {
    expect(meaningIndexNameFor("j57abc")).toBe("context-meaning-j57abc");
    expect(() => meaningIndexNameFor("")).toThrow();
    expect(() => meaningIndexNameFor("J57ABC")).toThrow();
    expect(() => meaningIndexNameFor("a".repeat(60))).toThrow();
  });
});
