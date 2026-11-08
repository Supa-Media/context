/**
 * Feature flags reaching the person objects (`functions/flagObjects.ts`, `apps/mcp/src/workspaceStore/personFlags.js`):
 * a change staff make is pushed at once to the people it touches, through the gateway's real door into real person
 * objects; the hourly reconcile writes only where a set moved; and a person not yet answered by their object gets
 * their set in the control plane's session instead.
 *
 * Sabotage (temporary local edits, reverted): dropping `pushTo` from `addFlagPerson` fails "is pushed at once";
 * `onlyIfMoved` ignored in `pushPersonFlags` fails "writes only where the set moved"; leaving `flags` out of
 * `/gateway/session` fails the last test.
 */

import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@context/shared/src/flags.cjs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@context/shared/src/flags.cjs")>();
  const FLAGS = { "tex.sample": { label: "Sample", description: "A flag for this test.", added: "2026-11-01", expires: "2099-01-01" } };
  return { ...real, FLAGS, isFlagId: (value: unknown) => typeof value === "string" && value in FLAGS };
});

import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { handleWorkspaceStoreDoor } from "../../mcp/src/workspaceStore/door.js";
import { serveWorkspaceStore } from "../../mcp/src/workspaceStore/serve.js";
import { workspaceRows } from "../../mcp/src/workspaceStore/rows.js";
import { personRows } from "../../mcp/src/workspaceStore/personRows.js";
import { TEST_GATEWAY_SECRET, createUser, createWorkspace, gatewayPost, setupTest, type TestConvex } from "./fixtures.helpers";
import { ACCESS_A, bodyOf, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { withSession } from "./session.helpers";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const GATEWAY = "https://gateway.example.invalid";
const STAFF = "staff@example.invalid";

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...binds: unknown[]) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...(binds as never[]));
        return { toArray: () => all };
      }
      statement.run(...(binds as never[]));
      return { toArray: () => [] };
    },
  };
}

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = STAFF;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Real person objects behind the gateway's real door, counting each flags write. */
function objects(t: TestConvex) {
  const stores = new Map<string, { rows: ReturnType<typeof workspaceRows>; person: ReturnType<typeof personRows> }>();
  const env = {
    GATEWAY_SECRET: TEST_GATEWAY_SECRET,
    WORKSPACE_STORE: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        if (!stores.has(name)) {
          const sql = durableSql();
          stores.set(name, { rows: workspaceRows(sql), person: personRows(sql) });
        }
        const held = stores.get(name)!;
        return { fetch: (request: Request) => serveWorkspaceStore(held, request) };
      },
    },
  };
  const controlPlane = {
    async openTexStoreTicket(ticket: string) {
      const response = await gatewayPost(t, "/gateway/tex-store/open", { ticket });
      return ((await response.json()) as { opened: { workspaceId: string; owners: string[] } | null }).opened;
    },
  };
  let writes = 0;
  vi.stubEnv("STORAGE_MOVER_ORIGIN", GATEWAY);
  vi.stubEnv("GATEWAY_SECRET", TEST_GATEWAY_SECRET);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (!String(url).startsWith(`${GATEWAY}/internal/workspace-store`)) throw new Error(`unexpected fetch ${url}`);
    if (decodeURIComponent(new Headers(init.headers).get("x-tex-call") ?? "").includes("person.flags.put")) writes += 1;
    return await handleWorkspaceStoreDoor(new Request(url, init), env, { controlPlane });
  });
  return {
    flagsOf: (workspaceId: Id<"workspaces">) => (stores.get(`workspace:${workspaceId}`)?.person as unknown as { flags: { ids(): string[] } } | undefined)?.flags.ids() ?? null,
    writes: () => writes,
  };
}

/** A person whose access their object decides. */
async function switchedPerson(t: TestConvex, email: string, slug: string) {
  const userId = await createUser(t, email);
  const workspaceId = await createWorkspace(t, userId, slug);
  await t.run(async (ctx) => {
    const row = await ctx.db.query("workspaceObjectHomes").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
    if (row === null) await ctx.db.insert("workspaceObjectHomes", { workspaceId, home: "bucket", since: 1, personAccess: "object" } as never);
    else await ctx.db.patch(row._id, { personAccess: "object" });
  });
  return { userId, workspaceId };
}

/** Run the flag pushes the last change scheduled, by hand, and drop them from the queue. */
async function runPushes(t: TestConvex) {
  const jobs = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
  for (const job of jobs) {
    if (job.state.kind !== "pending") continue;
    if (job.name.includes("flagObjects:pushPeople")) await t.action(internal.functions.flagObjects.pushPeople, job.args[0] as never);
    else if (job.name.includes("flagObjects:reconcile")) await t.action(internal.functions.flagObjects.reconcile, job.args[0] as never);
    else continue;
    await t.run(async (ctx) => await ctx.scheduler.cancel(job._id));
  }
}

describe("flags in person objects", () => {
  // Scheduled pushes wait for `runPushes` (or are dropped, to stand for a lost push), never run on their own.
  beforeEach(() => void vi.useFakeTimers({ toFake: ["setTimeout"] }));
  afterEach(() => void vi.useRealTimers());

  test("a change is pushed at once to the person it touches, and taken back the same way", async () => {
    const t = setupTest();
    const staff = withSession(t, await createUser(t, STAFF));
    const ada = await switchedPerson(t, "ada@example.invalid", "ada");
    const bo = await switchedPerson(t, "bo@example.invalid", "bo");
    const world = objects(t);

    await staff.mutation(api.functions.featureFlags.setFlagMode, { flagId: "tex.sample", mode: "people" });
    await staff.mutation(api.functions.featureFlags.addFlagPerson, { flagId: "tex.sample", who: "ada@example.invalid" });
    await runPushes(t);
    expect(world.flagsOf(ada.workspaceId)).toEqual(["tex.sample"]);
    expect(world.flagsOf(bo.workspaceId)).toBeNull();

    await staff.mutation(api.functions.featureFlags.removeFlagPerson, { flagId: "tex.sample", userId: ada.userId });
    await runPushes(t);
    expect(world.flagsOf(ada.workspaceId)).toEqual([]);
  });

  test("a group's members, and everyone when a flag goes to or from everyone", async () => {
    const t = setupTest();
    const staff = withSession(t, await createUser(t, STAFF));
    const ada = await switchedPerson(t, "ada@example.invalid", "ada");
    const bo = await switchedPerson(t, "bo@example.invalid", "bo");
    const world = objects(t);
    const groupId = await staff.mutation(api.functions.featureFlags.createTesterGroup, { name: "Dogfood" });
    await staff.mutation(api.functions.featureFlags.addGroupPerson, { groupId, who: "bo@example.invalid" });
    await staff.mutation(api.functions.featureFlags.setFlagMode, { flagId: "tex.sample", mode: "people" });
    await staff.mutation(api.functions.featureFlags.addFlagGroup, { flagId: "tex.sample", groupId });
    await runPushes(t);
    expect(world.flagsOf(bo.workspaceId)).toEqual(["tex.sample"]);

    await staff.mutation(api.functions.featureFlags.setFlagMode, { flagId: "tex.sample", mode: "everyone" });
    await runPushes(t);
    expect([world.flagsOf(ada.workspaceId), world.flagsOf(bo.workspaceId)]).toEqual([["tex.sample"], ["tex.sample"]]);

    await staff.mutation(api.functions.featureFlags.setFlagMode, { flagId: "tex.sample", mode: "off" });
    await runPushes(t);
    expect([world.flagsOf(ada.workspaceId), world.flagsOf(bo.workspaceId)]).toEqual([[], []]);
  });

  test("the hourly reconcile writes only where the set moved", async () => {
    const t = setupTest();
    const staff = withSession(t, await createUser(t, STAFF));
    const ada = await switchedPerson(t, "ada@example.invalid", "ada");
    await switchedPerson(t, "bo@example.invalid", "bo");
    const world = objects(t);
    // A first pass writes everyone once (no set pushed yet), and a second writes nobody.
    await t.action(internal.functions.flagObjects.reconcile, {});
    const first = world.writes();
    expect(first).toBe(2);
    await t.action(internal.functions.flagObjects.reconcile, {});
    expect(world.writes()).toBe(first);
    // A change whose push was lost is caught by the next pass.
    await staff.mutation(api.functions.featureFlags.setFlagMode, { flagId: "tex.sample", mode: "people" });
    await staff.mutation(api.functions.featureFlags.addFlagPerson, { flagId: "tex.sample", who: "ada@example.invalid" });
    await t.action(internal.functions.flagObjects.reconcile, {});
    expect(world.writes()).toBe(first + 1);
    expect(world.flagsOf(ada.workspaceId)).toEqual(["tex.sample"]);
  });
});

test("/gateway/session carries the acting person's flags, and nobody else's", async () => {
  const { t } = await twoConnectedTenants();
  const staff = withSession(t, await createUser(t, STAFF));
  const flagsNow = async () => ((await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A }))) as { session: { flags: string[] } }).session.flags;
  expect(await flagsNow()).toEqual([]);
  await staff.mutation(api.functions.featureFlags.setFlagMode, { flagId: "tex.sample", mode: "people" });
  await staff.mutation(api.functions.featureFlags.addFlagPerson, { flagId: "tex.sample", who: "bob@example.invalid" });
  expect(await flagsNow()).toEqual([]);
  await staff.mutation(api.functions.featureFlags.addFlagPerson, { flagId: "tex.sample", who: "alice@example.invalid" });
  expect(await flagsNow()).toEqual(["tex.sample"]);
});
