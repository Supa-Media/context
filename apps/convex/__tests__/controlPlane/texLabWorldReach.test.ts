/**
 * Made-up group chats on main (`functions/lib/texLabWorldReach.ts`; Dev, 2026-11-24: "test main"). The people live only
 * in the test chat; what their chat reaches is the Lab user's own shared workspaces, narrowed by the real group rule.
 * The attack: a made-up role can never add a workspace, a personal one, the pin, or a role above the Lab user's own.
 *
 * Sabotage (temporary local edits, reverted, 2026-11-24):
 *   `worldWorkspaces` without the kind check              "never personal ..." fails
 *   `worldReach` starting the role at "owner"            "... at the lowest role, never above the Lab user's" fails
 *   `standing` counting a guest as standing               "a guest keeps every workspace out ..." fails
 *   the scopes filter removed                              "team tier ..." fails
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { addMember, createUser, createWorkspace, gatewayPost } from "../fixtures.helpers";
import type { Id } from "../../_generated/dataModel";
import { reachOf } from "../../functions/lib/textGroupReach";
import { bodyOf, registerClient, seedConnectedClient, token, twoConnectedTenants } from "./fixtures.helpers";

vi.setConfig({ testTimeout: 30_000 });

const STAFF = "staff@example.invalid";
beforeEach(() => vi.stubEnv("ADMIN_EMAILS", `${STAFF},alice@example.invalid`));
afterEach(() => vi.unstubAllEnvs());

const CONSOLE = token("lab_console");
const TEXTING = token("lab_texting");
const CHAT = "lab-world-0123456789abcdef";
const keyOf = async (id: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lab-world:${id}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");

type Reach = { status: string; reach: string[]; unshared?: string[]; blocked: { slug: string; who: string; why: string }[]; workspaces: { slug: string }[]; session: { clientId: string; scopes: string[]; defaultWorkspaceId: string; texChatId?: string; workspaces: { workspaceId: string; slug: string; role: string; setupOnly?: true; homeOnly?: true; grantedNames?: string[] }[] } };

async function world() {
  const tenants = await twoConnectedTenants();
  const staff = await createUser(tenants.t, STAFF);
  const pinned = await createWorkspace(tenants.t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
  await addMember(tenants.t, pinned, tenants.alice, "editor", staff);
  const lumio = await createWorkspace(tenants.t, staff, "lumio-test", { kind: "shared", displayName: "Lumio" });
  await addMember(tenants.t, lumio, tenants.alice, "editor", staff);
  const solenne = await createWorkspace(tenants.t, tenants.alice, "solenne-test", { kind: "shared" });
  // Bob's own workspace: Alice isn't in it, so no made-up role can reach it.
  const bobs = await createWorkspace(tenants.t, tenants.bob, "bobs-shared", { kind: "shared" });
  await registerClient(tenants.t, "context_console");
  await seedConnectedClient(tenants.t, { workspaceId: tenants.aliceWs, userId: tenants.alice, clientId: "context_console", accessToken: CONSOLE });
  await registerClient(tenants.t, "context_texts");
  await seedConnectedClient(tenants.t, { workspaceId: tenants.aliceWs, userId: tenants.alice, clientId: "context_texts", accessToken: TEXTING, scopes: ["context:read", "context:write", "context:private"] });
  const lab = async (action: string, args: Record<string, unknown> = {}) =>
    await bodyOf(await gatewayPost(tenants.t, "/gateway/tex/lab-sandbox", { accessToken: CONSOLE, action, args }));
  return { ...tenants, pinned, lumio, solenne, bobs, lab };
}

const slugs = (r: Reach) => r.session.workspaces.map((w) => w.slug);

describe("made-up group chats on main", () => {
  test("the workspaces a made-up chat could reach are the Lab user's shared ones: never personal, never the pin, never someone else's", async () => {
    const w = await world();
    const got = (await w.lab("worldWorkspaces")) as { status: string; workspaces: { slug: string; name: string }[] };
    expect(got).toEqual({ status: "ok", preview: false, workspaces: [{ slug: "lumio-test", name: "Lumio" }, { slug: "solenne-test", name: "solenne-test" }] });
  });

  test("everyone on Context in a workspace reaches it, at the lowest role, never above the Lab user's", async () => {
    const w = await world();
    const r = (await w.lab("worldReach", { chat: CHAT, people: [
      { name: "Ana", account: "on", roles: { "lumio-test": "owner", "solenne-test": "owner" } },
      { name: "Ben", account: "on", roles: { "lumio-test": "owner", "solenne-test": "member" } },
    ] })) as Reach;
    expect(r.status).toBe("ok");
    expect(r.reach).toEqual(["lumio-test", "solenne-test"]);
    const lumio = r.session.workspaces.find((x) => x.slug === "lumio-test")!;
    // Alice is an editor of Lumio: two made-up owners don't lift her.
    expect(lumio.role).toBe("editor");
    expect(r.session.workspaces.find((x) => x.slug === "solenne-test")!.role).toBe("member");
    // The default is the pin read as the chat, at a home's editor hand, so a group turn's texts can be posted.
    expect(r.session.defaultWorkspaceId).toBe(w.pinned);
  });

  // A text reads its sender's own reach (Dev2, 2026-11-25, `asker-reach.md`), as a real chat's does.
  test("a text reads its asker's own workspaces at the asker's role, and names who here isn't in them", async () => {
    const w = await world();
    const people = [
      { name: "Ana", account: "on", roles: { "lumio-test": "editor", "solenne-test": "owner" } },
      { name: "Ben", account: "on", roles: { "solenne-test": "member" } },
      { name: "Cy", account: "off" },
    ];
    const ana = (await w.lab("worldReach", { chat: CHAT, people, asker: "Ana" })) as Reach;
    expect(ana.reach).toEqual(["lumio-test", "solenne-test"]);
    // Ana's own role, never above the Lab user's (Alice edits Lumio and owns Solenne).
    expect(ana.session.workspaces.find((x) => x.slug === "solenne-test")!.role).toBe("owner");
    expect(ana.blocked.filter((b) => b.slug === "lumio-test").map((b) => b.who)).toEqual(["Ben", "Cy"]);
    // What the asker reads that someone here isn't in, as a real chat names it, for the Room check (Dev2, 2026-11-26).
    expect(ana.unshared).toContain("lumio-test");
    const ben = (await w.lab("worldReach", { chat: CHAT, people, asker: "ben" })) as Reach;
    expect(ben.reach).toEqual(["solenne-test"]);
    expect(slugs(ben)).not.toContain("lumio-test");
    expect(ben.session.workspaces.find((x) => x.slug === "solenne-test")!.role).toBe("member");
    // Nothing of Lumio is named to Ben's ask: it isn't his.
    expect(JSON.stringify(ben.blocked)).not.toContain("lumio-test");
    // Someone with no account reads nothing; nobody named reads the chat's reach (none, with Cy here).
    expect(((await w.lab("worldReach", { chat: CHAT, people, asker: "Cy" })) as Reach).reach).toEqual([]);
    expect(((await w.lab("worldReach", { chat: CHAT, people })) as Reach).reach).toEqual([]);
  });

  test("never personal, never someone else's, and the pin only as Tex's setup", async () => {
    const w = await world();
    const r = (await w.lab("worldReach", { chat: CHAT, people: [
      { name: "Ana", account: "on", roles: { "bobs-shared": "owner", [PINNED_CONTEXT_SLUG]: "owner", "alice": "owner", "lumio-test": "member" } },
    ] })) as Reach;
    expect(r.reach).toEqual(["lumio-test"]);
    expect(slugs(r).sort()).toEqual([PINNED_CONTEXT_SLUG, "lumio-test"].sort());
    expect(r.session.workspaces[0]).toEqual({ workspaceId: w.pinned, slug: PINNED_CONTEXT_SLUG, role: "editor", kind: "shared", homeOnly: true, grantedNames: ["#reads-as-chat", "#lab-world-no-home"] });
    const ids = r.session.workspaces.map((x) => x.workspaceId);
    expect(ids).not.toContain(w.aliceWs);
    expect(ids).not.toContain(w.bobs);
  });

  test("a guest keeps every workspace out; a person invited by number counts for that workspace", async () => {
    const w = await world();
    const guest = (await w.lab("worldReach", { chat: CHAT, people: [
      { name: "Dan", account: "on", roles: { "lumio-test": "editor" } },
      { name: "Eve", account: "off" },
    ] })) as Reach;
    expect(guest.reach).toEqual([]);
    expect(guest.blocked).toContainEqual({ slug: "lumio-test", who: "Eve", why: "no_account" });
    expect(guest.blocked).toContainEqual({ slug: "solenne-test", who: "Dan", why: "not_member" });
    // Nothing reached: the pin read as the chat with no home, as a home-only grant's is, so every row there is private.
    expect(guest.session.workspaces).toEqual([{ workspaceId: w.pinned, slug: PINNED_CONTEXT_SLUG, role: "editor", kind: "shared", homeOnly: true, grantedNames: ["#reads-as-chat", "#lab-world-no-home"] }]);
    expect(guest.session.defaultWorkspaceId).toBe(w.pinned);
    const invited = (await w.lab("worldReach", { chat: CHAT, people: [
      { name: "Dan", account: "on", roles: { "lumio-test": "editor" } },
      { name: "Fay", account: "invited", invited: { slug: "lumio-test", role: "member" } },
    ] })) as Reach;
    expect(invited.reach).toEqual(["lumio-test"]);
    expect(invited.session.workspaces.find((x) => x.slug === "lumio-test")!.role).toBe("member");
  });

  test("team tier, under a group's client, on the made-up chat's own key and never the 1:1's, with no token", async () => {
    const w = await world();
    const r = (await w.lab("worldReach", { chat: CHAT, people: [{ name: "Ana", account: "on", roles: { "lumio-test": "editor" } }] })) as Reach;
    expect(r.session.scopes).not.toContain("context:private");
    expect(r.session.scopes).toContain("context:read");
    expect(r.session.clientId).toBe("context_texts_group");
    // Its own chat, worked out from the made-up chat's id: never the 1:1's.
    expect(r.session.texChatId).toBe(await keyOf(CHAT));
    expect(JSON.stringify(r)).not.toContain(TEXTING);
  });

  // The attack: a caller naming a real chat's key to read its Tex notes. The key is never taken from the caller, and
  // one a real chat has is refused.
  test("the chat's key is worked out here, and one a real chat has is refused", async () => {
    const w = await world();
    const people = [{ name: "Ana", account: "on", roles: { "lumio-test": "editor" } }];
    expect(await w.lab("worldReach", { people })).toMatchObject({ status: "bad_request" });
    const real = "a".repeat(64);
    expect(await w.lab("worldReach", { chat: real, people })).toMatchObject({ status: "bad_request" });
    const taken = "lab-world-fedcba9876543210";
    await w.t.run(async (ctx) => {
      await ctx.db.insert("textGroups", { groupKey: await keyOf(taken), homeUsers: [w.bob], lastSeenAt: Date.now() } as never);
    });
    expect(await w.lab("worldReach", { chat: taken, people })).toMatchObject({ status: "refused" });
  });

  test("people of the wrong shape are refused", async () => {
    const w = await world();
    expect(await w.lab("worldReach", { chat: CHAT, people: "Ana" })).toMatchObject({ status: "bad_request" });
    expect(await w.lab("worldReach", { chat: CHAT, people: [{ name: "", account: "on" }] })).toMatchObject({ status: "bad_request" });
    expect(await w.lab("worldReach", { chat: CHAT, people: Array.from({ length: 9 }, (_, i) => ({ name: `P${i}`, account: "off" })) })).toMatchObject({ status: "bad_request" });
  });

  // The copy of the rule must not drift from the real one (`lib/textGroupReach.ts` `reachOf`): the same people as real
  // accounts, with the Lab user in the chat as its sponsor, reach the same workspaces at the same roles.
  test("a made-up chat reaches what the real rule gives the same people as accounts", async () => {
    const w = await world();
    const roles = { ana: { "lumio-test": "owner", "solenne-test": "member" }, ben: { "lumio-test": "member", "solenne-test": "editor" } } as const;
    const ids = { "lumio-test": w.lumio, "solenne-test": w.solenne };
    const users: Id<"users">[] = [];
    for (const [name, held] of Object.entries(roles)) {
      const id = await createUser(w.t, `${name}@example.invalid`);
      for (const [slug, role] of Object.entries(held)) await addMember(w.t, ids[slug as keyof typeof ids], id, role);
      users.push(id);
    }
    const real = await w.t.run(async (ctx) => (await reachOf(ctx, null as never, [...users, w.alice])).map((r) => [r.workspace.slug, r.role]));
    const made = (await w.lab("worldReach", { chat: CHAT, people: Object.entries(roles).map(([name, held]) => ({ name, account: "on", roles: held })) })) as Reach;
    expect(made.session.workspaces.filter((x) => !x.homeOnly).map((x) => [x.slug, x.role])).toEqual(real);
    expect(real.length).toBe(2);
  });
});
