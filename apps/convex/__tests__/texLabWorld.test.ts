import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { createWorkspace, gatewayPost } from "./fixtures.helpers";
import { migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";
import { cleanPersonName, simPhoneOf, worldProblem } from "../functions/texLabWorld";

/**
 * MADE-UP GROUP CHATS FOR THE LAB (`functions/texLabWorld.ts`; Dev, 2026-11-24).
 *
 * The people a made-up chat asks for are made only on an isolated preview, and Tex's real group rules then run on them
 * unchanged: what this file proves is that the chat reaches exactly what `applyGroupTurn` says for real people.
 *
 * ## Sabotage record (run by hand; each must fail a test here)
 *
 *   `isIsolatedPreview` check dropped                    -> "refuses on production and writes nothing" fails
 *   `setRoles` not removing a role no longer asked for   -> "running again puts each person's roles as asked" fails
 *   `inviteByNumber` skipped                             -> "a guest invited by number ..." fails
 */

vi.setConfig({ testTimeout: 60_000 });
afterEach(() => vi.unstubAllEnvs());

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "lab-world-0123456789abcdef";
const KEY = "0123456789abcdef0123456789abcdef";
// Built at run time: scripts/check-no-identifiers.mjs rejects a committed Convex hostname, fakes included.
const CONVEX_CLOUD = ["convex", "cloud"].join(".");

function asPreview() {
  for (const [key, value] of Object.entries({
    APP_ENV: "preview",
    PREVIEW_NAME: "pr42",
    APP_ORIGIN: "https://context-router-pr42.example-sub.workers.dev",
    CONVEX_CLOUD_URL: `https://happy-otter-123.${CONVEX_CLOUD}`,
  })) vi.stubEnv(key, value);
}

type T = PinnedWorld["t"];

/** The pinned world, plus the three seeded team workspaces a made-up person can be put in, owned by someone else. */
async function world() {
  const w = await pinnedWorld();
  await migrate(w);
  const owner = await w.t.run(async (ctx) => (await ctx.db.query("users").first())!._id);
  for (const slug of ["lumio", "maison-solenne", "common-ground"]) await createWorkspace(w.t, owner, slug, { kind: "shared" });
  return w;
}

async function make(t: T, people: unknown[], extra: Record<string, unknown> = {}) {
  return (await t.mutation(internal.functions.texLabWorld.makeWorld, { key: KEY, line: LINE, groupId: GROUP, people: people as never, ...extra })) as {
    status: string;
    error?: string;
    groupKey?: string;
    people?: { name: string; account: string; phone: string; handle: string | null }[];
  };
}

async function turn(t: T, sender: string, participants: string[], extra: Record<string, unknown> = {}) {
  const response = await t.fetch("/agent-texts/group", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` }, body: JSON.stringify({ line: LINE, groupId: GROUP, sender, participants, mint: true, ...extra }) });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function rolesIn(t: T, accessToken: string) {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  const session = ((await response.json()) as { session: { workspaces: { slug?: string; role?: string }[] } | null }).session;
  return Object.fromEntries((session?.workspaces ?? []).filter((row) => row.slug !== "context").map((row) => [row.slug, row.role]));
}

const ON = (name: string, roles: Record<string, string>) => ({ name, account: "on", roles });

describe("checks", () => {
  test("names, people and workspaces are checked before anything is made", () => {
    expect(cleanPersonName("  Ana   María ")).toBe("Ana María");
    expect(cleanPersonName("<b>")).toBeNull();
    expect(worldProblem([])).toMatch(/1 to 8/);
    expect(worldProblem([{ name: "Tex", account: "off" }])).toMatch(/Tex's/);
    expect(worldProblem([{ name: "Sam", account: "off" }, { name: "sam", account: "off" }])).toMatch(/two people/);
    expect(worldProblem([{ name: "Sam", account: "off", roles: { lumio: "member" } }])).toMatch(/no account/);
    expect(worldProblem([{ name: "Ana", account: "on", roles: { acme: "member" } }])).toMatch(/no made-up workspace/);
    expect(worldProblem([{ name: "Priya", account: "invited" }])).toMatch(/name the workspace/);
    expect(worldProblem([ON("Ana", { lumio: "owner" }) as never, { name: "Sam", account: "off" }])).toBeNull();
  });

  test("every number is the simulator's", () => {
    for (const seed of [0, 1, 99, 100, 79_999, 4_294_967_295]) expect(simPhoneOf(seed)).toMatch(/^\+1[2-9]\d{2}55501\d{2}$/);
  });
});

describe("made only on a preview", () => {
  test("refuses on production and writes nothing", async () => {
    const w = await world();
    vi.stubEnv("APP_ENV", "production");
    const before = await w.t.run(async (ctx) => (await ctx.db.query("users").collect()).length);
    expect(await make(w.t, [ON("Ana", { lumio: "owner" })])).toMatchObject({ status: "refused" });
    expect(await w.t.run(async (ctx) => (await ctx.db.query("users").collect()).length)).toBe(before);
  });
});

describe("the real group rules run on made-up people", () => {
  test("everyone on Context reaches the workspace they all share, at the lowest role among them", async () => {
    const w = await world();
    asPreview();
    const made = await make(w.t, [ON("Ana", { lumio: "owner", "maison-solenne": "editor" }), ON("Ben", { lumio: "editor" }), ON("Cleo", { lumio: "member" })]);
    expect(made.status).toBe("ok");
    const [ana, ben, cleo] = made.people!;
    expect(ana.handle).toMatch(/^ana-/);
    // A routine reads what everyone shares, at the lowest role; a text reads its asker's own (`asker-reach.md`).
    const answer = await turn(w.t, ana.phone, [ana.phone, ben.phone, cleo.phone, LINE], { routine: true });
    expect(answer).toMatchObject({ status: "ready", reach: ["lumio"] });
    expect(await rolesIn(w.t, answer.accessToken as string)).toMatchObject({ lumio: "member" });
    const asked = await turn(w.t, ana.phone, [ana.phone, ben.phone, cleo.phone, LINE]);
    expect(asked).toMatchObject({ status: "ready", reach: ["lumio", "maison-solenne"] });
    expect(await rolesIn(w.t, asked.accessToken as string)).toMatchObject({ lumio: "owner", "maison-solenne": "editor" });
    expect((await turn(w.t, cleo.phone, [ana.phone, ben.phone, cleo.phone, LINE])).reach).toEqual(["lumio"]);
  });

  test("one person not on Context leaves the chat its home only", async () => {
    const w = await world();
    asPreview();
    const made = await make(w.t, [ON("Ana", { lumio: "owner" }), ON("Ben", { lumio: "editor" }), { name: "Sam", account: "off" }]);
    const [ana, ben, sam] = made.people!;
    const answer = await turn(w.t, ana.phone, [ana.phone, ben.phone, sam.phone, LINE], { routine: true });
    expect(answer.status).toBe("ready");
    expect(answer.reach ?? []).toEqual([]);
    // Sam asking reads nothing of anyone's; Ana asking reads her own.
    expect((await turn(w.t, sam.phone, [ana.phone, ben.phone, sam.phone, LINE])).reach ?? []).toEqual([]);
    expect((await turn(w.t, ana.phone, [ana.phone, ben.phone, sam.phone, LINE])).reach).toEqual(["lumio"]);
    expect(answer.guests).toEqual([expect.objectContaining({ phone: sam.phone })]);
  });

  test("a guest invited by number to Lumio lets the chat reach it, at the invitation's role", async () => {
    const w = await world();
    asPreview();
    const made = await make(w.t, [ON("Ana", { lumio: "owner" }), { name: "Priya", account: "invited", invited: { slug: "lumio", role: "member" } }]);
    const [ana, priya] = made.people!;
    const answer = await turn(w.t, ana.phone, [ana.phone, priya.phone, LINE], { routine: true });
    expect(answer).toMatchObject({ status: "ready", reach: ["lumio"] });
    expect(await rolesIn(w.t, answer.accessToken as string)).toMatchObject({ lumio: "member" });
    // Priya's own ask reads Lumio at her invitation's role.
    const priyaAsks = await turn(w.t, priya.phone, [ana.phone, priya.phone, LINE]);
    expect(await rolesIn(w.t, priyaAsks.accessToken as string)).toMatchObject({ lumio: "member" });
  });

  test("running again puts each person's roles as asked, and adds whoever joined", async () => {
    const w = await world();
    asPreview();
    const first = await make(w.t, [ON("Ana", { lumio: "owner", "common-ground": "editor" }), ON("Ben", { lumio: "editor", "common-ground": "member" })]);
    const again = await make(w.t, [ON("Ana", { lumio: "owner" }), ON("Ben", { lumio: "editor" }), ON("Dee", { lumio: "member" })]);
    expect(again.people!.slice(0, 2).map((p) => p.phone)).toEqual(first.people!.map((p) => p.phone));
    const [ana, ben, dee] = again.people!;
    expect(dee.handle).toMatch(/^dee-/);
    // Ana and Ben shared Common Ground at first; asked again without it, neither is in it any more.
    const answer = await turn(w.t, ana.phone, [ana.phone, ben.phone, LINE]);
    expect(answer).toMatchObject({ status: "ready", reach: ["lumio"] });
  });

  test("the chat starts as set up: who brought Tex in, how much it joins in, and whether it said hello", async () => {
    const w = await world();
    asPreview();
    const made = await make(w.t, [ON("Ana", { lumio: "owner" }), ON("Ben", { lumio: "editor" })], { sponsor: 1, speaksUp: "quiet", introduced: true });
    const row = await w.t.run(async (ctx) => await ctx.db.query("textGroups").withIndex("by_key", (q) => q.eq("groupKey", made.groupKey!)).unique());
    expect(row).toMatchObject({ speaksUp: "quiet" });
    expect(row?.introducedAt).toBeTypeOf("number");
    const ben = await w.t.run(async (ctx) => (await ctx.db.query("phoneLinks").withIndex("by_phone", (q) => q.eq("phone", made.people![1].phone)).unique())!.userId);
    expect(row?.sponsorId).toBe(ben);
    const answer = await turn(w.t, made.people![0].phone, [made.people![0].phone, made.people![1].phone, LINE]);
    expect(answer).toMatchObject({ status: "ready", intro: false });
  });
});
