/**
 * A shared workspace with routine notes in an in-memory bucket, and the three
 * doors routines use: the gateway's signal, and the texting Worker's due and
 * result calls. Every person has a personal workspace, whose slug is their
 * handle, so `to: @handle` resolves the way the product resolves it.
 */

import { vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  addMember,
  createUser,
  createWorkspace,
  drainScheduled,
  gatewayPost,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

export const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";

export interface RoutineFixture {
  t: TestConvex;
  owner: Id<"users">;
  editor: Id<"users">;
  member: Id<"users">;
  stranger: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

/** Route each S3 request to the in-memory bucket its path names. */
export function stubBuckets(...backends: MemoryS3[]): void {
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    for (const backend of backends) {
      const response = await backend.fetchImpl(input, init);
      if (response.status !== 404 || !(await response.clone().text()).includes("NoSuchBucket")) return response;
    }
    return new Response("", { status: 404 });
  });
}

export async function routineFixture(
  options: { slug?: string; bucket?: string; stub?: boolean } = {},
): Promise<RoutineFixture> {
  const slug = options.slug ?? "studio";
  const t = setupTest();
  const owner = await createUser(t, `${slug}-ada@example.invalid`);
  const editor = await createUser(t, `${slug}-bo@example.invalid`);
  const member = await createUser(t, `${slug}-cy@example.invalid`);
  const stranger = await createUser(t, `${slug}-dee@example.invalid`);
  await createWorkspace(t, owner, `${slug}-ada`);
  await createWorkspace(t, editor, `${slug}-bo`);
  await createWorkspace(t, member, `${slug}-cy`);
  await createWorkspace(t, stranger, `${slug}-dee`);
  const workspaceId = await createWorkspace(t, owner, slug, { kind: "shared" });
  await addMember(t, workspaceId, editor, "editor", owner);
  await addMember(t, workspaceId, member, "member", owner);
  const backend = seededBucket(options.bucket ?? FAKE_STORAGE.bucket);
  if (options.stub !== false) stubBuckets(backend);
  await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: options.bucket });
  return { t, owner, editor, member, stranger, workspaceId, backend };
}

export function seededBucket(name: string): MemoryS3 {
  const backend = memoryS3(name);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Studio\n");
  return backend;
}

/** `/gateway/routines`, as the gateway sends it, then every scan it scheduled. */
export async function signal(
  t: TestConvex,
  body: { workspaceId: string; userId?: string; paths: unknown },
): Promise<Response> {
  const response = await gatewayPost(t, "/gateway/routines", body);
  await runPendingScans(t);
  return response;
}

/**
 * Run the debounced scans now rather than five seconds from now: each queued
 * `reconcileRoutines` is cancelled and run directly with its own arguments,
 * then everything else queued is drained.
 */
export async function runPendingScans(t: TestConvex): Promise<number> {
  const jobs = await t.run(async (ctx) => {
    const pending = (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) => job.state.kind === "pending" && job.name.includes("reconcileRoutines"),
    );
    for (const job of pending) await ctx.scheduler.cancel(job._id);
    return pending.map((job) => job.args[0] as { workspaceId: Id<"workspaces"> });
  });
  for (const args of jobs) await t.action(internal.functions.routines.reconcileRoutines, args);
  await drainScheduled(t);
  return jobs.length;
}

export async function agentPost(t: TestConvex, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
}

export type DueRun = {
  runId: string;
  accessToken: string;
  path: string;
  timeZone: string;
  send: string;
  phones: string[];
};

export async function due(t: TestConvex): Promise<DueRun[]> {
  const { status, body } = await agentPost(t, "/agent-texts/routines/due", {});
  if (status !== 200) throw new Error(`due answered ${status}`);
  return body.runs as DueRun[];
}

export async function rows(t: TestConvex, workspaceId: Id<"workspaces">) {
  return await t.run((ctx) =>
    ctx.db
      .query("routines")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
      .collect(),
  );
}

export async function rowAt(t: TestConvex, workspaceId: Id<"workspaces">, path: string) {
  return (await rows(t, workspaceId)).find((row) => row.path === path) ?? null;
}

/** Make a row due now, as the clock passing its time would. */
export async function makeDue(t: TestConvex, workspaceId: Id<"workspaces">, path: string): Promise<void> {
  const row = await rowAt(t, workspaceId, path);
  if (row === null) throw new Error(`no routine row at ${path}`);
  await t.run((ctx) => ctx.db.patch(row._id, { nextRunAt: Date.now() - 1000 }));
}

export async function linkPhone(t: TestConvex, userId: Id<"users">, phone: string): Promise<void> {
  await t.run((ctx) => ctx.db.insert("phoneLinks", { userId, phone, linkedAt: Date.now() }));
}

export const DAILY = "routines/daily/standup.md";
export const DAILY_TEXT = "---\nat: 7:30 am\nuntil: the launch ships\n---\nSummarize what changed in 1-projects since yesterday.\n";
