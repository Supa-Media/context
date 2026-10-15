/**
 * The app's own reads and saves follow the id switch (`lib/noteIds/consoleLayer.ts`).
 *
 * The console builds its store in Convex, not through a gateway session, so
 * the switch has to wrap it here too, or "Switch to notes/" would change what
 * an AI client reads and nothing the app does.
 *
 * Sabotage: make `withConsoleIdLayout` return the store unwrapped and the
 * switched cases fail.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { withConsoleIdLayout } from "../../functions/lib/noteIds/consoleLayer";
import { ADMIN, boundWorkspace, bucket, chain, observeBucket, rowAt, runPass, storeWithHead, tester, type T } from "./noteIds.helpers";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  delete process.env.STORAGE_MOVER_ORIGIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

/** The two calls the layer makes, answered by the real internal functions. */
function actionCtx(t: T): ActionCtx {
  return {
    runQuery: (fn: unknown, args: unknown) => (t.query as (f: unknown, a: unknown) => Promise<unknown>)(fn, args),
    runMutation: (fn: unknown, args: unknown) => (t.mutation as (f: unknown, a: unknown) => Promise<unknown>)(fn, args),
  } as unknown as ActionCtx;
}

async function setMode(t: T, mode: "paths" | "ids") {
  await t.run(async (ctx) => {
    const existing = await ctx.db.query("noteIdLayout").first();
    if (existing === null) await ctx.db.insert("noteIdLayout", { mode, paused: false, updatedAt: 1, updatedBy: "test" });
    else await ctx.db.patch(existing._id, { mode });
  });
}

async function copied(t: T, ws: Id<"workspaces">) {
  const store = bucket({ "1-projects/a.md": "# A\n" });
  await observeBucket(t, ws, store);
  await runPass(chain(t, ws, store));
  const row = await rowAt(t, ws, "1-projects/a.md");
  const key = `notes/${row!.noteId}.md`;
  const asked: string[] = [];
  const watched = storeWithHead(store);
  const get = watched.get.bind(watched);
  watched.get = (async (k: string, ...rest: never[]) => {
    asked.push(k);
    return await (get as (...a: unknown[]) => Promise<unknown>)(k, ...rest);
  }) as typeof watched.get;
  return { store, watched, key, asked };
}

describe("the app's store and the id switch", () => {
  test("on paths the store is returned as it was", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "console-paths");
    const { watched } = await copied(t, ws);
    expect(await withConsoleIdLayout(actionCtx(t), ws, watched)).toBe(watched);
  });

  test("switched, the app reads a fresh note from its id key, under the path's version", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "console-ids");
    const { watched, key, asked } = await copied(t, ws);
    await setMode(t, "ids");
    const wrapped = await withConsoleIdLayout(actionCtx(t), ws, watched);
    const object = (await wrapped.get("1-projects/a.md")) as { etag: string; text(): Promise<string> };
    expect(await object.text()).toBe("# A\n");
    expect(asked).toContain(key);
    expect(object.etag).toBe((await rowAt(t, ws, "1-projects/a.md"))!.etag);
  });

  test("switched, an app save lands on both keys and records the copy", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "console-save");
    const { store, watched, key } = await copied(t, ws);
    await setMode(t, "ids");
    const wrapped = await withConsoleIdLayout(actionCtx(t), ws, watched);
    const result = (await wrapped.put("1-projects/a.md", "# A, edited\n")) as { etag: string };
    expect(new TextDecoder().decode(store.bytesOf(key)!)).toBe("# A, edited\n");
    const row = await rowAt(t, ws, "1-projects/a.md");
    expect(row?.idCopy).toMatchObject({ key, etag: result.etag, keyEtag: expect.any(String) });
  });
});
