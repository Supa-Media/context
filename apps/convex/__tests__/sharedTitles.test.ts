/**
 * Shared with me's titles from the workspace object (`functions/sharedTitles.ts`): the list's own rules decide which
 * titles may be told, and the object says what each is now, read at the note's current text.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * Sabotage (temporary local edits, reverted): `sharedNoteTitle` naming a note in `asks` before `titleMayShow` → "a
 * note the recipient may no longer read is never asked about" fails: the object is asked, and its heading answered.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, createUser, createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";
import { nodeAt as treeNodeAt } from "../functions/lib/nodes/paths";
import { parentRows } from "./nodes/treeRows.helpers";

/** What each workspace object holds, by workspace and path; a workspace absent here has no object reading. */
const objects = vi.hoisted(() => ({ props: new Map<string, Map<string, string | null>>(), asked: [] as string[], serves: true }));
vi.mock("../functions/lib/nodes/objectFacts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../functions/lib/nodes/objectFacts")>();
  return {
    ...real,
    objectFactRows: async (_ctx: unknown, workspaceId: string) => {
      const held = objects.props.get(workspaceId);
      if (held === undefined) return null;
      return async (request: { ask: string; paths?: string[] }) => {
        objects.asked.push(...(request.paths ?? []));
        if (!objects.serves) return { served: false };
        const paths = (request.paths ?? []).filter((path) => held.has(path));
        return { served: true, props: paths.map((path) => ({ path, version: "o", sealed: held.get(path) === null, props: held.get(path) })) };
      };
    },
  };
});

afterEach(() => {
  objects.props.clear();
  objects.asked = [];
  objects.serves = true;
});

const heading = (text: string) => JSON.stringify({ properties: {}, heading: text });

async function world(t: TestConvex) {
  const ana = await createUser(t, "ana@example.invalid");
  const lk = await createUser(t, "lk@example.invalid");
  const anaOwn = await createWorkspace(t, ana, "ana");
  await createWorkspace(t, lk, "lk");
  for (const path of ["1-projects/plan.md", "2-areas/comp/review.md"]) {
    await asUser(t, ana).mutation(api.functions.shares.createShare, { workspaceId: anaOwn, path, recipient: "@lk" });
  }
  await t.run(async (ctx) => {
    for (const path of ["1-projects/plan.md", "2-areas/comp/review.md"]) {
      // The control plane's copy is stale: the object holds the newer heading.
      await ctx.db.insert("nodes", { kind: "file", observedAt: 1, workspaceId: anaOwn, path, name: path.split("/").pop()!, props: heading("Old heading") });
    }
    for (const folder of ["1-projects", "2-areas"]) {
      if ((await treeNodeAt(ctx.db, anaOwn, folder)) === null) await ctx.db.insert("nodes", { workspaceId: anaOwn, path: folder, name: folder, kind: "folder", observedAt: 1 });
    }
    await parentRows(ctx, anaOwn);
  });
  for (const [path, base] of [["1-projects", "team"], ["2-areas", "private"]] as const) {
    const answer = await t.mutation(internal.functions.nodesAccess.setAccess, { workspaceId: anaOwn, path, base, kind: "folder", actor: { userId: ana, role: "owner" } });
    if (!answer.ok) throw new Error(`setting ${path} was refused: ${answer.code}`);
  }
  objects.props.set(anaOwn, new Map([
    ["1-projects/plan.md", heading("Launch week plan")],
    ["2-areas/comp/review.md", heading("Pay review: LK, below band")],
  ]));
  return { ana, lk, anaOwn };
}

describe("Shared with me's titles from the workspace object", () => {
  test("a title the list may tell is read from the object, at the note's current text", async () => {
    const t = setupTest();
    const { lk, anaOwn } = await world(t);
    const titles = await asUser(t, lk).action(api.functions.sharedTitles.now, {});
    expect(titles).toEqual([{ workspaceId: anaOwn, entryPath: "1-projects/plan.md", title: "Launch week plan" }]);
  });

  test("a note the recipient may no longer read is never asked about", async () => {
    const t = setupTest();
    const { lk } = await world(t);
    const titles = await asUser(t, lk).action(api.functions.sharedTitles.now, {});
    expect(JSON.stringify(titles)).not.toContain("Pay review");
    expect(objects.asked).not.toContain("2-areas/comp/review.md");
  });

  test("an object that does not answer leaves the list's own titles: nothing is answered", async () => {
    const t = setupTest();
    const { lk } = await world(t);
    objects.serves = false;
    expect(await asUser(t, lk).action(api.functions.sharedTitles.now, {})).toEqual([]);
  });

  test("a workspace whose notes are not in its object is not asked", async () => {
    const t = setupTest();
    const { lk } = await world(t);
    objects.props.clear();
    expect(await asUser(t, lk).action(api.functions.sharedTitles.now, {})).toEqual([]);
  });

  test("nobody else is told a title, and signing in is required", async () => {
    const t = setupTest();
    await world(t);
    const stranger = await createUser(t, "stranger@example.invalid");
    expect(await asUser(t, stranger).action(api.functions.sharedTitles.now, {})).toEqual([]);
    await expect(t.action(api.functions.sharedTitles.now, {})).rejects.toThrow();
  });
});
