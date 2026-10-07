import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { MAX_SEARCH_MS } from "../functions/lib/searchTiming";
import { SEARCH_TIMING_RETENTION_MS } from "../functions/searchTimings";
import { summarize } from "../functions/lib/adminFns/searchReport";
import { memoryS3 } from "./storeStub.helpers";
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

/**
 * THE SEARCH TIMING LOG, AND THE SEARCH TAB THAT READS IT.
 *
 * "Make sure that we are able to track the average search latency" (the
 * owner, 2026-10-07). Every surface writes a row: the app's palette and the
 * search page from the control plane, the device's own wait through
 * `reportScreen`, and AI clients through the gateway's `/gateway/search-timing`.
 *
 * What matters most is what a row cannot hold. A search is the clearest record
 * there is of what somebody is looking for in their own notes, so every test
 * that writes a row also asserts its exact set of fields: there is nowhere for
 * the words to go.
 */

const ADMIN = "staff@example.invalid";
const BUCKET = "timing-example-bucket";
const WORD = "quokkaplan";
const ROW_FIELDS = ["_creationTime", "_id", "answeredBy", "at", "found", "ms", "surface", "workspaceId"];

afterEach(() => {
  vi.unstubAllGlobals();
});

async function rows(t: TestConvex) {
  return await t.run((ctx) => ctx.db.query("searchTimings").collect());
}

/** One workspace with a real (in-memory) bucket and a built shard index. */
async function withBucket() {
  const t = setupTest();
  const ada = await createUser(t, "ada@example.invalid");
  const workspaceId = await createWorkspace(t, ada, "ada-context");
  const bucket = memoryS3(BUCKET);
  bucket.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  bucket.seed("index.md", "# Ada\n");
  bucket.seed("1-projects/README.md", "# Projects\n");
  bucket.seed("1-projects/plan.md", `# Plan\n\nThe ${WORD} ships in March.\n`);
  vi.stubGlobal("fetch", bucket.fetchImpl);
  const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), { workspaceId });
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: BUCKET,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: ada,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  for (let pass = 0; pass < 12; pass += 1) {
    const result = await t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private" as const,
      operation: { kind: "maintainIndex" as const },
    });
    if (result.kind === "indexMaintained" && result.complete) break;
  }
  return { t, ada, workspaceId };
}

describe("the app's searches are timed on our side", () => {
  test("a palette search writes one row: which index answered, whether it found anything, and a time", async () => {
    const { t, ada, workspaceId } = await withBucket();
    const found = await asUser(t, ada).action(api.functions.files.searchContext, { workspaceId, query: WORD });
    expect(found.hits.length).toBeGreaterThan(0);
    const [row, ...rest] = await rows(t);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ workspaceId, surface: "app", answeredBy: "index", found: true });
    expect(row.ms).toBeGreaterThanOrEqual(0);
    expect(Object.keys(row).sort()).toEqual(ROW_FIELDS);
    // The words typed are nowhere in it.
    expect(JSON.stringify(row)).not.toContain(WORD);
  });

  test("a search that finds nothing is timed as a miss", async () => {
    const { t, ada, workspaceId } = await withBucket();
    await asUser(t, ada).action(api.functions.files.searchContext, { workspaceId, query: "zzqxnotaword" });
    const [row] = await rows(t);
    expect(row).toMatchObject({ surface: "app", found: false });
  });

  test("the search page writes one row per workspace it asked", async () => {
    const { t, ada, workspaceId } = await withBucket();
    await asUser(t, ada).action(api.functions.files.searchContexts, { query: WORD });
    const written = await rows(t);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ workspaceId, surface: "page", answeredBy: "index", found: true });
    expect(JSON.stringify(written[0])).not.toContain(WORD);
  });
});

describe("what a person waited, reported by their device", () => {
  async function member() {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    const bo = await createUser(t, "bo@example.invalid");
    const workspaceId = await createWorkspace(t, ada, "ada-context");
    return { t, ada, bo, workspaceId };
  }

  test("a member's report is kept as an on-screen row, with nothing but the number", async () => {
    const { t, ada, workspaceId } = await member();
    expect(await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 412, found: true })).toBe(true);
    const [row] = await rows(t);
    expect(row).toMatchObject({ workspaceId, surface: "screen", found: true, ms: 412 });
    expect(row.answeredBy).toBeUndefined();
    expect(Object.keys(row).sort()).toEqual(ROW_FIELDS.filter((key) => key !== "answeredBy"));
  });

  test("somebody outside the workspace, or signed out, writes nothing and is told nothing", async () => {
    const { t, bo, workspaceId } = await member();
    expect(await asUser(t, bo).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 5, found: true })).toBe(false);
    expect(await t.mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 5, found: true })).toBe(false);
    expect(await rows(t)).toEqual([]);
  });

  test("a member of a shared workspace may report for it", async () => {
    const { t, ada, bo, workspaceId } = await member();
    await addMember(t, workspaceId, bo, "member", ada);
    expect(await asUser(t, bo).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 90, found: false })).toBe(true);
  });

  test("the device's number is clamped, not trusted", async () => {
    const { t, ada, workspaceId } = await member();
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 1e12, found: true });
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: -40, found: true });
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: Number.NaN, found: true });
    expect((await rows(t)).map((row) => row.ms).sort((a, b) => a - b)).toEqual([0, 0, MAX_SEARCH_MS]);
  });
});

describe("AI clients' searches, from the gateway", () => {
  async function post(t: TestConvex, body: Record<string, unknown>, secret?: string | null) {
    const response = await gatewayPost(t, "/gateway/search-timing", body, secret === undefined ? {} : { secret });
    return { status: response.status, body: response.status === 200 ? ((await response.json()) as { recorded: boolean }) : null };
  }

  test("a timing is kept as an AI row, and a field it does not know is dropped", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    const workspaceId = await createWorkspace(t, ada, "ada-context");
    const sent = await post(t, { workspaceId, answeredBy: "fast", found: true, ms: 180, query: WORD, path: "1-projects/plan.md" });
    expect(sent.body?.recorded).toBe(true);
    const [row] = await rows(t);
    expect(row).toMatchObject({ workspaceId, surface: "ai", answeredBy: "fast", found: true, ms: 180 });
    expect(Object.keys(row).sort()).toEqual(ROW_FIELDS);
    expect(JSON.stringify(row)).not.toContain(WORD);
    expect(JSON.stringify(row)).not.toContain("plan.md");
  });

  test("a malformed timing writes nothing", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    const workspaceId = await createWorkspace(t, ada, "ada-context");
    for (const body of [
      { workspaceId, answeredBy: "a sentence somebody typed", found: true, ms: 1 },
      { workspaceId, answeredBy: "fast", found: "yes", ms: 1 },
      { workspaceId, answeredBy: "fast", found: true, ms: "1" },
      { workspaceId: "not-an-id", answeredBy: "fast", found: true, ms: 1 },
      { answeredBy: "fast", found: true, ms: 1 },
    ]) {
      const sent = await post(t, body);
      expect(sent.status).toBe(200);
      expect(sent.body?.recorded).toBe(false);
    }
    expect(await rows(t)).toEqual([]);
  });

  test("without the gateway's secret, nothing is written", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    const workspaceId = await createWorkspace(t, ada, "ada-context");
    const wrong = await post(t, { workspaceId, answeredBy: "fast", found: true, ms: 1 }, "not-the-secret");
    const none = await post(t, { workspaceId, answeredBy: "fast", found: true, ms: 1 }, null);
    expect(wrong.status).not.toBe(200);
    expect(none.status).not.toBe(200);
    expect(await rows(t)).toEqual([]);
  });
});

describe("the log keeps a month", () => {
  test("rows past their retention are swept, newer ones kept", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    const workspaceId = await createWorkspace(t, ada, "ada-context");
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("searchTimings", { workspaceId, surface: "ai", answeredBy: "fast", found: true, ms: 1, at: now - SEARCH_TIMING_RETENTION_MS - 1000 });
      await ctx.db.insert("searchTimings", { workspaceId, surface: "ai", answeredBy: "fast", found: true, ms: 2, at: now - 1000 });
    });
    await t.mutation(internal.functions.searchTimings.purgeOldSearchTimings, {});
    expect((await rows(t)).map((row) => row.ms)).toEqual([2]);
  });
});

describe("the Search tab", () => {
  const DAY = 86_400_000;

  async function world() {
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    const t = setupTest();
    const staff = await createUser(t, ADMIN);
    const ada = await createUser(t, "ada@example.invalid");
    const bo = await createUser(t, "bo@example.invalid");
    const adaWs = await createWorkspace(t, ada, "ada", { kind: "personal" });
    const boWs = await createWorkspace(t, bo, "bo", { kind: "personal" });
    return { t, staff, ada, adaWs, boWs };
  }

  async function seed(
    t: TestConvex,
    workspaceId: Id<"workspaces">,
    row: { surface: "screen" | "app" | "page" | "ai"; ms: number; at: number; answeredBy?: "fast" | "index" | "scan" | "none" | "failed"; found?: boolean },
  ) {
    await t.run((ctx) =>
      ctx.db.insert("searchTimings", {
        workspaceId,
        surface: row.surface,
        ...(row.surface === "screen" ? {} : { answeredBy: row.answeredBy ?? "index" }),
        found: row.found ?? true,
        ms: row.ms,
        at: row.at,
      }),
    );
  }

  test("is staff only", async () => {
    const { t, ada } = await world();
    await expect(asUser(t, ada).query(api.functions.admin.searchReport, {})).rejects.toThrow();
    await expect(t.query(api.functions.admin.searchReport, {})).rejects.toThrow();
  });

  test("gives each view its own average, never mixing the device's rows with ours", async () => {
    const { t, staff, adaWs, boWs } = await world();
    const now = Date.now();
    // One app search, timed twice: 600 ms on the device, 400 ms on our side.
    await seed(t, adaWs, { surface: "screen", ms: 600, at: now - 1000 });
    await seed(t, adaWs, { surface: "app", ms: 400, at: now - 1000 });
    // The search page counts as the app, on our side.
    await seed(t, boWs, { surface: "page", ms: 200, at: now - 2000, answeredBy: "fast" });
    await seed(t, boWs, { surface: "ai", ms: 1000, at: now - 3000, answeredBy: "scan", found: false });
    await seed(t, boWs, { surface: "ai", ms: 3000, at: now - 4000, answeredBy: "index" });

    const report = await asUser(t, staff).query(api.functions.admin.searchReport, { days: 7, view: "app" });
    const byView = Object.fromEntries(report.views.map((entry) => [entry.view, entry]));
    expect(byView.screen).toMatchObject({ count: 1, avg: 600, workspaces: 1 });
    expect(byView.app).toMatchObject({ count: 2, avg: 300, p50: 200, p95: 400, workspaces: 2 });
    expect(byView.ai).toMatchObject({ count: 2, avg: 2000, p50: 1000, p95: 3000 });
    // The rest of the tab is the chosen view.
    expect(report.answeredBy.map((entry) => [entry.answeredBy, entry.count])).toEqual([
      ["fast", 1],
      ["index", 1],
    ]);
    expect(report.buckets).toHaveLength(7);
    expect(report.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(2);

    const ai = await asUser(t, staff).query(api.functions.admin.searchReport, { days: 7, view: "ai" });
    expect(ai.found.misses).toMatchObject({ count: 1, avg: 1000 });
    expect(ai.found.hits).toMatchObject({ count: 1, avg: 3000 });
    expect(ai.answeredBy.find((entry) => entry.answeredBy === "scan")?.misses).toBe(1);
    expect(ai.slowest.map((row) => [row.ms, row.workspace, row.surface])).toEqual([
      [3000, "bo", "ai"],
      [1000, "bo", "ai"],
    ]);
  });

  test("compares with the window before, and leaves out anything older", async () => {
    const { t, staff, adaWs } = await world();
    const now = Date.now();
    await seed(t, adaWs, { surface: "ai", ms: 500, at: now - 1000 });
    await seed(t, adaWs, { surface: "ai", ms: 900, at: now - 8 * DAY });
    await seed(t, adaWs, { surface: "ai", ms: 99_000, at: now - 20 * DAY });
    const report = await asUser(t, staff).query(api.functions.admin.searchReport, { days: 7, view: "ai" });
    const ai = report.views.find((entry) => entry.view === "ai")!;
    expect(ai).toMatchObject({ count: 1, avg: 500 });
    expect(ai.prior).toMatchObject({ count: 1, avg: 900 });
  });

  test("narrows to one workspace, and a name that is nobody's matches nothing", async () => {
    const { t, staff, adaWs, boWs } = await world();
    const now = Date.now();
    await seed(t, adaWs, { surface: "ai", ms: 100, at: now - 1000 });
    await seed(t, boWs, { surface: "ai", ms: 700, at: now - 1000 });
    const bo = await asUser(t, staff).query(api.functions.admin.searchReport, { view: "ai", workspace: "@BO" });
    expect(bo.workspace).toBe("bo");
    expect(bo.views.find((entry) => entry.view === "ai")).toMatchObject({ count: 1, avg: 700 });
    const nobody = await asUser(t, staff).query(api.functions.admin.searchReport, { view: "ai", workspace: "nobody" });
    expect(nobody.workspace).toBeNull();
    expect(nobody.views.every((entry) => entry.count === 0)).toBe(true);
  });

  test("a day is drawn by the hour", async () => {
    const { t, staff, adaWs } = await world();
    await seed(t, adaWs, { surface: "screen", ms: 300, at: Date.now() - 1000 });
    const report = await asUser(t, staff).query(api.functions.admin.searchReport, { days: 1 });
    expect(report.view).toBe("screen");
    expect(report.buckets).toHaveLength(24);
    expect(report.buckets[23].count).toBe(1);
    expect(report.answeredBy).toEqual([]);
  });
});

describe("summarize", () => {
  test("mean, median and 95th percentile by nearest rank", () => {
    expect(summarize([])).toEqual({ count: 0, avg: 0, p50: 0, p95: 0 });
    expect(summarize([300, 100, 200])).toEqual({ count: 3, avg: 200, p50: 200, p95: 300 });
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(summarize(hundred)).toMatchObject({ avg: 51, p50: 50, p95: 95 });
  });
});
