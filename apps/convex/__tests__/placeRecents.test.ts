/**
 * RECENT — the notes one person opened or edited last, for the phone's Home.
 *
 * Asked for by the owner, 2026-10-05: Recent "doesn't actually show the notes
 * that I've personally recently opened/edited". It listed whatever anybody in
 * the workspace changed last. These rows live beside pins and opens
 * (`places.test.ts`) and keep the same rules: the caller's own rows only,
 * only in workspaces they are in, they follow the mover's moves, and they
 * leave with the person, the account and the workspace.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, named tests observed failing, reverted.
 *
 *   recentNotes filters by workspace only (every member's rows)   → "recent is the caller's own, newest first"
 *   recordRecent inserts a second row for a path it has           → "opening again moves it up, as one row"
 *   no ceiling                                                    → "the oldest makes room at the ceiling"
 *   retarget leaves placeRecents alone                            → "a note's recent row follows the mover's move"
 *   placeRecents left out of the sweeps                           → "they leave with the account, the member and the workspace"
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api";
import { RECENT_ROWS_PER_WORKSPACE } from "../functions/lib/places";
import { addMember, asUser, createUser, createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";

const recordRecent = api.functions.places.recordRecent;
const recentNotes = api.functions.places.recentNotes;
const retarget = internal.functions.places.retargetPlaces;

afterEach(() => {
  vi.useRealTimers();
});

async function world() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.invalid");
  const jon = await createUser(t, "jon@example.invalid");
  const ws = await createWorkspace(t, seyi, "northwind", { kind: "shared" });
  await addMember(t, ws, jon, "member", seyi);
  return { t, seyi, jon, ws };
}

const allRecents = (t: TestConvex) => t.run((ctx) => ctx.db.query("placeRecents").collect());

describe("recent notes", () => {
  test("signed out reads nothing", async () => {
    const { t, ws } = await world();
    expect(await t.query(recentNotes, { workspaceId: ws })).toEqual([]);
  });

  test("recent is the caller's own, newest first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 5, 9));
    const { t, seyi, jon, ws } = await world();
    await asUser(t, seyi).mutation(recordRecent, { workspaceId: ws, path: "Projects/launch.md" });
    vi.setSystemTime(Date.UTC(2026, 9, 5, 10));
    await asUser(t, seyi).mutation(recordRecent, { workspaceId: ws, path: "0-inbox/pack.md" });
    await asUser(t, jon).mutation(recordRecent, { workspaceId: ws, path: "Clients/acme.md" });
    expect((await asUser(t, seyi).query(recentNotes, { workspaceId: ws })).map((r) => r.path)).toEqual([
      "0-inbox/pack.md",
      "Projects/launch.md",
    ]);
    expect((await asUser(t, jon).query(recentNotes, { workspaceId: ws })).map((r) => r.path)).toEqual([
      "Clients/acme.md",
    ]);
  });

  test("opening again moves it up, as one row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 5, 9));
    const { t, seyi, ws } = await world();
    const me = asUser(t, seyi);
    await me.mutation(recordRecent, { workspaceId: ws, path: "a.md" });
    vi.setSystemTime(Date.UTC(2026, 9, 5, 10));
    await me.mutation(recordRecent, { workspaceId: ws, path: "b.md" });
    vi.setSystemTime(Date.UTC(2026, 9, 5, 11));
    await me.mutation(recordRecent, { workspaceId: ws, path: "a.md" });
    expect((await me.query(recentNotes, { workspaceId: ws })).map((r) => [r.path, r.at])).toEqual([
      ["a.md", Date.UTC(2026, 9, 5, 11)],
      ["b.md", Date.UTC(2026, 9, 5, 10)],
    ]);
    expect(await allRecents(t)).toHaveLength(2);
  });

  test("a workspace the caller is not in is refused and nothing is written; a bad path is refused", async () => {
    const { t, seyi, ws } = await world();
    const stranger = await createUser(t, "stranger@example.invalid");
    await expect(asUser(t, stranger).mutation(recordRecent, { workspaceId: ws, path: "a.md" })).rejects.toThrow();
    await expect(asUser(t, seyi).mutation(recordRecent, { workspaceId: ws, path: "../a.md" })).rejects.toThrow();
    expect(await allRecents(t)).toEqual([]);
  });

  test("the oldest makes room at the ceiling", async () => {
    vi.useFakeTimers();
    const { t, seyi, ws } = await world();
    const me = asUser(t, seyi);
    for (let i = 0; i <= RECENT_ROWS_PER_WORKSPACE; i++) {
      vi.setSystemTime(Date.UTC(2026, 9, 1) + i * 1000);
      await me.mutation(recordRecent, { workspaceId: ws, path: `n${i}.md` });
    }
    const rows = await me.query(recentNotes, { workspaceId: ws });
    expect(rows).toHaveLength(RECENT_ROWS_PER_WORKSPACE);
    expect(rows.map((r) => r.path)).not.toContain("n0.md");
    expect(rows[0]!.path).toBe(`n${RECENT_ROWS_PER_WORKSPACE}.md`);
  });

  test("a note's recent row follows the mover's move, and only the mover's", async () => {
    const { t, seyi, jon, ws } = await world();
    await asUser(t, seyi).mutation(recordRecent, { workspaceId: ws, path: "Clients/acme.md" });
    await asUser(t, seyi).mutation(recordRecent, { workspaceId: ws, path: "Clients-old/x.md" });
    await asUser(t, jon).mutation(recordRecent, { workspaceId: ws, path: "Clients/acme.md" });
    await t.mutation(retarget, { userId: seyi, workspaceId: ws, from: "Clients", to: "Work/Clients" });
    expect((await asUser(t, seyi).query(recentNotes, { workspaceId: ws })).map((r) => r.path).sort()).toEqual([
      "Clients-old/x.md",
      "Work/Clients/acme.md",
    ]);
    expect((await asUser(t, jon).query(recentNotes, { workspaceId: ws })).map((r) => r.path)).toEqual([
      "Clients/acme.md",
    ]);
  });

  test("they leave with the account, the member and the workspace", async () => {
    const { t, seyi, jon, ws } = await world();
    await asUser(t, jon).mutation(recordRecent, { workspaceId: ws, path: "a.md" });
    await asUser(t, seyi).mutation(api.functions.workspaces.removeMember, { workspaceId: ws, userId: jon });
    expect(await allRecents(t)).toEqual([]);

    await asUser(t, seyi).mutation(recordRecent, { workspaceId: ws, path: "b.md" });
    await asUser(t, seyi).mutation(api.functions.account.deleteWorkspace, { workspaceId: ws, confirmSlug: "northwind" });
    expect(await allRecents(t)).toEqual([]);

    const other = await createWorkspace(t, jon, "jons");
    await asUser(t, jon).mutation(recordRecent, { workspaceId: other, path: "c.md" });
    await asUser(t, jon).mutation(api.functions.account.deleteAccount, {});
    expect(await allRecents(t)).toEqual([]);
  });
});
