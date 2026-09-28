/**
 * OWNERS — the search behind a folder page's owner picker.
 *
 * An owner is a member of the workspace, an agent connected to it, or "any
 * agent". The picker asks the server as somebody types, so the properties
 * proved here are the ones a roster sent to the client would not have needed:
 *
 *  - it answers only a member, with the same refusal a missing workspace gets;
 *  - it only ever names people in *this* workspace;
 *  - it returns the few best matches, not the membership, however large;
 *  - an agent name is drawn only from grants the caller could already list,
 *    so an editor never learns a colleague's tooling from it.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { MAX_OWNER_SCAN } from "../functions/owners";
import { matchTier, preferWeight, rankMembers, resolveOwnerWords } from "../functions/lib/owners/rank";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedGrant,
  setupTest,
} from "./fixtures.helpers";

type T = ReturnType<typeof setupTest>;

async function person(t: T, email: string, name?: string): Promise<Id<"users">> {
  const id = await createUser(t, email);
  if (name !== undefined) await t.run((ctx) => ctx.db.patch(id, { name }));
  return id;
}

async function client(t: T, clientId: string, clientName: string, softwareId?: string): Promise<void> {
  await t.run((ctx) =>
    ctx.db.insert("oauthClients", {
      clientId,
      clientName,
      redirectUris: ["https://client.example.invalid/callback"],
      hashedClientSecret: null,
      ...(softwareId === undefined ? {} : { softwareId }),
      createdAt: Date.now(),
    }),
  );
}

async function team() {
  const t = setupTest();
  const owner = await person(t, "seyi@example.invalid", "Seyi Olujide");
  const editor = await person(t, "sayo@example.invalid", "Sayo");
  const john = await person(t, "john@example.invalid", "John Adé");
  const outsider = await person(t, "mallory@example.invalid", "Mallory Sayers");
  const workspaceId = await createWorkspace(t, owner, "team-context", { kind: "shared", displayName: "Team" });
  await addMember(t, workspaceId, editor, "editor", owner);
  await addMember(t, workspaceId, john, "member", owner);
  const other = await createWorkspace(t, outsider, "mallory-context");
  return { t, owner, editor, john, outsider, workspaceId, other };
}

const search = (t: T, userId: Id<"users">, workspaceId: Id<"workspaces">, query: string, prefer?: string[], limit?: number) =>
  asUser(t, userId).query(api.functions.owners.searchOwners, {
    workspaceId,
    query,
    ...(prefer === undefined ? {} : { prefer }),
    ...(limit === undefined ? {} : { limit }),
  });

describe("who is offered", () => {
  test("members only, matched on name or address, best match first", async () => {
    const { t, editor, workspaceId } = await team();
    const found = await search(t, editor, workspaceId, "sa");
    // Mallory Sayers matches "sa" too, and is in another workspace.
    expect(found.people.map((p) => p.value)).toEqual(["Sayo"]);
    expect((await search(t, editor, workspaceId, "john@")).people.map((p) => p.value)).toEqual(["John Adé"]);
    expect((await search(t, editor, workspaceId, "ade")).people.map((p) => p.value)).toEqual(["John Adé"]);
    expect((await search(t, editor, workspaceId, "zzz")).people).toEqual([]);
  });

  test("with nothing typed: the folder's own owners, then you, then a to z", async () => {
    const { t, editor, workspaceId } = await team();
    const plain = await search(t, editor, workspaceId, "");
    expect(plain.people.map((p) => p.value)).toEqual(["Sayo", "John Adé", "Seyi Olujide"]);
    expect(plain.people[0].isMe).toBe(true);
    // A folder that says "Seyi" by hand offers the member of that first name first.
    const preferred = await search(t, editor, workspaceId, "", ["Seyi"]);
    expect(preferred.people.map((p) => p.value)).toEqual(["Seyi Olujide", "Sayo", "John Adé"]);
  });

  test("a non-member gets the refusal a missing workspace gets", async () => {
    const { t, outsider, workspaceId } = await team();
    const error = await captureError(() => search(t, outsider, workspaceId, ""));
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("a large workspace sends back the few best, never the roster", async () => {
    const { t, owner, workspaceId } = await team();
    for (let i = 0; i < 120; i += 1) {
      const id = await person(t, `p${i}@example.invalid`, `Person ${String(i).padStart(3, "0")}`);
      await addMember(t, workspaceId, id, "member", owner);
    }
    const found = await search(t, owner, workspaceId, "person 11");
    expect(found.people.map((p) => p.value)).toEqual(["Person 110", "Person 111", "Person 112", "Person 113", "Person 114", "Person 115", "Person 116", "Person 117"]);
    expect((await search(t, owner, workspaceId, "", [], 500)).people).toHaveLength(20);
    expect(found.truncated).toBe(false);
    expect(MAX_OWNER_SCAN).toBeGreaterThanOrEqual(1000);
  });
});

describe("handles, never addresses", () => {
  /** Seyi claims a handle; Sayo has one as the slug of a personal workspace; John has none. */
  async function handled() {
    const found = await team();
    const { t, owner, editor } = found;
    await t.run((ctx) =>
      ctx.db.insert("names", { name: "seyi", kind: "user", userId: owner, claimedBy: owner, claimedAt: Date.now() }),
    );
    await createWorkspace(t, editor, "sayo");
    return found;
  }

  test("a member with a handle is offered as @handle with their name beside it, and no address leaves", async () => {
    const { t, editor, workspaceId } = await handled();
    const found = await search(t, editor, workspaceId, "");
    expect(found.people).toEqual([
      { value: "@sayo", isMe: true },
      { value: "@seyi", name: "Seyi Olujide", isMe: false },
      { value: "John Adé", isMe: false },
    ]);
    expect(JSON.stringify(found)).not.toContain("example.invalid");
  });

  test("a handle, a name or an address finds them; the address is still never sent", async () => {
    const { t, editor, workspaceId } = await handled();
    for (const typed of ["@se", "sey", "Seyi Olu", "seyi@exa"]) {
      const found = await search(t, editor, workspaceId, typed);
      expect(found.people.map((p) => p.value)).toEqual(["@seyi"]);
      expect(JSON.stringify(found)).not.toContain("example.invalid");
    }
  });

  test("an owner line written before handles resolves to the member it names", async () => {
    const { t, john, workspaceId } = await handled();
    const resolved = await asUser(t, john).query(api.functions.owners.resolveOwners, {
      workspaceId,
      words: ["seyi@example.invalid", "Sayo", "@seyi", "John Adé", "Mallory Sayers", "mallory@example.invalid", "nobody"],
    });
    // Already a handle, no handle to give, or not a member: left as written.
    expect(resolved).toEqual([
      { word: "seyi@example.invalid", value: "@seyi" },
      { word: "Sayo", value: "@sayo" },
    ]);
  });

  test("resolving is a member's question, refused to anybody else as a missing workspace", async () => {
    const { t, outsider, workspaceId } = await handled();
    const error = await captureError(() =>
      asUser(t, outsider).query(api.functions.owners.resolveOwners, { workspaceId, words: ["seyi@example.invalid"] }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("a name two members share names nobody", () => {
    const twins = [
      { value: "@a", name: "Sam", handle: "a", isMe: false },
      { value: "@b", name: "Sam", handle: "b", isMe: false },
    ];
    expect(resolveOwnerWords(twins, ["Sam", "@A"])).toEqual([{ word: "@A", value: "@a" }]);
  });
});

describe("which agents are offered", () => {
  test("an owner sees every connected agent; an editor only their own", async () => {
    const { t, owner, editor, workspaceId } = await team();
    await client(t, "c-claude", "Claude");
    await client(t, "c-codex", "Codex");
    await client(t, "context_console", "Context (this app)");
    await seedGrant(t, workspaceId, owner, "c-claude", "a".repeat(64));
    await seedGrant(t, workspaceId, editor, "c-codex", "b".repeat(64));
    await seedGrant(t, workspaceId, owner, "context_console", "c".repeat(64));

    expect((await search(t, owner, workspaceId, "")).agents.sort()).toEqual(["Claude", "Codex"]);
    expect((await search(t, editor, workspaceId, "")).agents).toEqual(["Codex"]);
    expect((await search(t, owner, workspaceId, "cla")).agents).toEqual(["Claude"]);
  });

  test("an integration that only files notes is not an agent anybody can own work", async () => {
    const { t, owner, editor, workspaceId } = await team();
    await client(t, "c-claude", "Claude");
    await client(t, "c-sentry", "Context Sentry incident inbox");
    await client(t, "c-hook", "Deploy notes", "context-integration:deploys");
    await seedGrant(t, workspaceId, owner, "c-claude", "a".repeat(64));
    // Held by another member, as the Sentry Worker's journey-test account holds its grant.
    await seedGrant(t, workspaceId, editor, "c-sentry", "b".repeat(64));
    await seedGrant(t, workspaceId, owner, "c-hook", "c".repeat(64));
    expect((await search(t, owner, workspaceId, "")).agents).toEqual(["Claude"]);
    expect((await search(t, owner, workspaceId, "sentry")).agents).toEqual([]);
  });

  test("a name is offered as one line, whatever its holder registered", async () => {
    const { t, owner, workspaceId } = await team();
    await client(t, "c-odd", "Evil\nstatus: done\u0000 Agent");
    await seedGrant(t, workspaceId, owner, "c-odd", "d".repeat(64));
    expect((await search(t, owner, workspaceId, "")).agents).toEqual(["Evil status: done Agent"]);
  });

  test("a revoked grant is not a connected agent", async () => {
    const { t, owner, workspaceId } = await team();
    await client(t, "c-claude", "Claude");
    const grant = await seedGrant(t, workspaceId, owner, "c-claude", "a".repeat(64));
    await t.run((ctx) => ctx.db.patch(grant, { status: "revoked", revokedAt: Date.now() }));
    expect((await search(t, owner, workspaceId, "")).agents).toEqual([]);
  });
});

describe("ranking", () => {
  const me = { value: "Sàyọ̀ Ade", name: "Sàyọ̀ Ade", email: "s@example.invalid", isMe: true };
  test("case and accents are ignored", () => {
    expect(matchTier(me, "sayo")).toBe(5);
    expect(matchTier(me, "ade")).toBe(4);
    expect(matchTier(me, "s@ex")).toBe(3);
  });
  test("a first name in the folder points at the member", () => {
    expect(preferWeight(me, ["Bola", "sayo"])).toBe(1);
    expect(preferWeight(me, ["Sàyọ̀ Ade"])).toBe(1);
    expect(preferWeight(me, ["Ade"])).toBe(0);
  });
  test("limit is honoured", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ value: `P${i}`, name: `P${i}`, isMe: false }));
    expect(rankMembers(many, "", [], 5)).toHaveLength(5);
  });
});
