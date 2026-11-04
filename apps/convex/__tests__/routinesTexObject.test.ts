/**
 * ROUTINES IN TEX'S OBJECTS: a Tex routine's time reaches its row once the workspace's notes live in its object.
 *
 * Tex's own notes keep their text in Tex's tables (`tex/<owner>/notes/<id>.md`), which the workspace object's facts
 * never read, and from #2714 the control plane keeps no facts for an object-home workspace. Every new or changed Tex
 * routine then waited forever: from 2026-11-02 a reminder Tex had set never ran, and one moved from 6 pm to 4:30 pm
 * still ran at 6 (production `routine_alarm runs: 0` at the new times). The scan now reads such a routine's front
 * matter from Tex's object (`lib/routines/texFacts.ts`), through the gateway's real door.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `texPropsAt` answering nothing (the code before this test) → both tests fail: the changed routine keeps 12:00,
 *     the new one gets no row.
 */

import { createRequire } from "node:module";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { handleTexStoreDoor } from "../../mcp/src/texStore/door.js";
import { texObjects } from "../../mcp/src/texStore/objects.js";
import { serveTexStore } from "../../mcp/src/texStore/wire.js";
import { TEST_GATEWAY_SECRET, copyTree, gatewayPost, type TestConvex } from "./fixtures.helpers";
import { routineFixture, rowAt, signal } from "./routines.helpers";
import { noteIdAt, setHome } from "./workspaceObjectWorld.helpers";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const GATEWAY = "https://gateway.example.invalid";
const CHANGED = "tex/routines/once/v2l-updates.md";
const NEW = "tex/routines/once/tobi-videos.md";
const at = (clock: string) => `---\nat: 2099-01-05 ${clock}\n---\nRemind them.\n`;

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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

/** The workspace on its object, its Tex routines' text in Tex's store, and no facts for them anywhere but there. */
async function onObjects(t: TestConvex, workspaceId: Id<"workspaces">, texts: Record<string, string>) {
  const tex = texObjects(durableSql());
  for (const [path, text] of Object.entries(texts)) {
    const noteId = await noteIdAt(t, workspaceId, path);
    if (noteId === null) throw new Error(`no row at ${path}`);
    await tex.put(`notes/${noteId}.md`, text);
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path)).collect();
      for (const row of rows) await ctx.db.patch(row._id, { storageKey: `tex/person:${workspaceId}/notes/${noteId}.md` });
    });
  }
  await setHome(t, workspaceId, "object");
  await t.mutation(internal.functions.nodeFactsDrop.drop, { workspaceId });

  const env = {
    GATEWAY_SECRET: TEST_GATEWAY_SECRET,
    TEX_STORE: { idFromName: (name: string) => name, get: () => ({ fetch: (request: Request) => serveTexStore(tex, request) }) },
  };
  const controlPlane = {
    async openTexStoreTicket(ticket: string) {
      const response = await gatewayPost(t, "/gateway/tex-store/open", { ticket });
      return ((await response.json()) as { opened: { workspaceId: string; owners: string[] } | null }).opened;
    },
  };
  vi.stubEnv("STORAGE_MOVER_ORIGIN", GATEWAY);
  vi.stubEnv("GATEWAY_SECRET", TEST_GATEWAY_SECRET);
  const bucket = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url) === `${GATEWAY}/internal/tex-store`) return await handleTexStoreDoor(new Request(url, init), env, { controlPlane });
    // The workspace object holds no Tex note, so its facts answer none of them, as in production.
    if (String(url).startsWith(`${GATEWAY}/internal/workspace-store`)) return Response.json({ served: true, props: [] });
    return await bucket(url, init);
  });
  return tex;
}

test("a Tex routine changed after its workspace moved to its object runs at its new time", async () => {
  const f = await routineFixture();
  f.backend.seed(CHANGED, at("6:00 pm"));
  await signal(f.t, { workspaceId: f.workspaceId, userId: f.owner, paths: [CHANGED] });
  expect(await rowAt(f.t, f.workspaceId, CHANGED)).toMatchObject({ at: { hour: 18, minute: 0 } });

  const tex = await onObjects(f.t, f.workspaceId, { [CHANGED]: at("6:00 pm") });
  // Tex moves it to 4:30 pm: the text changes in Tex's store, and the gateway signals.
  const noteId = await noteIdAt(f.t, f.workspaceId, CHANGED);
  await tex.put(`notes/${noteId}.md`, at("4:30 pm"));
  await gatewayPost(f.t, "/gateway/routines", { workspaceId: f.workspaceId, userId: f.owner, paths: [CHANGED] });
  await f.t.action(internal.functions.routines.reconcileRoutines, { workspaceId: f.workspaceId });

  const row = await rowAt(f.t, f.workspaceId, CHANGED);
  expect(row).toMatchObject({ at: { hour: 16, minute: 30 }, date: { year: 2099, month: 1, day: 5 }, writerUserId: f.owner });
  expect(row!.nextRunAt).toBe(Date.UTC(2099, 0, 5, 21, 30));
  // Only what the facts would hold reached the control plane: no word of the note.
  expect(JSON.stringify(await f.t.run(async (ctx) => await ctx.db.query("routines").collect()))).not.toContain("Remind");
});

test("a Tex reminder set after its workspace moved to its object gets a row", async () => {
  const f = await routineFixture();
  f.backend.seed(NEW, at("12:00 pm"));
  await copyTree(f.t, f.workspaceId);
  await onObjects(f.t, f.workspaceId, { [NEW]: at("12:00 pm") });
  await gatewayPost(f.t, "/gateway/routines", { workspaceId: f.workspaceId, userId: f.owner, paths: [NEW] });
  await f.t.action(internal.functions.routines.reconcileRoutines, { workspaceId: f.workspaceId });
  expect(await rowAt(f.t, f.workspaceId, NEW)).toMatchObject({ at: { hour: 12, minute: 0 }, writerUserId: f.owner });
});
