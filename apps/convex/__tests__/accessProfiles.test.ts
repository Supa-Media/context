import { describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { gatewayAccessProfilesHandler } from "../functions/lib/gatewayRoutes/accessProfiles";
import { MAX_PROFILES } from "../functions/accessProfiles";
import { createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

/**
 * Display profiles for a workspace object's members (`functions/accessProfiles.ts`,
 * `functions/lib/gatewayRoutes/accessProfiles.ts`; `docs/decisions/identity-and-access/access-in-objects.md`).
 *
 * The query trusts its caller (the gateway's door has already been checked by
 * `gatewayRoute`), so what these tests hold is the shape of what comes back:
 * the handle only for a personal workspace, nothing for a missing or malformed
 * id, duplicates once, and the 200-person ceiling.
 */

vi.setConfig({ testTimeout: 20_000 });

type T = ReturnType<typeof setupTest>;

async function person(t: T, slug: string, name?: string) {
  const userId = await createUser(t, `${slug}@example.invalid`);
  if (name !== undefined) await t.run((ctx) => ctx.db.patch(userId, { name }));
  return userId;
}

/** A fake action context that records every `runQuery` call and answers `[]`. */
function recordingCtx() {
  const calls: { query: unknown; args: unknown }[] = [];
  const ctx = {
    runQuery: async (query: unknown, args: unknown) => {
      calls.push({ query, args });
      return [];
    },
  } as unknown as ActionCtx;
  return { ctx, calls };
}

describe("profilesFor", () => {
  test("returns name, email and the personal workspace's slug as handle", async () => {
    const t = setupTest();
    const userId = await person(t, "ada", "Ada Lovelace");
    const workspaceId = await createWorkspace(t, userId, "ada", { kind: "personal" });
    const profiles = await t.query(internal.functions.accessProfiles.profilesFor, {
      people: [{ userId, personalWorkspaceId: workspaceId }],
    });
    expect(profiles).toEqual([
      { userId, name: "Ada Lovelace", email: "ada@example.invalid", handle: "ada" },
    ]);
  });

  test("no handle when personalWorkspaceId names a shared workspace", async () => {
    const t = setupTest();
    const userId = await person(t, "ada", "Ada Lovelace");
    const sharedId = await createWorkspace(t, userId, "garden-club", { kind: "shared" });
    const profiles = await t.query(internal.functions.accessProfiles.profilesFor, {
      people: [{ userId, personalWorkspaceId: sharedId }],
    });
    expect(profiles).toEqual([{ userId, name: "Ada Lovelace", email: "ada@example.invalid" }]);
    expect(profiles[0]).not.toHaveProperty("handle");
  });

  test("no handle when personalWorkspaceId is absent", async () => {
    const t = setupTest();
    const userId = await person(t, "ada", "Ada Lovelace");
    await createWorkspace(t, userId, "ada", { kind: "personal" });
    const profiles = await t.query(internal.functions.accessProfiles.profilesFor, {
      people: [{ userId }],
    });
    expect(profiles).toEqual([{ userId, name: "Ada Lovelace", email: "ada@example.invalid" }]);
    expect(profiles[0]).not.toHaveProperty("handle");
  });

  test("no handle when personalWorkspaceId is not a valid id string", async () => {
    const t = setupTest();
    const userId = await person(t, "ada", "Ada Lovelace");
    await createWorkspace(t, userId, "ada", { kind: "personal" });
    const profiles = await t.query(internal.functions.accessProfiles.profilesFor, {
      people: [{ userId, personalWorkspaceId: "not a valid id!" }],
    });
    expect(profiles).toEqual([{ userId, name: "Ada Lovelace", email: "ada@example.invalid" }]);
    expect(profiles[0]).not.toHaveProperty("handle");
  });

  test("no handle when personalWorkspaceId is a users id, not a workspace id", async () => {
    const t = setupTest();
    const userId = await person(t, "ada", "Ada Lovelace");
    const other = await person(t, "bo");
    const profiles = await t.query(internal.functions.accessProfiles.profilesFor, {
      people: [{ userId, personalWorkspaceId: other }],
    });
    expect(profiles).toEqual([{ userId, name: "Ada Lovelace", email: "ada@example.invalid" }]);
    expect(profiles[0]).not.toHaveProperty("handle");
  });

  test("unknown or invalid userIds are skipped, and a deleted user is skipped", async () => {
    const t = setupTest();
    const ada = await person(t, "ada", "Ada Lovelace");
    const gone = await person(t, "gone", "Gone");
    await t.run((ctx) => ctx.db.delete(gone));
    const profiles = await t.query(internal.functions.accessProfiles.profilesFor, {
      people: [{ userId: "not-a-real-id!" }, { userId: gone }, { userId: ada }],
    });
    expect(profiles.map((p) => p.userId)).toEqual([ada]);
  });

  test("a duplicated userId is returned once", async () => {
    const t = setupTest();
    const ada = await person(t, "ada", "Ada Lovelace");
    const profiles = await t.query(internal.functions.accessProfiles.profilesFor, {
      people: [{ userId: ada }, { userId: ada }, { userId: ada }],
    });
    expect(profiles).toHaveLength(1);
    expect(profiles[0].userId).toBe(ada);
  });

  test("more than 200 people: at most 200 are looked up, the rest are never answered", async () => {
    const t = setupTest();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PROFILES + 1; i++) {
      ids.push(await person(t, `p${i}`, `Person ${i}`));
    }
    const profiles = await t.query(internal.functions.accessProfiles.profilesFor, {
      people: ids.map((userId) => ({ userId })),
    });
    expect(MAX_PROFILES).toBe(200);
    expect(profiles).toHaveLength(MAX_PROFILES);
    expect(profiles.map((p) => p.userId)).toEqual(ids.slice(0, MAX_PROFILES));
    expect(profiles.map((p) => p.userId)).not.toContain(ids[MAX_PROFILES]);
  });
});

describe("gatewayAccessProfilesHandler", () => {
  test("a body without a people array answers no profiles and looks nothing up", async () => {
    for (const body of [{}, { people: "ada" }, { people: { userId: "x" } }, { people: null }]) {
      const { ctx, calls } = recordingCtx();
      const response = await gatewayAccessProfilesHandler(ctx, body);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ profiles: [] });
      expect(calls).toHaveLength(0);
    }
  });

  test("entries whose userId has a slash or is longer than 64 characters are dropped", async () => {
    const { ctx, calls } = recordingCtx();
    const response = await gatewayAccessProfilesHandler(ctx, {
      people: [
        { userId: "ada/../bo" },
        { userId: "x".repeat(65) },
        { userId: "y".repeat(64) },
        { userId: "ok_1-2" },
        { userId: "bad/ws-entry", personalWorkspaceId: "ws" },
        { userId: "keep-me", personalWorkspaceId: "has/slash" },
        null,
        "string-entry",
        { personalWorkspaceId: "no-user" },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ profiles: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({
      people: [{ userId: "y".repeat(64) }, { userId: "ok_1-2" }, { userId: "keep-me" }],
    });
  });

  test("at most 200 entries reach the query", async () => {
    const { ctx, calls } = recordingCtx();
    const people = Array.from({ length: MAX_PROFILES + 50 }, (_, i) => ({ userId: `user${i}` }));
    await gatewayAccessProfilesHandler(ctx, { people });
    const sent = (calls[0].args as { people: unknown[] }).people;
    expect(sent).toHaveLength(MAX_PROFILES);
  });

  test("an empty people list never reaches the query", async () => {
    const { ctx, calls } = recordingCtx();
    const response = await gatewayAccessProfilesHandler(ctx, { people: [] });
    expect(await response.json()).toEqual({ profiles: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("POST /gateway/access/profiles", () => {
  test("with the gateway secret, answers the profiles over the real route", async () => {
    const t = setupTest();
    const userId = await person(t, "ada", "Ada Lovelace");
    const workspaceId = await createWorkspace(t, userId, "ada", { kind: "personal" });
    const response = await gatewayPost(t, "/gateway/access/profiles", {
      people: [{ userId, personalWorkspaceId: workspaceId }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      profiles: [{ userId, name: "Ada Lovelace", email: "ada@example.invalid", handle: "ada" }],
    });
  });

  test("without the gateway secret, or with the wrong one, it is refused with 401", async () => {
    const t = setupTest();
    const userId = await person(t, "ada", "Ada Lovelace");
    const body = { people: [{ userId }] };
    const none = await gatewayPost(t, "/gateway/access/profiles", body, { secret: null });
    const wrong = await gatewayPost(t, "/gateway/access/profiles", body, { secret: "not-the-secret" });
    expect(none.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await none.text()).toBe(await wrong.text());
  });
});
