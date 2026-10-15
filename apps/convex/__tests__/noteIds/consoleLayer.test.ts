/**
 * The app's own reads and saves follow the id switch (`lib/noteIds/consoleLayer.ts`).
 *
 * The console builds its store in Convex, not through a gateway session. Its
 * hooks (`consoleIdLayoutHooks`) are the same layer's hooks, bound to the
 * workspace, and `storeForBinding` applies them (`idLayout`), so the switch
 * has to reach them here too, or "Switch to notes/" would change what an AI
 * client reads and nothing the app does. These cases wrap the test store with
 * the hooks the way the factory does.
 *
 * What is proved:
 *  - on paths there are no hooks, and the app's store is untouched;
 *  - on ids the hooks carry the id copy's lookup and record, and no keyed hooks;
 *  - on keys the app's create lands at its id key with a keyed row, and reads
 *    and saves go to that key, and a delete retires the row and its bytes.
 *
 * Sabotage: make `consoleIdLayoutHooks` return null for every mode and the
 * switched cases fail; drop `adopt` from the keys hooks and the create case
 * fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { withIdLayout } from "../../../mcp/src/store/idLayout.js";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { consoleIdLayoutHooks } from "../../functions/lib/noteIds/consoleLayer";
import {
  ADMIN,
  boundWorkspace,
  bucket,
  chain,
  observeBucket,
  rowAt,
  runPass,
  storeWithHead,
  tester,
  type T,
} from "./noteIds.helpers";
import { ensureCopyRow } from "../../functions/lib/noteIds/state";

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

/** The calls the hooks make, answered by the real internal functions. */
function actionCtx(t: T): ActionCtx {
  return {
    runQuery: (fn: unknown, args: unknown) => (t.query as (f: unknown, a: unknown) => Promise<unknown>)(fn, args),
    runMutation: (fn: unknown, args: unknown) => (t.mutation as (f: unknown, a: unknown) => Promise<unknown>)(fn, args),
  } as unknown as ActionCtx;
}

/** The app's store as `storeForBinding` builds it: the test store, with the console's hooks applied. */
async function appStore<S extends object>(t: T, ws: Id<"workspaces">, store: S): Promise<S> {
  const hooks = await consoleIdLayoutHooks(actionCtx(t), ws);
  return hooks === null ? store : (withIdLayout(store, hooks as never) as S);
}

async function setMode(t: T, mode: "paths" | "ids" | "keys") {
  await t.run(async (ctx) => {
    const existing = await ctx.db.query("noteIdLayout").first();
    if (existing === null) await ctx.db.insert("noteIdLayout", { mode, paused: false, updatedAt: 1, updatedBy: "test" });
    else await ctx.db.patch(existing._id, { mode });
  });
}

/** The switch at `keys` and the flip begun: a keyed workspace. */
async function keyedWorkspace(t: T, ws: Id<"workspaces">) {
  await setMode(t, "keys");
  await t.run(async (ctx) => {
    const copies = await ensureCopyRow(ctx, ws);
    await ctx.db.patch(copies._id, { keyedAt: 1 });
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
  test("on paths there are no hooks, and the store is returned as it was", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "console-paths");
    const { watched } = await copied(t, ws);
    expect(await consoleIdLayoutHooks(actionCtx(t), ws)).toBeNull();
    expect(await appStore(t, ws, watched)).toBe(watched);
  });

  test("on ids the hooks are the lookup and the record only: no keyed hooks", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "console-ids-hooks");
    await copied(t, ws);
    await setMode(t, "ids");
    const hooks = (await consoleIdLayoutHooks(actionCtx(t), ws)) as Record<string, unknown>;
    expect(hooks.mode).toBe("ids");
    expect(typeof hooks.lookup).toBe("function");
    expect(typeof hooks.wrote).toBe("function");
    expect(hooks.adopt).toBeUndefined();
    expect(hooks.removed).toBeUndefined();
  });

  test("switched to ids, the app reads a fresh note from its id key, under the path's version", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "console-ids");
    const { watched, key, asked } = await copied(t, ws);
    await setMode(t, "ids");
    const wrapped = await appStore(t, ws, watched);
    const object = (await wrapped.get("1-projects/a.md")) as { etag: string; text(): Promise<string> };
    expect(await object.text()).toBe("# A\n");
    expect(asked).toContain(key);
    expect(object.etag).toBe((await rowAt(t, ws, "1-projects/a.md"))!.etag);
  });

  test("switched to ids, an app save lands on both keys and records the copy", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "console-save");
    const { store, watched, key } = await copied(t, ws);
    await setMode(t, "ids");
    const wrapped = await appStore(t, ws, watched);
    const result = (await wrapped.put("1-projects/a.md", "# A, edited\n")) as { etag: string };
    expect(new TextDecoder().decode(store.bytesOf(key)!)).toBe("# A, edited\n");
    const row = await rowAt(t, ws, "1-projects/a.md");
    expect(row?.idCopy).toMatchObject({ key, etag: result.etag, keyEtag: expect.any(String) });
  });

  test("on keys, the app's new note lands at its own id key, never its path, and gets a keyed row", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "console-keys-create");
    const store = bucket({});
    await keyedWorkspace(t, ws);
    const wrapped = await appStore(t, ws, storeWithHead(store));
    await wrapped.put("1-projects/new.md", "# New\n");
    const row = await rowAt(t, ws, "1-projects/new.md");
    expect(row).toMatchObject({ kind: "file", storageKey: `notes/${row!.noteId}.md` });
    expect(new TextDecoder().decode(store.bytesOf(row!.storageKey!)!)).toBe("# New\n");
    expect(store.bytesOf("1-projects/new.md")).toBeNull();
  });

  test("on keys, the app reads a keyed note from its key, and a save moves the row's version", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "console-keys-read");
    const store = bucket({});
    await keyedWorkspace(t, ws);
    const wrapped = await appStore(t, ws, storeWithHead(store));
    await wrapped.put("1-projects/new.md", "# New\n");
    const row = (await rowAt(t, ws, "1-projects/new.md"))!;
    const object = (await wrapped.get("1-projects/new.md")) as { text(): Promise<string> };
    expect(await object.text()).toBe("# New\n");
    const saved = (await wrapped.put("1-projects/new.md", "# New, edited\n")) as { etag: string };
    expect(new TextDecoder().decode(store.bytesOf(row.storageKey!)!)).toBe("# New, edited\n");
    expect(await rowAt(t, ws, "1-projects/new.md")).toMatchObject({ etag: saved.etag, storageKey: row.storageKey });
  });

  test("on keys, an app delete retires the row and removes the note's key", async () => {
    const t = tester();
    const ws = await boundWorkspace(t, "console-keys-delete");
    const store = bucket({});
    await keyedWorkspace(t, ws);
    const wrapped = await appStore(t, ws, storeWithHead(store));
    await wrapped.put("1-projects/new.md", "# New\n");
    const { storageKey } = (await rowAt(t, ws, "1-projects/new.md"))!;
    await wrapped.delete("1-projects/new.md");
    expect((await rowAt(t, ws, "1-projects/new.md"))!.goneAt).toBeDefined();
    expect(store.bytesOf(storageKey!)).toBeNull();
  });
});
