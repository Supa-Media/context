/**
 * The owner's delete of hidden old copies where the workspace's notes live in its object (`functions/oldCopiesObject.ts`,
 * the branch `deleteCopies` and `erasePage` take when `workspaceObjectHomes.home` is `object`;
 * `docs/decisions/storage-and-credentials/background-tree-writers.md`). The object removes `.context/old-copies` a page
 * at a time (`ws.write.erase`, a fake here that deletes the Convex rows under the path on the last page, as the mirror
 * would), and each page's files are recorded for the bucket half (`trashObject.ts`) with `objectPending` held until the
 * erase is known to have happened. The audit line belongs to `deleteCopies`, not to the object's pages.
 *
 * Sabotage (temporary local edit, reverted): make `deleteCopies` always schedule `oldCopies.erasePage` → "the owner's
 * delete schedules the object's erase, and not the bucket chain's erasePage" fails.
 */

import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import { nodePaths } from "../../functions/lib/nodes/paths";
import { deleteInObject } from "../../functions/oldCopiesObject";
import type { ObjectEraser } from "../../functions/lib/trash/objectErase";
import type { Fixture } from "../nodes/moveFixture.helpers";
import { rowOf } from "../nodes/keyedFixture.helpers";
import { COPIES, copiesFixture, hideAll } from "./oldCopies.helpers";
import { OLD_COPIES_ROOT } from "../../functions/lib/fileOps/store";

const ALL_COPIES = [...COPIES.days, ...COPIES.contacts, ...COPIES.files];
const hidden = (path: string) => `${OLD_COPIES_ROOT}/${path}`;

/** The hidden copies as file rows the object would list: each one's note id and key, as `pageOf` reads them. */
async function hiddenFiles(f: Fixture) {
  const out: Array<{ noteId: string | null; storageKey: string | null }> = [];
  for (const path of ALL_COPIES) {
    const row = await rowOf(f, hidden(path));
    out.push({ noteId: row.noteId ?? null, storageKey: row.storageKey ?? null });
  }
  return out;
}

/** The mirror: the object removed these rows, so Convex's copy of them goes too. */
async function mirrorErase(f: Fixture, folder: string) {
  await f.t.run(async (ctx) => {
    const paths = await nodePaths(ctx.db, f.ws);
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws)).collect();
    for (const row of rows) {
      const path = await paths.pathOf(row);
      if (path === folder || (path !== null && path.startsWith(`${folder}/`))) await ctx.db.delete(row._id);
    }
  });
}

/** The page the object answers: `ok` with the page. */
const page = (files: Array<{ noteId: string | null; storageKey: string | null }>, more: boolean) => ({ ok: true, count: files.length, more, files });

/**
 * A fake `ws.write.erase`. Each call takes the next reply: an Error is thrown, anything else is the answer. A reply that
 * ends the folder (`more: false`) also has the mirror delete the folder's rows, as the object's write-behind does.
 */
function objectOf(f: Fixture, replies: Array<unknown | Error>) {
  const calls: Array<{ path: string }> = [];
  const client: ObjectEraser = {
    write: {
      erase: async (body) => {
        calls.push(body);
        const answer = replies[calls.length - 1];
        if (answer instanceof Error) throw answer;
        const held = answer as { ok?: unknown; more?: unknown } | null;
        if (held?.ok === true && held.more === false) await mirrorErase(f, body.path);
        return answer;
      },
    },
  };
  return { client, calls };
}

async function setHome(f: Fixture, home: "object" | "bucket" = "object") {
  await f.t.run(async (ctx) => {
    await ctx.db.insert("workspaceObjectHomes", { workspaceId: f.ws, home, since: Date.now() });
  });
}

const erasures = (f: Fixture) => f.t.run(async (ctx) => await ctx.db.query("trashErasures").collect());
const oldCopyHide = (f: Fixture) => f.t.run(async (ctx) => await ctx.db.query("oldCopyHides").first());
const audits = (f: Fixture, action: string) =>
  f.t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).filter((event) => event.action === action));
const scheduledNames = (f: Fixture) =>
  f.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.state.kind === "pending").map((job) => job.name));

/** Hidden, then the owner's delete has been asked (state `deleting`), with the bucket home so the press schedules the bucket chain. */
async function deletingFixture() {
  const f = await copiesFixture();
  await hideAll(f);
  await f.owner.mutation(api.functions.oldCopies.deleteCopies, { workspaceId: f.ws });
  return f;
}

describe("the owner's delete where the notes live in the object", () => {
  test("deleteCopies schedules the object's erase and not the bucket chain's erasePage, and removes no row itself", async () => {
    const f = await copiesFixture();
    await hideAll(f);
    await setHome(f);
    const before = await scheduledNames(f);

    await f.owner.mutation(api.functions.oldCopies.deleteCopies, { workspaceId: f.ws });

    const added = (await scheduledNames(f)).filter((name) => !before.includes(name));
    expect(added.some((name) => name.includes("oldCopiesObject"))).toBe(true);
    expect(added.some((name) => name.includes("erasePage"))).toBe(false);
    // The object removes the rows; nothing here does. Every hidden copy is still a live row.
    for (const path of ALL_COPIES) expect((await rowOf(f, hidden(path))).goneAt).toBeUndefined();
    expect(await oldCopyHide(f)).toMatchObject({ state: "deleting" });
  });

  test("deleteInObject takes two pages: both pages' keys go to one record, held back until done, and the folder is deleted", async () => {
    const f = await deletingFixture();
    await setHome(f);
    const files = await hiddenFiles(f);
    const keys = files.map((file) => file.storageKey as string);
    const { client, calls } = objectOf(f, [page(files.slice(0, 2), true), page(files.slice(2), false)]);
    const auditsBefore = await audits(f, "file.delete");

    expect(await deleteInObject(f.ctx, f.ws, client)).toBe("done");

    expect(calls).toEqual([{ path: OLD_COPIES_ROOT }, { path: OLD_COPIES_ROOT }]);
    const records = await erasures(f);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ folder: OLD_COPIES_ROOT, path: OLD_COPIES_ROOT });
    expect(records[0]!.objectPending).toBeUndefined();
    expect([...records[0]!.keys].sort()).toEqual([...keys].sort());
    expect(await oldCopyHide(f)).toMatchObject({ state: "deleted" });
    // The audit is the owner's press (`deleteCopies`); the object's pages add none.
    expect(await audits(f, "file.delete")).toHaveLength(auditsBefore.length);
  });

  test("a fake that answers NOT_FOUND has nothing left: the run is done and the delete is finished", async () => {
    const f = await deletingFixture();
    await setHome(f);
    const { client, calls } = objectOf(f, [{ ok: false, code: "NOT_FOUND" }]);

    expect(await deleteInObject(f.ctx, f.ws, client)).toBe("done");

    expect(calls).toEqual([{ path: OLD_COPIES_ROOT }]);
    expect(await oldCopyHide(f)).toMatchObject({ state: "deleted" });
    const [cleared] = await erasures(f);
    expect(cleared).toMatchObject({ folder: OLD_COPIES_ROOT });
    expect(cleared!.objectPending).toBeUndefined();
  });

  test("a thrown call is a retry: the delete stays deleting and the record stays held back from the bucket half", async () => {
    const f = await deletingFixture();
    await setHome(f);
    const { client, calls } = objectOf(f, [Object.assign(new Error("down"), { name: "TypeError" })]);

    expect(await deleteInObject(f.ctx, f.ws, client)).toBe("retry");

    expect(calls).toEqual([{ path: OLD_COPIES_ROOT }]);
    expect(await oldCopyHide(f)).toMatchObject({ state: "deleting" });
    expect(await erasures(f)).toMatchObject([{ folder: OLD_COPIES_ROOT, objectPending: true }]);
  });

  test("a refusal that is not NOT_FOUND is a retry, and the delete stays deleting", async () => {
    const f = await deletingFixture();
    await setHome(f);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, calls } = objectOf(f, [{ ok: false, code: "REFUSED" }]);

    expect(await deleteInObject(f.ctx, f.ws, client)).toBe("retry");

    expect(calls).toEqual([{ path: OLD_COPIES_ROOT }]);
    expect(log).toHaveBeenCalledWith("old_copies.object_erase_refused", expect.anything());
    expect(await oldCopyHide(f)).toMatchObject({ state: "deleting" });
    expect(await erasures(f)).toMatchObject([{ folder: OLD_COPIES_ROOT, objectPending: true }]);
    log.mockRestore();
  });

  test("erasePage begun before the switch removes no row and hands the rest to the object's erase", async () => {
    const f = await deletingFixture();
    await setHome(f);
    const before = await scheduledNames(f);

    await f.t.mutation(internal.functions.oldCopies.erasePage, { workspaceId: f.ws });

    const added = (await scheduledNames(f)).filter((name) => !before.includes(name));
    expect(added.some((name) => name.includes("oldCopiesObject"))).toBe(true);
    for (const path of ALL_COPIES) expect((await rowOf(f, hidden(path))).goneAt).toBeUndefined();
    expect(await oldCopyHide(f)).toMatchObject({ state: "deleting" });
    expect(await erasures(f)).toEqual([]);
  });
});
