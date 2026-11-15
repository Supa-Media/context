/**
 * Live Tex Lab drafts (`functions/texLabDrafts.ts`; Dev2, 2026-11-15): an AI over the MCP's `tex_dev` and a staff
 * member in the Lab edit one draft. Only a person who owns or edits the pinned context may, only on an AI client of
 * their own (never Tex's), and an edit made against an older revision is refused only when the same piece changed.
 *
 * Sabotage (temporary local edits, reverted, 2026-11-15):
 *   `texDeveloper` without the role check         "a stranger, a plain member ..." fails
 *   `texDeveloper` without the staff check        "a stranger, a plain member ..." fails
 *   `texDeveloper` without the context_ check     "... Context's own clients (Tex's among them) are refused" fails
 *   `applyToDraft` without the conflicts() check   "the later edit to the same field is refused" fails
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { api } from "../../_generated/api";
import { addMember, createUser, createWorkspace, gatewayPost } from "../fixtures.helpers";
import { ACCESS_A, ACCESS_B, bodyOf, registerClient, twoConnectedTenants } from "./fixtures.helpers";
import { withSession } from "../session.helpers";

vi.setConfig({ testTimeout: 30_000 });

const STAFF = "staff@example.invalid";
// Alice, the editor of the pinned context the tests' AI client speaks for, is staff too unless a test says not.
beforeEach(() => vi.stubEnv("ADMIN_EMAILS", `${STAFF},alice@example.invalid`));
afterEach(() => vi.unstubAllEnvs());

const GRAPH = {
  nodes: [
    { id: "fd", label: "Front door", model: "haiku-5-5", effort: "low", on: true, x: 0, y: 0 },
    { id: "reviewer", label: "Reviewer", model: "sonnet-5-5", effort: "high", on: true, x: 200, y: 0 },
  ],
  edges: [{ from: "fd", to: "reviewer", mode: "wait", when: ["*"] }],
};

async function world(role: "editor" | "member" = "editor") {
  const tenants = await twoConnectedTenants();
  const staff = await createUser(tenants.t, STAFF);
  const pinned = await createWorkspace(tenants.t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
  await addMember(tenants.t, pinned, tenants.alice, role, staff);
  const dev = async (action: string, args: Record<string, unknown> = {}, token = ACCESS_A) => await bodyOf(await gatewayPost(tenants.t, "/gateway/tex/dev", { accessToken: token, action, args }));
  return { ...tenants, staff, pinned, dev };
}

describe("tex_dev drafts", () => {
  test("an editor of the pinned context makes, reads and edits a draft, and sees it in the list", async () => {
    const { dev } = await world();
    const made = await dev("create", { name: "Lighter reviewer", graph: JSON.stringify(GRAPH) });
    expect(made).toMatchObject({ status: "ok", rev: 1, name: "Lighter reviewer" });
    const id = made.id as string;
    const edited = await dev("edit", { draft: id, rev: 1, ops: [{ op: "set", node: "reviewer", field: "effort", value: "medium" }] });
    expect(edited).toMatchObject({ status: "ok", rev: 2 });
    expect((edited.said as string[])[0]).toBe("set reviewer effort high → medium");
    const got = await dev("get", { draft: id });
    expect(JSON.parse(got.graph as string).nodes[1].effort).toBe("medium");
    expect(got).toMatchObject({ rev: 2, live: { client: expect.any(String) } });
    const list = await dev("list");
    expect((list.drafts as Array<{ id: string }>).map((d) => d.id)).toContain(id);
  });

  test("a stranger, a plain member of the pinned context and Context's own clients (Tex's among them) are refused", async () => {
    const w = await world();
    expect(await w.dev("list", {}, ACCESS_B)).toEqual({ status: "refused" });
    const m = await world("member");
    expect(await m.dev("list")).toEqual({ status: "refused" });
    // An editor of the pinned context who is not staff: the Lab's drafts are staff's, so refused.
    vi.stubEnv("ADMIN_EMAILS", STAFF);
    expect(await w.dev("list")).toEqual({ status: "refused" });
    vi.stubEnv("ADMIN_EMAILS", `${STAFF},alice@example.invalid`);
    const tex = await world();
    // One of Context's own clients (Tex's texting clients are the same `context_*` family), registered like any other.
    await registerClient(tex.t, "context_console");
    await tex.t.run(async (ctx) => {
      await ctx.db.patch(tex.grantA, { clientId: "context_console" });
    });
    expect(await tex.dev("list")).toEqual({ status: "refused" });
  });

  test("edits to different fields both land; the later edit to the same field is refused with what is there", async () => {
    const { dev } = await world();
    const id = (await dev("create", { name: "Two hands", graph: JSON.stringify(GRAPH) })).id as string;
    expect(await dev("edit", { draft: id, rev: 1, ops: [{ op: "set", node: "fd", field: "effort", value: "medium" }] })).toMatchObject({ status: "ok", rev: 2 });
    // Made against revision 1 too, on another field: lands.
    expect(await dev("edit", { draft: id, rev: 1, ops: [{ op: "set", node: "reviewer", field: "on", value: false }] })).toMatchObject({ status: "ok", rev: 3 });
    // Made against revision 1, on the field revision 2 changed: refused.
    const lost = await dev("edit", { draft: id, rev: 1, ops: [{ op: "set", node: "fd", field: "effort", value: "high" }] });
    expect(lost).toMatchObject({ status: "conflict", rev: 3, keys: ["n:fd:effort"], now: { "n:fd:effort": "medium" } });
    // Removing a step conflicts with an edit to its wire made since.
    expect(await dev("edit", { draft: id, rev: 3, ops: [{ op: "wire", from: "fd", to: "reviewer", mode: "wait", when: ["answered"] }] })).toMatchObject({ status: "ok", rev: 4 });
    expect(await dev("edit", { draft: id, rev: 3, ops: [{ op: "remove", node: "reviewer" }] })).toMatchObject({ status: "conflict" });
    // A malformed edit says why and changes nothing.
    const bad = await dev("edit", { draft: id, rev: 4, ops: [{ op: "set", node: "nope", field: "on", value: true }] });
    expect(bad).toMatchObject({ status: "bad_request" });
    expect((await dev("get", { draft: id })).rev).toBe(4);
  });

  test("the AI reads what the Lab changed, and the Lab reads what the AI changed", async () => {
    const { t, dev, staff } = await world();
    const id = (await dev("create", { name: "Together", graph: JSON.stringify(GRAPH) })).id as string;
    const lab = withSession(t, staff);
    const labEdit = await lab.mutation(api.functions.texLabDrafts.applyEdits, { versionId: id, baseRev: 1, ops: JSON.stringify([{ op: "set", node: "fd", field: "model", value: "sonnet-5-5" }]) });
    expect(labEdit).toMatchObject({ status: "ok", rev: 2 });
    // The AI's next edit carries the Lab's change.
    const ai = await dev("edit", { draft: id, rev: 1, ops: [{ op: "move", node: "reviewer", x: 300, y: 40 }] });
    expect(ai).toMatchObject({ status: "ok", rev: 3 });
    expect((ai.others as Array<{ via: string; said: string[] }>).map((c) => [c.via, c.said[0]])).toEqual([["lab", "set fd model haiku-5-5 → sonnet-5-5"]]);
    const seen = await dev("changes", { draft: id, since: 2 });
    expect((seen.changes as Array<{ rev: number }>).map((c) => c.rev)).toEqual([3]);
    const labSees = await lab.query(api.functions.texLabDrafts.changes, { versionId: id, since: 2 });
    expect(labSees.changes.map((c) => c.said[0])).toEqual(["moved reviewer"]);
    expect(labSees.live?.client).toBeTruthy();
    // A whole save from the Lab records what it changed.
    const row = (await lab.query(api.functions.texLab.list, {})).versions.find((v) => v.versionId === id)!;
    const g = JSON.parse(row.graph);
    g.nodes[0].on = false;
    await lab.mutation(api.functions.texLab.saveVersion, { versionId: id, name: row.name, graph: JSON.stringify(g), picks: row.picks, results: row.results, createdAt: row.createdAt });
    const after = await dev("changes", { draft: id, since: 3 });
    expect((after.changes as Array<{ said: string[]; via: string }>)[0]).toMatchObject({ via: "lab", said: ["set fd on true → false"] });
  });

  test("promote asks once, like the Lab's button", async () => {
    const { t, dev, staff } = await world();
    const id = (await dev("create", { name: "Ship it", graph: JSON.stringify(GRAPH) })).id as string;
    expect(await dev("promote", { draft: id })).toEqual({ status: "ok", promote: "asked" });
    const row = (await withSession(t, staff).query(api.functions.texLab.list, {})).versions.find((v) => v.versionId === id)!;
    expect(row.promote?.state).toBe("asked");
    expect(await dev("get", { draft: "vnothere" })).toEqual({ status: "not_found" });
  });
  test("the Lab's Tools and Tests tabs: tool stats, and case edits kept for every staff member", async () => {
    const { t, dev, staff } = await world();
    expect(await dev("tool_stats", { days: 7 })).toMatchObject({ status: "ok", stats: expect.any(Object) });
    expect(await dev("case", { key: "core/q9", data: '{"area":"core","id":"q9","ask":"x","expect":"y"}' })).toEqual({ status: "ok" });
    expect(((await dev("cases")).caseEdits as Array<{ key: string }>).map((c) => c.key)).toEqual(["core/q9"]);
    expect((await withSession(t, staff).query(api.functions.texLab.list, {})).caseEdits.map((c) => c.key)).toEqual(["core/q9"]);
    expect(await dev("case", { key: "../etc", data: "{}" })).toMatchObject({ status: "bad_request" });
    expect(await dev("case", { key: "core/q9", data: null })).toEqual({ status: "ok" });
    expect((await dev("cases")).caseEdits).toEqual([]);
  });

  test("the Lab's Compare: every version's graph and results with main's runs, read without marking the AI in each", async () => {
    const { t, dev, staff } = await world();
    const a = (await dev("create", { name: "One", graph: JSON.stringify(GRAPH) })).id as string;
    const b = (await dev("create", { name: "Two", graph: JSON.stringify(GRAPH) })).id as string;
    const lab = withSession(t, staff);
    const results = JSON.stringify([{ at: 1, areas: { core: { practice: [3, 4], held: [1, 2], usd: 0 } }, raw: "" }]);
    await lab.mutation(api.functions.texLab.saveVersion, { versionId: "main", name: "main", graph: '{"nodes":[],"edges":[]}', picks: "{}", results, createdAt: 1 });
    await t.run(async (ctx) => {
      for (const r of await ctx.db.query("texLabVersions").collect()) if (r.versionId !== "main") await ctx.db.patch(r._id, { live: undefined });
    });
    const all = await dev("versions");
    expect(all).toMatchObject({ status: "ok", main: { results } });
    expect((all.drafts as Array<{ id: string; graph: string }>).map((d) => d.id).sort()).toEqual([a, b].sort());
    expect(JSON.parse((all.drafts as Array<{ graph: string }>)[0].graph).nodes).toHaveLength(2);
    expect((all.drafts as Array<{ live: unknown }>).every((d) => d.live === null)).toBe(true);
    expect(((await dev("versions", { drafts: [b] })).drafts as Array<{ id: string }>).map((d) => d.id)).toEqual([b]);
    expect(await dev("versions", {}, ACCESS_B)).toEqual({ status: "refused" });
  });
});
