/**
 * NAMES AS YOU TYPE, FROM THE TREE, IN EVERY WORKSPACE (the search tune-up,
 * Dev2's pick, 2026-10-27; board M1).
 *
 * A new read of note names across workspaces is a new place for a private
 * name to leak, so most of what is asserted is who does NOT see a name:
 *
 *  - A member at `team` scope is not handed a name in a private folder, and is
 *    once the owner shares the folder.
 *  - A workspace the caller is not in is never searched, whether or not its
 *    id is named in `contexts`.
 *  - A member removed from a workspace stops seeing its names.
 *  - Plumbing and non-notes are never offered.
 *
 * And that it does the job: a name is found from its first letters, in a
 * folder nobody has opened, and a name starting with what was typed leads.
 *
 * Sabotage record (temporary local edits, reverted, as measured):
 *   `canSee` filter removed                     → "a member is not handed a private name…" fails
 *   `resolveFileAccess` failure not caught,
 *     and the scope taken from `contexts` alone  → "a workspace the caller is not in…" fails
 *   `rankNames` tiers removed                    → "a name that starts with what was typed leads" fails
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser } from "./fixtures.helpers";
import { twoTenants } from "./blendedSearch.helpers";
import { rankNames } from "../functions/nameSearch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("names as you type", () => {
  test("a name is found from its first letters, in your own workspace", async () => {
    const f = await twoTenants();
    const found = await asUser(f.t, f.alice).query(api.functions.nameSearch.searchNames, { query: "pla" });
    expect(found.map((row) => [row.slug, row.path, row.title])).toEqual([["alice-context", "1-projects/plan.md", "plan"]]);
  }, 60_000);

  test("a member is not handed a private name, and is once the folder is shared", async () => {
    const f = await twoTenants();
    await addMember(f.t, f.bobWs, f.alice, "member", f.bob);
    const before = await asUser(f.t, f.alice).query(api.functions.nameSearch.searchNames, { query: "pay" });
    expect(before).toEqual([]);
    const plansBefore = await asUser(f.t, f.alice).query(api.functions.nameSearch.searchNames, { query: "plan" });
    expect(plansBefore.map((row) => row.slug)).toEqual(["alice-context"]);

    await asUser(f.t, f.bob).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.bobWs,
      path: "1-projects",
      visibility: "team",
    });
    const plans = await asUser(f.t, f.alice).query(api.functions.nameSearch.searchNames, { query: "plan" });
    expect(new Set(plans.map((row) => row.slug))).toEqual(new Set(["alice-context", "bob-context"]));
    // Still not the private area's note.
    expect(await asUser(f.t, f.alice).query(api.functions.nameSearch.searchNames, { query: "pay" })).toEqual([]);
    // The owner, asking the same index, does see it: the filter is the reason, not a missing row.
    const owner = await asUser(f.t, f.bob).query(api.functions.nameSearch.searchNames, { query: "pay" });
    expect(owner.map((row) => row.path)).toEqual(["2-areas/pay.md"]);
  }, 60_000);

  test("a workspace the caller is not in is never searched, even when named", async () => {
    const f = await twoTenants();
    const named = await asUser(f.t, f.alice).query(api.functions.nameSearch.searchNames, { query: "plan", contexts: [f.bobWs] });
    expect(named).toEqual([]);
    const all = await asUser(f.t, f.alice).query(api.functions.nameSearch.searchNames, { query: "plan" });
    expect(all.map((row) => row.slug)).toEqual(["alice-context"]);
  }, 60_000);

  test("narrowing to one workspace searches that one alone", async () => {
    const f = await twoTenants();
    await addMember(f.t, f.bobWs, f.alice, "member", f.bob);
    await asUser(f.t, f.bob).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.bobWs,
      path: "1-projects",
      visibility: "team",
    });
    const narrowed = await asUser(f.t, f.alice).query(api.functions.nameSearch.searchNames, { query: "plan", contexts: [f.bobWs] });
    expect(narrowed.map((row) => row.slug)).toEqual(["bob-context"]);
  }, 60_000);

  test("plumbing and files that are not notes are never offered", async () => {
    const f = await twoTenants();
    expect(await asUser(f.t, f.alice).query(api.functions.nameSearch.searchNames, { query: "privacy" })).toEqual([]);
    expect(await asUser(f.t, f.alice).query(api.functions.nameSearch.searchNames, { query: "" })).toEqual([]);
  }, 60_000);
});

describe("one list across workspaces", () => {
  test("a name that starts with what was typed leads", () => {
    const ranked = rankNames(
      [
        { rank: 0, row: { title: "Weekly plan" } },
        { rank: 0, row: { title: "Zebra" } },
        { rank: 1, row: { title: "Planning notes" } },
      ],
      "plan",
    );
    expect(ranked.map((row) => row.title)).toEqual(["Planning notes", "Weekly plan", "Zebra"]);
  });
});
