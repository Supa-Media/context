/**
 * A control plane wired to real workspace objects (`apps/mcp/src/workspaceStore/serve.js` on node:sqlite) through the
 * gateway's real door, for the tests of what reaches them (`workspaceObjectPush.test.ts`, `workspaceObjectFirst.test.ts`).
 */

import { createRequire } from "node:module";
import { expect, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { handleWorkspaceStoreDoor } from "../../mcp/src/workspaceStore/door.js";
import { serveWorkspaceStore } from "../../mcp/src/workspaceStore/serve.js";
import { workspaceRows } from "../../mcp/src/workspaceStore/rows.js";
import { workspaceMarks } from "../../mcp/src/workspaceStore/marks.js";
import { texObjects } from "../../mcp/src/texStore/objects.js";
import { TEST_GATEWAY_SECRET, createUser, createWorkspace, gatewayPost, setupTest, type TestConvex } from "./fixtures.helpers";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const GATEWAY = "https://gateway.example.invalid";

export function durableSql() {
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
    transact<T>(work: () => T): T {
      db.exec("BEGIN");
      try {
        const result = work();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

type ObjectStore = {
  rows: ReturnType<typeof workspaceRows>;
  objects: ReturnType<typeof texObjects>;
  marks: ReturnType<typeof workspaceMarks>;
  transact: <T>(work: () => T) => T;
};

function opOf(init: RequestInit): string {
  const headers = new Headers(init.headers);
  try {
    return (JSON.parse(decodeURIComponent(headers.get("x-tex-call") ?? "null")) as { op?: string } | null)?.op ?? "";
  } catch {
    return "";
  }
}

export async function world() {
  const t = setupTest();
  const owner = await createUser(t, "object-push@example.com");
  const workspaceId = await createWorkspace(t, owner, "object-push", { kind: "shared" });
  const stores = new Map<string, ObjectStore>();
  const env = {
    GATEWAY_SECRET: TEST_GATEWAY_SECRET,
    WORKSPACE_STORE: {
      idFromName: (name: string) => name,
      get: (name: string) => {
        if (!stores.has(name)) {
          const sql = durableSql();
          stores.set(name, { rows: workspaceRows(sql), objects: texObjects(sql), marks: workspaceMarks(sql), transact: (work) => sql.transact(work) });
        }
        const held = stores.get(name)!;
        return { fetch: (request: Request) => serveWorkspaceStore(held, request) };
      },
    },
  };
  const controlPlane = {
    async openTexStoreTicket(ticket: string) {
      const response = await gatewayPost(t, "/gateway/tex-store/open", { ticket });
      const { opened } = (await response.json()) as { opened: { workspaceId: string; owners: string[] } | null };
      return opened;
    },
  };
  let calls = 0;
  let held = false;
  const seen: string[] = [];
  const failing = new Set<string>();
  let beforeCall: (op: string) => Promise<void> = async () => {};
  vi.stubEnv("STORAGE_MOVER_ORIGIN", GATEWAY);
  vi.stubEnv("GATEWAY_SECRET", TEST_GATEWAY_SECRET);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls += 1;
    if (held) throw new Error("the object is not reachable yet");
    const op = opOf(init);
    seen.push(op);
    if (failing.has(op)) throw new Error(`the object refused ${op}`);
    await beforeCall(op);
    if (!String(url).startsWith(`${GATEWAY}/internal/workspace-store`)) throw new Error(`unexpected fetch ${url}`);
    return await handleWorkspaceStoreDoor(new Request(url, init), env, { controlPlane });
  });
  /** Ask the workspace's object as the gateway would. */
  const lookup = async (path: string, scope: "private" | "team") => {
    const held = stores.get(`workspace:${workspaceId}`);
    if (held === undefined) return null;
    const response = await serveWorkspaceStore(
      held,
      new Request("https://workspace-store.internal/ask", {
        method: "POST",
        headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op: "ws.rows.lookup" })) },
        body: JSON.stringify({ workspaceId, paths: [path], scope, groups: [], audience: "member" }),
      }),
    );
    const answer = (await response.json()) as { rows: { found: boolean; path?: string }[]; behind?: boolean };
    return { ...answer.rows[0], ...(answer.behind === true ? { behind: true } : {}) };
  };
  return {
    t,
    owner,
    workspaceId,
    lookup,
    stores,
    calls: () => calls,
    hold: (on: boolean) => (held = on),
    /** Every object op asked, in order. */
    ops: () => [...seen],
    /** Refuse these ops at the object's door. */
    fail: (ops: string[]) => {
      failing.clear();
      for (const op of ops) failing.add(op);
    },
    /** Run before each object op reaches the object: to look at the control plane as the op leaves. */
    onCall: (hook: (op: string) => Promise<void>) => (beforeCall = hook),
  };
}

export async function setHome(t: TestConvex, workspaceId: Id<"workspaces">, home: "bucket" | "dual" | "object") {
  await t.run(async (ctx) => {
    const held = await ctx.db.query("workspaceObjectHomes").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
    if (held === null) await ctx.db.insert("workspaceObjectHomes", { workspaceId, home, since: Date.now() });
    else await ctx.db.patch(held._id, { home });
  });
}

export const outbox = (t: TestConvex, workspaceId: Id<"workspaces">) =>
  t.run(async (ctx) => await ctx.db.query("workspaceObjectOutbox").withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId)).collect());

export async function setFolder(t: TestConvex, workspaceId: Id<"workspaces">, owner: Id<"users">, path: string, base: "private" | "team") {
  const answer = await t.mutation(internal.functions.nodesAccess.setAccess, {
    workspaceId,
    path,
    base,
    kind: "folder",
    actor: { userId: owner, role: "owner" },
  });
  expect(answer).toMatchObject({ ok: true });
}

export const drain = (t: TestConvex, workspaceId: Id<"workspaces">) => t.action(internal.functions.workspaceObjectPush.drain, { workspaceId });

export const noteIdAt = (t: TestConvex, workspaceId: Id<"workspaces">, path: string) =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path)).collect();
    return rows.find((row) => row.goneAt === undefined)?.noteId ?? null;
  });

