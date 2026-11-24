/**
 * SHEET SOURCES: a key that adds rows to one sheet, from anything that can POST.
 *
 * The happy path is one test. The rest vary what the key is asked to do
 * beyond its one power, and who stands behind it:
 *
 *  1. **One sheet.** A body naming another path still lands on the key's own
 *     sheet, and a second workspace with the same path is untouched.
 *  2. **Its maker's live authority.** Demoted to member, or removed, and the
 *     key stops, without anybody revoking it.
 *  3. **One refusal for everything about the key.** No header, a malformed
 *     key, an unknown one, a revoked one and one whose maker left are the
 *     same bytes, so a caller cannot tell a key taken back from one never made.
 *  4. **All or nothing.** Rows that do not fit the sheet write nothing, and a
 *     call that would only partly fit the hour's allowance spends none of it.
 *  5. **The key is never stored.** Only its hash, and no answer carries either.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { hashToken } from "../functions/lib/crypto";
import { ROWS_PER_HOUR } from "../functions/sheetSources";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  captureError,
  copyTree,
  createUser,
  createWorkspace,
  errorCode,
  responseFingerprint,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { renderPrivacyManifest } from "./seededRules.helpers";

vi.setConfig({ testTimeout: 60_000 });
afterEach(() => vi.unstubAllGlobals());

const SHEET = "areas/eng/metrics.csv";
const OTHER = "areas/eng/other.csv";
const HEADER = "date:date,metric,value:number\n";
const OTHER_BUCKET = "example-other-bucket";

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  editor: Id<"users">;
  member: Id<"users">;
  outsider: Id<"users">;
  workspaceId: Id<"workspaces">;
  otherWorkspaceId: Id<"workspaces">;
  backend: MemoryS3;
  otherBackend: MemoryS3;
}

function seedSheets(backend: MemoryS3) {
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para", [], "shared"));
  backend.seed("index.md", "# Atlas\n");
  backend.seed(SHEET, HEADER);
  backend.seed(OTHER, HEADER);
}

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const editor = await createUser(t, "editor@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  const outsider = await createUser(t, "outsider@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas", { kind: "shared" });
  const otherWorkspaceId = await createWorkspace(t, outsider, "borealis", { kind: "shared" });
  await addMember(t, workspaceId, editor, "editor");
  await addMember(t, workspaceId, member, "member");

  const backend = memoryS3(FAKE_STORAGE.bucket);
  const otherBackend = memoryS3(OTHER_BUCKET);
  seedSheets(backend);
  seedSheets(otherBackend);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return await (url.includes(`/${OTHER_BUCKET}`) ? otherBackend : backend).fetchImpl(input, init);
  });
  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  await seedStorageBinding(t, { workspaceId: otherWorkspaceId, boundBy: outsider, bucket: OTHER_BUCKET });
  await copyTree(t, workspaceId);
  await copyTree(t, otherWorkspaceId);
  return { t, owner, editor, member, outsider, workspaceId, otherWorkspaceId, backend, otherBackend };
}

async function mint(f: Fixture, userId: Id<"users">, path = SHEET, workspaceId = f.workspaceId) {
  return await asUser(f.t, userId).action(api.functions.sheetSources.create, { workspaceId, path, name: "CI timings" });
}

async function post(t: TestConvex, body: unknown, authorization: string | null): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authorization !== null) headers.Authorization = authorization;
  return await t.fetch("/api/sheets/rows", { method: "POST", headers, body: JSON.stringify(body) });
}

async function sheetText(f: Fixture, path = SHEET, workspaceId = f.workspaceId, as = f.owner): Promise<string> {
  const file = await asUser(f.t, as).action(api.functions.files.readNote, { workspaceId, path });
  return file.text;
}

const READING = { rows: [{ metric: "PR merge minutes", value: 42 }] };

describe("a sheet source", () => {
  test("adds rows to its sheet, filling today's date, and counts them", async () => {
    const f = await fixture();
    const { key, sourceId } = await mint(f, f.editor);
    expect(key).toMatch(/^ctxs_[A-Za-z0-9_-]{43}$/);

    const response = await post(f.t, { rows: [{ metric: "PR merge minutes", value: 42 }, { date: "2026-11-01", metric: "CI minutes", value: "9.5" }] }, `Bearer ${key}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ appended: 2 });

    const today = new Date().toISOString().slice(0, 10);
    const text = await sheetText(f);
    expect(text).toContain(`${today},PR merge minutes,42`);
    expect(text).toContain("2026-11-01,CI minutes,9.5");

    const listed = await asUser(f.t, f.owner).query(api.functions.sheetSources.list, { workspaceId: f.workspaceId, path: SHEET });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ sourceId, name: "CI timings", rowsAdded: 2 });
    expect(JSON.stringify(listed)).not.toContain(key);
  });

  test("one row on its own is accepted too", async () => {
    const f = await fixture();
    const { key } = await mint(f, f.owner);
    const response = await post(f.t, { metric: "Search p50 ms", value: 310 }, `Bearer ${key}`);
    expect(await response.json()).toEqual({ appended: 1 });
    expect(await sheetText(f)).toContain(",Search p50 ms,310");
  });

  test("only an editor who can open the sheet may make one, and only for a sheet", async () => {
    const f = await fixture();
    expect(errorCode(await captureError(() => mint(f, f.member)))).toBeDefined();
    expect(errorCode(await captureError(() => mint(f, f.outsider)))).toBeDefined();
    expect(errorCode(await captureError(() => mint(f, f.owner, "index.md")))).toBe("NOT_A_SHEET");
    expect(errorCode(await captureError(() => mint(f, f.owner, "areas/eng/missing.csv")))).toBe("FILE_NOT_FOUND");
  });

  test("stores the key's hash and never the key", async () => {
    const f = await fixture();
    const { key, sourceId } = await mint(f, f.owner);
    const row = await f.t.run((ctx) => ctx.db.get(sourceId));
    expect(row?.keyHash).toBe(await hashToken(key));
    expect(JSON.stringify(row)).not.toContain(key);
  });
});

describe("what a key cannot do", () => {
  test("a body naming another path still lands on the key's own sheet", async () => {
    const f = await fixture();
    const { key } = await mint(f, f.owner);
    const response = await post(f.t, { path: OTHER, workspaceId: f.otherWorkspaceId, rows: READING.rows }, `Bearer ${key}`);
    expect(response.status).toBe(200);
    expect(await sheetText(f)).toContain("PR merge minutes");
    expect(await sheetText(f, OTHER)).toBe(HEADER);
    expect(f.otherBackend.snapshot()[SHEET] ?? HEADER).toBe(HEADER);
    expect(await sheetText(f, SHEET, f.otherWorkspaceId, f.outsider)).toBe(HEADER);
  });

  test("no answer carries the sheet's other rows", async () => {
    const f = await fixture();
    const { key } = await mint(f, f.owner);
    await post(f.t, { rows: [{ metric: "secret-metric-name", value: 1 }] }, `Bearer ${key}`);
    const refused = await post(f.t, { rows: [{ metric: "x", value: "not a number" }] }, `Bearer ${key}`);
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain("secret-metric-name");
  });
});

describe("one refusal for everything about the key", () => {
  test("no key, a malformed one, an unknown one, a revoked one and one whose maker left look the same", async () => {
    const f = await fixture();
    const revoked = await mint(f, f.owner);
    await asUser(f.t, f.owner).mutation(api.functions.sheetSources.revoke, { sourceId: revoked.sourceId });
    const leaver = await mint(f, f.editor);
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.workspaceId).eq("userId", f.editor))
        .unique();
      if (row !== null) await ctx.db.delete(row._id);
    });
    const unknown = `ctxs_${"A".repeat(43)}`;

    const answers = await Promise.all(
      [null, "Bearer nope", `Basic ${unknown}`, `Bearer ${unknown}`, `Bearer ${revoked.key}`, `Bearer ${leaver.key}`].map(async (authorization) =>
        responseFingerprint(await post(f.t, READING, authorization)),
      ),
    );
    expect(answers[0]).toMatch(/^401\n/);
    expect(new Set(answers).size).toBe(1);
    expect(await sheetText(f)).toBe(HEADER);
  });

  test("a maker demoted to member takes the key's authority with them", async () => {
    const f = await fixture();
    const { key } = await mint(f, f.editor);
    expect((await post(f.t, READING, `Bearer ${key}`)).status).toBe(200);
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.workspaceId).eq("userId", f.editor))
        .unique();
      await ctx.db.patch(row!._id, { role: "member" });
    });
    expect((await post(f.t, READING, `Bearer ${key}`)).status).toBe(401);
  });

  test("revoking stops a key at once; its maker or an owner may, nobody else", async () => {
    const f = await fixture();
    const { key, sourceId } = await mint(f, f.editor);
    const second = await createUser(f.t, "second-editor@example.invalid");
    await addMember(f.t, f.workspaceId, second, "editor");
    for (const who of [f.member, second]) {
      expect(errorCode(await captureError(() => asUser(f.t, who).mutation(api.functions.sheetSources.revoke, { sourceId })))).toBeDefined();
    }
    expect((await post(f.t, READING, `Bearer ${key}`)).status).toBe(200);
    await asUser(f.t, f.owner).mutation(api.functions.sheetSources.revoke, { sourceId });
    expect((await post(f.t, READING, `Bearer ${key}`)).status).toBe(401);
    expect(await asUser(f.t, f.owner).query(api.functions.sheetSources.list, { workspaceId: f.workspaceId, path: SHEET })).toEqual([]);
  });

  test("an editor sees their own keys and an owner sees every one", async () => {
    const f = await fixture();
    await mint(f, f.owner);
    await mint(f, f.editor);
    const names = async (who: Id<"users">) =>
      (await asUser(f.t, who).query(api.functions.sheetSources.list, { workspaceId: f.workspaceId, path: SHEET })).length;
    expect(await names(f.owner)).toBe(2);
    expect(await names(f.editor)).toBe(1);
  });

  test("a name Markdown would read as syntax is refused", async () => {
    const f = await fixture();
    const made = captureError(() =>
      asUser(f.t, f.owner).action(api.functions.sheetSources.create, { workspaceId: f.workspaceId, path: SHEET, name: "[x](https://example.invalid)" }),
    );
    expect(errorCode(await made)).toBe("NAME_INVALID");
  });
});

describe("all or nothing", () => {
  test("rows that do not fit the sheet write nothing", async () => {
    const f = await fixture();
    const { key } = await mint(f, f.owner);
    const response = await post(f.t, { rows: [{ metric: "ok", value: 1 }, { metric: "bad", value: "many" }] }, `Bearer ${key}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("rows_refused");
    const unknownColumn = await post(f.t, { rows: [{ metric: "ok", value: 1, colour: "red" }] }, `Bearer ${key}`);
    expect(unknownColumn.status).toBe(400);
    expect(await sheetText(f)).toBe(HEADER);
  });

  test("a nested value is refused before anything is looked up", async () => {
    const f = await fixture();
    const { key } = await mint(f, f.owner);
    const response = await post(f.t, { rows: [{ metric: { $gt: "" }, value: 1 }] }, `Bearer ${key}`);
    expect(response.status).toBe(400);
    expect(await sheetText(f)).toBe(HEADER);
  });

  test("a call that would only partly fit the hour's allowance spends none of it", async () => {
    const f = await fixture();
    const { key, sourceId } = await mint(f, f.owner);
    await f.t.run((ctx) =>
      ctx.db.insert("rateLimits", { key: `sheet-source:${sourceId}`, windowStartedAt: Date.now(), count: ROWS_PER_HOUR - 1 }),
    );
    const two = await post(f.t, { rows: [{ metric: "a", value: 1 }, { metric: "b", value: 2 }] }, `Bearer ${key}`);
    expect(two.status).toBe(429);
    expect(await sheetText(f)).toBe(HEADER);
    const one = await post(f.t, { rows: [{ metric: "a", value: 1 }] }, `Bearer ${key}`);
    expect(one.status).toBe(200);
    expect((await post(f.t, READING, `Bearer ${key}`)).status).toBe(429);
  });
});
