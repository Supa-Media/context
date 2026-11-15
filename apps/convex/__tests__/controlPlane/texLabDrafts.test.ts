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
 *   `revertDraft` without its conflicts() check   "revert undoes one change ..., refuses one a later change built on" fails
 *   `keepResults` keeping the whole pasted text   "keep_results ... never keeps a replay" fails
 *   `changesAfter` answering the short lines      "changes answers each line whole" fails
 *   `before` answering the draft's own graph      "... the draft before each revision is kept for the marks" fails
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

  // Dev2, 2026-11-15: a revision's changes are marked on the graph, against main or the draft before that revision.
  test("each change names the steps it touched, and the draft before each revision is kept for the marks", async () => {
    const { t, dev, staff } = await world();
    const id = (await dev("create", { name: "Marked", graph: JSON.stringify(GRAPH) })).id as string;
    await dev("edit", { draft: id, rev: 1, ops: [{ op: "set", node: "reviewer", field: "effort", value: "medium" }] });
    const lab = withSession(t, staff);
    const seen = await lab.query(api.functions.texLabDrafts.changes, { versionId: id, since: 1 });
    expect(seen.changes[0].keys.some((k) => k.startsWith("n:reviewer"))).toBe(true);
    const before = await lab.query(api.functions.texLabDrafts.graphBefore, { versionId: id, rev: 2 });
    expect(JSON.parse(before!).nodes[1].effort).toBe("high");
    expect(await lab.query(api.functions.texLabDrafts.graphBefore, { versionId: id, rev: 9 })).toBeNull();
    // The MCP's `before` reads the same kept graph (`tex_dev marks vs: "last"`), the current revision by default.
    const last = await dev("before", { draft: id });
    expect([last.status, last.rev, JSON.parse(last.graph as string).nodes[1].effort]).toEqual(["ok", 2, "high"]);
    expect((await dev("before", { draft: id, rev: 9 })).graph).toBeNull();
    expect((await dev("before", { draft: "nope" })).status).toBe("not_found");
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
    // A step's own case (area `node:<step>`) is kept the same way; nothing else may lead the key.
    expect(await dev("case", { key: "node:egress/new-1", data: '{"area":"node:egress","id":"new-1"}' })).toEqual({ status: "ok" });
    expect(await dev("case", { key: "node:../x/new-1", data: "{}" })).toMatchObject({ status: "bad_request" });
    expect(await dev("case", { key: "node:egress/new-1", data: null })).toEqual({ status: "ok" });
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

describe("tex_dev: the Lab's other writes", () => {
  const REPORT = "## Lab run\nTex replay: ✅ all held\n**core:** practice 4/5 right, held-out 3/3 right; spent about $0.12.\n";

  test("rename is a revision with its line, from either door", async () => {
    const { t, dev, staff } = await world();
    const id = (await dev("create", { name: "Old name", graph: JSON.stringify(GRAPH) })).id as string;
    expect(await dev("rename", { draft: id, name: "  New name " })).toMatchObject({ status: "ok", rev: 2, name: "New name", said: ["renamed Old name → New name"] });
    expect(await dev("rename", { draft: id, name: " " })).toMatchObject({ status: "bad_request" });
    // The Lab's own rename (a whole save) records the same line.
    const lab = withSession(t, staff);
    const row = (await lab.query(api.functions.texLab.list, {})).versions.find((v) => v.versionId === id)!;
    expect(row.name).toBe("New name");
    await lab.mutation(api.functions.texLab.saveVersion, { versionId: id, name: "Lab name", graph: row.graph, picks: row.picks, results: row.results, createdAt: row.createdAt });
    expect(((await dev("changes", { draft: id, since: 2 })).changes as Array<{ said: string[] }>)[0].said).toEqual(["renamed New name → Lab name"]);
  });

  test("delete takes the draft and its change list; main is never deleted, from either door", async () => {
    const { t, dev, staff } = await world();
    const id = (await dev("create", { name: "Gone soon", graph: JSON.stringify(GRAPH) })).id as string;
    expect(await dev("delete", { draft: id })).toEqual({ status: "ok", deleted: id, name: "Gone soon" });
    expect(await dev("get", { draft: id })).toEqual({ status: "not_found" });
    const left = await t.run(async (ctx) => (await ctx.db.query("texLabChanges").collect()).filter((c) => c.versionId === id).length);
    expect(left).toBe(0);
    expect(await dev("delete", { draft: "main" })).toMatchObject({ status: "bad_request" });
    await expect(withSession(t, staff).mutation(api.functions.texLab.deleteVersion, { versionId: "main" })).rejects.toThrow();
  });

  test("run_setup keeps the Run tab's picks and areas as the Lab does, merged by area, and the Lab's own setup lands", async () => {
    const { t, dev, staff } = await world();
    const id = (await dev("create", { name: "Picky", graph: JSON.stringify(GRAPH) })).id as string;
    const set = await dev("run_setup", { draft: id, picks: { core: ["q1", "q2"], group: [] }, areas: ["core", "group"] });
    expect(set).toMatchObject({ status: "ok", rev: 2, picks: { core: ["q1", "q2"], group: [] }, areas: ["core", "group"] });
    expect(set.said).toEqual(["set the run's core cases to q1, q2", "set the run's group cases to none", "set the run's areas to core, group"]);
    // Merged by area; null for an area ticks every case again, and null areas go back to the ones its changes touch.
    expect(await dev("run_setup", { draft: id, picks: { group: null }, areas: null })).toMatchObject({ status: "ok", rev: 3, picks: { core: ["q1", "q2"] }, areas: null });
    const got = await dev("get", { draft: id });
    expect([JSON.parse(got.picks as string), got.areas]).toEqual([{ core: ["q1", "q2"] }, null]);
    expect(await dev("run_setup", { draft: id, picks: { "../x": [] } })).toMatchObject({ status: "bad_request" });
    expect(await dev("run_setup", { draft: id })).toMatchObject({ status: "bad_request" });
    // The Lab sends its whole setup on a live draft (it used to be dropped there).
    const lab = withSession(t, staff);
    expect(await lab.mutation(api.functions.texLabDrafts.setRunSetup, { versionId: id, picks: JSON.stringify({ mail: ["m1"] }), areas: JSON.stringify(["mail"]) })).toMatchObject({ status: "ok", rev: 4 });
    const row = (await lab.query(api.functions.texLab.list, {})).versions.find((v) => v.versionId === id)!;
    expect([JSON.parse(row.picks), JSON.parse(row.areas!)]).toEqual([{ mail: ["m1"] }, ["mail"]]);
    expect(((await dev("changes", { draft: id, since: 3 })).changes as Array<{ via: string }>)[0].via).toBe("lab");
  });

  test("keep_results reads the report with the Lab's reader, never keeps a replay, and main keeps its own", async () => {
    const { t, dev, staff } = await world();
    const id = (await dev("create", { name: "Scored", graph: JSON.stringify(GRAPH) })).id as string;
    const kept = await dev("keep_results", { draft: id, report: REPORT + "\n## Lab replay\nTheir own chat text", link: "https://example.invalid/run/1" });
    expect(kept).toMatchObject({ status: "ok", rev: 2, results: 1, kept: { pass: true, headline: "all held", regressed: 0, areas: { core: { practice: [4, 5], held: [3, 3], usd: 0.12 } } } });
    const results = JSON.parse((await dev("get", { draft: id })).results as string);
    expect(results[0]).toMatchObject({ link: "https://example.invalid/run/1", headline: "all held" });
    expect(results[0].raw).not.toMatch(/own chat/);
    expect(await dev("keep_results", { draft: id, report: "## Lab replay\nonly a replay" })).toMatchObject({ status: "bad_request" });
    // Main: kept on main's row, as saveMainResults does, and read back by get of main.
    expect(await dev("keep_results", { draft: "main", report: REPORT })).toMatchObject({ status: "ok", results: 1 });
    expect(JSON.parse((await dev("get", { draft: "main" })).results as string)).toHaveLength(1);
    expect((await withSession(t, staff).query(api.functions.texLab.list, {})).versions.find((v) => v.versionId === "main")).toBeTruthy();
  });

  test("revert undoes one change as a new revision, refuses one a later change built on, and goes back to a revision", async () => {
    const { dev } = await world();
    const id = (await dev("create", { name: "Undo me", graph: JSON.stringify(GRAPH) })).id as string;
    await dev("edit", { draft: id, rev: 1, ops: [{ op: "set", node: "fd", field: "effort", value: "medium" }] }); // 2
    await dev("edit", { draft: id, rev: 2, ops: [{ op: "remove", node: "reviewer" }] }); // 3
    await dev("rename", { draft: id, name: "Renamed" }); // 4
    await dev("keep_results", { draft: id, report: REPORT }); // 5
    await dev("edit", { draft: id, rev: 5, ops: [{ op: "set", node: "fd", field: "effort", value: "high" }] }); // 6
    // Rev 2's field changed again at rev 6: refused, naming it.
    const lost = await dev("revert", { draft: id, rev: 2 });
    expect(lost).toMatchObject({ status: "conflict", rev: 6, keys: ["n:fd:effort"] });
    expect((lost.later as Array<{ rev: number }>).map((c) => c.rev)).toEqual([6]);
    // Rev 3 (the removed step and its wire) comes back.
    const back = await dev("revert", { draft: id, rev: 3 });
    expect(back).toMatchObject({ status: "ok", rev: 7 });
    expect((back.said as string[])[0]).toMatch(/^undid rev 3: added step reviewer/);
    let g = JSON.parse((await dev("get", { draft: id })).graph as string);
    expect(g.nodes.map((n: { id: string }) => n.id)).toEqual(["fd", "reviewer"]);
    expect(g.edges).toHaveLength(1);
    // Kept results are a record: never undone.
    expect(await dev("revert", { draft: id, rev: 5 })).toMatchObject({ status: "bad_request", error: expect.stringMatching(/stay/) });
    // Back to rev 1: every change after it undone, newest first; the name too; the results stay.
    const whole = await dev("revert", { draft: id, to: 1 });
    expect(whole).toMatchObject({ status: "ok", rev: 8 });
    const got = await dev("get", { draft: id });
    g = JSON.parse(got.graph as string);
    expect([got.name, g.nodes[0].effort, g.nodes.length, JSON.parse(got.results as string).length]).toEqual(["Undo me", "low", 2, 1]);
    // A revert is itself a change that can be undone.
    expect(await dev("revert", { draft: id, rev: 8 })).toMatchObject({ status: "ok", rev: 9 });
    const again = await dev("get", { draft: id });
    expect([again.name, JSON.parse(again.graph as string).nodes[0].effort]).toEqual(["Renamed", "high"]);
    expect(await dev("revert", { draft: id, rev: 1 })).toMatchObject({ status: "bad_request" });
    expect(await dev("revert", { draft: id })).toMatchObject({ status: "bad_request" });
  });

  test("changes answers each line whole; the Lab's list keeps the short form", async () => {
    const { t, dev, staff } = await world();
    const id = (await dev("create", { name: "Wordy", graph: JSON.stringify(GRAPH) })).id as string;
    const goal = "answer the person with what they asked for, in their own words, ".repeat(3).trim();
    await dev("edit", { draft: id, rev: 1, ops: [{ op: "set", node: "fd", field: "goal", value: goal }] });
    const line = ((await dev("changes", { draft: id, since: 1 })).changes as Array<{ said: string[] }>)[0].said[0];
    expect(line.endsWith(goal)).toBe(true);
    const short = (await withSession(t, staff).query(api.functions.texLabDrafts.changes, { versionId: id, since: 1 })).changes[0].said[0];
    expect(short.length).toBeLessThan(line.length);
  });
});
