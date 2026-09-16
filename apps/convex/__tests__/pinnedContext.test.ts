/**
 * THE PINNED CONTEXT — `@context-lc`, reachable by every account without an
 * invitation, read-only, with the form tools still open to it.
 *
 * Four claims are under test, and they are not the same claim four times.
 *
 * **It is reachable.** From an MCP session (`resolveGrantByAccessToken`), from
 * the console (`listMyWorkspaces`), and far enough into the storage path that a
 * note can actually be read (`authorizeFileAccess`). A pin that resolves a
 * session and then cannot open a store is a context that is visible and empty,
 * which is worse than one that is absent.
 *
 * **It is only reachable.** Reach is not membership, and the tests that matter
 * most here are the refusals: the member list, the audit trail, billing, the
 * storage binding and every write must answer a pinned reader exactly as they
 * answer a stranger. `listMembers` is the one to look at twice — it returns
 * every member's name and email to any member, so if the pin had been built as
 * a `workspaceMembers` row per account, that query would hand every account a
 * directory of everybody on the platform. `docs/decisions/identity-and-access.md`
 * records that as the reason the pin is computed rather than stored.
 *
 * **It cannot demote anybody.** The people who run that workspace are `owner`
 * and `editor` in it through ordinary invitations. A real row always wins, and
 * appears exactly once.
 *
 * **It is absent when it does not exist.** Every test above seeds the workspace
 * first. A self-hosted deployment has no such row, and must get no pinned
 * context rather than an error — so the last block seeds nothing and asserts
 * the world is unchanged.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

type TestConvex = ReturnType<typeof setupTest>;

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The pinned workspace, created the way it really is: by staff, as an ordinary
 * shared context.
 *
 * **Two of those words are load-bearing, and the slug is not one of them.** The
 * name is claimable by anybody, so it selects the row and cannot be what marks
 * it — see the block at the end of this file, and `lib/pinnedContext.ts`. What
 * marks it is that the workspace is `shared` and that somebody this deployment
 * already trusts stands behind it, which here means the creator's address is in
 * `ADMIN_EMAILS`. Stub it before the row is written, the way a real deployment
 * has it set before anybody signs in.
 */
async function seedPinnedContext(
  t: TestConvex,
): Promise<{ staff: Id<"users">; pinnedId: Id<"workspaces"> }> {
  vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
  const staff = await createUser(t, "staff@example.invalid");
  await createWorkspace(t, staff, "staff-personal");
  const pinnedId = await createWorkspace(t, staff, PINNED_CONTEXT_SLUG, {
    kind: "shared",
    displayName: "Context",
  });
  return { staff, pinnedId };
}

/**
 * An ordinary customer: an account, their own personal context, and a live MCP
 * grant against it, exactly as the gateway would have written one.
 */
async function customerWithGrant(
  t: TestConvex,
  { email, slug, token }: { email: string; slug: string; token: string },
): Promise<{ userId: Id<"users">; workspaceId: Id<"workspaces"> }> {
  const userId = await createUser(t, email);
  const workspaceId = await createWorkspace(t, userId, slug);
  await t.run(async (ctx) => {
    await ctx.db.insert("oauthGrants", {
      workspaceId,
      userId,
      clientId: "claude",
      scopes: ["context.read", "context.write"],
      hashedRefreshToken: token.repeat(64).slice(0, 64),
      hashedAccessToken: token.repeat(64).slice(0, 64),
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
      status: "active" as const,
      createdAt: Date.now(),
    });
    await ctx.db.insert("oauthClients", {
      clientId: "claude",
      clientName: "Claude",
      redirectUris: ["https://client.invalid/callback"],
      hashedClientSecret: null,
      createdAt: Date.now(),
    });
  });
  return { userId, workspaceId };
}

const hashed = (seed: string) => seed.repeat(64).slice(0, 64);

/* -------------------------------------------------------------------------- */
/*                          reach: the MCP session                            */
/* -------------------------------------------------------------------------- */

describe("an MCP session covers the pinned context", () => {
  test("a customer who was never invited reaches it, read-only", async () => {
    const t = setupTest();
    const { pinnedId } = await seedPinnedContext(t);
    await customerWithGrant(t, {
      email: "sayo@example.invalid",
      slug: "sayo",
      token: "a",
    });

    const session = await t.query(
      internal.functions.controlPlane.resolveGrantByAccessToken,
      { hashedAccessToken: hashed("a") },
    );

    const covered = session!.workspaces.find((w) => w.slug === PINNED_CONTEXT_SLUG);
    expect(covered).toMatchObject({
      workspaceId: pinnedId,
      slug: PINNED_CONTEXT_SLUG,
      // The whole authority story downstream hangs off this one word:
      // `effectiveScopes` drops `context:write` for it and
      // `visibilityTierForGrant` answers `team`.
      role: "member",
      kind: "shared",
    });
  });

  test("the grant's own context is still first, and the pin is last", async () => {
    const t = setupTest();
    await seedPinnedContext(t);
    const { workspaceId } = await customerWithGrant(t, {
      email: "sayo@example.invalid",
      slug: "sayo",
      token: "a",
    });

    const session = await t.query(
      internal.functions.controlPlane.resolveGrantByAccessToken,
      { hashedAccessToken: hashed("a") },
    );

    // The gateway reads `[0]`'s own row as the session default and refuses a
    // default that is not in the covered set, so a pin that displaced it would
    // route every unaddressed tool call into somebody else's workspace.
    expect(session!.workspaces[0]!.workspaceId).toBe(workspaceId);
    expect(session!.workspaces.at(-1)!.slug).toBe(PINNED_CONTEXT_SLUG);
  });

  test("reaching it writes no membership row for anybody", async () => {
    const t = setupTest();
    const { pinnedId } = await seedPinnedContext(t);
    await customerWithGrant(t, {
      email: "sayo@example.invalid",
      slug: "sayo",
      token: "a",
    });

    await t.query(internal.functions.controlPlane.resolveGrantByAccessToken, {
      hashedAccessToken: hashed("a"),
    });

    // One row: the staff owner `createWorkspace` wrote. If this ever grows with
    // the number of accounts, `listMembers` has become a user directory.
    const members = await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", pinnedId))
        .collect(),
    );
    expect(members).toHaveLength(1);
    expect(members[0]!.role).toBe("owner");
  });

  test("a real member keeps their real role, and appears exactly once", async () => {
    const t = setupTest();
    const { pinnedId } = await seedPinnedContext(t);
    const { userId } = await customerWithGrant(t, {
      email: "editor@example.invalid",
      slug: "an-editor",
      token: "a",
    });
    await addMember(t, pinnedId, userId, "editor");

    const session = await t.query(
      internal.functions.controlPlane.resolveGrantByAccessToken,
      { hashedAccessToken: hashed("a") },
    );

    const rows = session!.workspaces.filter((w) => w.slug === PINNED_CONTEXT_SLUG);
    // Two rows would make `sessionForContext`'s `.find()` answer with whichever
    // came first — the pinned `member` row — and silently demote them.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("editor");
  });

  test("it does not make somebody else's shared context reachable", async () => {
    const t = setupTest();
    await seedPinnedContext(t);
    const stranger = await createUser(t, "stranger@example.invalid");
    await createWorkspace(t, stranger, "stranger-personal");
    await createWorkspace(t, stranger, "stranger-team", { kind: "shared" });

    await customerWithGrant(t, {
      email: "sayo@example.invalid",
      slug: "sayo",
      token: "a",
    });

    const session = await t.query(
      internal.functions.controlPlane.resolveGrantByAccessToken,
      { hashedAccessToken: hashed("a") },
    );
    expect(session!.workspaces.map((w) => w.slug).sort()).toEqual(
      [PINNED_CONTEXT_SLUG, "sayo"].sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                          reach: the console list                           */
/* -------------------------------------------------------------------------- */

describe("the console lists the pinned context", () => {
  test("it is last, flagged, and read-only", async () => {
    const t = setupTest();
    const { pinnedId } = await seedPinnedContext(t);
    const sayo = await createUser(t, "sayo@example.invalid");
    await createWorkspace(t, sayo, "sayo");

    const listed = await asUser(t, sayo).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );

    expect(listed.map((w) => w.slug)).toEqual(["sayo", PINNED_CONTEXT_SLUG]);
    expect(listed.at(-1)).toMatchObject({
      workspaceId: pinnedId,
      role: "member",
      pinned: true,
    });
    // The flag is what onboarding subtracts. An ordinary row must not carry it,
    // or the `(app)` gate would stop counting real contexts.
    expect(listed[0]!.pinned).toBeUndefined();
  });

  test("the pinned workspace is not sorted in by age", async () => {
    const t = setupTest();
    // Created first, so it is the oldest row in the table — which is what a
    // `createdAt` sort would put at the head of everybody's list, above their
    // own workspace.
    await seedPinnedContext(t);
    const sayo = await createUser(t, "sayo@example.invalid");
    await createWorkspace(t, sayo, "sayo");

    const listed = await asUser(t, sayo).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    expect(listed[0]!.slug).toBe("sayo");
  });

  test("a real member sees their own role and no flag", async () => {
    const t = setupTest();
    const { pinnedId } = await seedPinnedContext(t);
    const sayo = await createUser(t, "sayo@example.invalid");
    await createWorkspace(t, sayo, "sayo");
    await addMember(t, pinnedId, sayo, "editor");

    const listed = await asUser(t, sayo).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    const rows = listed.filter((w) => w.slug === PINNED_CONTEXT_SLUG);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("editor");
    expect(rows[0]!.pinned).toBeUndefined();
  });

  test("an account with nothing of its own still reaches only the pin", async () => {
    const t = setupTest();
    await seedPinnedContext(t);
    const fresh = await createUser(t, "fresh@example.invalid");

    const listed = await asUser(t, fresh).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    // One row, flagged — which is precisely the case `standingFrom` has to
    // subtract, or this person never sees `/welcome` and never claims a name.
    expect(listed).toHaveLength(1);
    expect(listed[0]!.pinned).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                      what the pin does and does not open                   */
/* -------------------------------------------------------------------------- */

describe("a pinned reader may read and may not write", () => {
  async function pinnedReader() {
    const t = setupTest();
    const { pinnedId } = await seedPinnedContext(t);
    const sayo = await createUser(t, "sayo@example.invalid");
    await createWorkspace(t, sayo, "sayo");
    return { t, pinnedId, sayo };
  }

  test("reads are authorized, at team scope", async () => {
    const { t, pinnedId, sayo } = await pinnedReader();
    expect(
      await t.query(internal.functions.files.authorizeFileAccess, {
        actorUserId: sayo,
        workspaceId: pinnedId,
        minimum: "member",
      }),
    ).toEqual({ role: "member", scope: "team" });
  });

  test("`team` scope, so a private note of ours stays private", async () => {
    const { t, pinnedId, sayo } = await pinnedReader();
    const { scope } = await t.query(internal.functions.files.authorizeFileAccess, {
      actorUserId: sayo,
      workspaceId: pinnedId,
      minimum: "member",
    });
    // `private` here would hand every account on the platform every note in
    // that workspace, whatever `privacy.md` says.
    expect(scope).not.toBe("private");
  });

  test.each(["editor", "owner"] as const)(
    "a %s-minimum operation is refused exactly as it refuses a stranger",
    async (minimum) => {
      const { t, pinnedId, sayo } = await pinnedReader();
      const error = await captureError(() =>
        t.query(internal.functions.files.authorizeFileAccess, {
          actorUserId: sayo,
          workspaceId: pinnedId,
          minimum,
        }),
      );
      expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
    },
  );

  /**
   * The case a sabotage sweep caught this suite not covering, and it is the one
   * that would have hurt: `reachesPinnedContext` returning `true` regardless of
   * membership passed every other test here, because every other test asks
   * about somebody who has no row.
   *
   * An owner reading their *own* workspace must come back `private`. Answering
   * the pinned `member`/`team` for them would hide every private note in that
   * workspace from the people who wrote it — a downgrade that looks like
   * missing files rather than like a permission bug.
   */
  test("an owner of the pinned context still reads it at private scope", async () => {
    const t = setupTest();
    const { staff, pinnedId } = await seedPinnedContext(t);

    expect(
      await t.query(internal.functions.files.authorizeFileAccess, {
        actorUserId: staff,
        workspaceId: pinnedId,
        minimum: "member",
      }),
    ).toEqual({ role: "owner", scope: "private" });
  });

  test("an editor of the pinned context keeps editor, and may write", async () => {
    const t = setupTest();
    const { pinnedId } = await seedPinnedContext(t);
    const editor = await createUser(t, "ed@example.invalid");
    await createWorkspace(t, editor, "ed");
    await addMember(t, pinnedId, editor, "editor");

    // The write path, which never consults the pin at all — so this is the
    // proof that a real row is what carries them through it.
    expect(
      await t.query(internal.functions.files.authorizeFileAccess, {
        actorUserId: editor,
        workspaceId: pinnedId,
        minimum: "editor",
      }),
    ).toEqual({ role: "editor", scope: "team" });
  });

  test("the pin does not authorize reads anywhere else", async () => {
    const { t, sayo } = await pinnedReader();
    const stranger = await createUser(t, "stranger@example.invalid");
    const theirs = await createWorkspace(t, stranger, "stranger");

    const error = await captureError(() =>
      t.query(internal.functions.files.authorizeFileAccess, {
        actorUserId: sayo,
        workspaceId: theirs,
        minimum: "member",
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("reach is not membership", () => {
  async function pinnedReader() {
    const t = setupTest();
    const { pinnedId } = await seedPinnedContext(t);
    const sayo = await createUser(t, "sayo@example.invalid");
    await createWorkspace(t, sayo, "sayo");
    return { t, pinnedId, sayo };
  }

  /**
   * The enumeration guard, and the reason the pin is computed rather than
   * stored. This query returns every member's name and email to any member.
   */
  test("the member list refuses a pinned reader", async () => {
    const { t, pinnedId, sayo } = await pinnedReader();
    const error = await captureError(() =>
      asUser(t, sayo).query(api.functions.workspaces.listMembers, {
        workspaceId: pinnedId,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("the storage binding refuses a pinned reader", async () => {
    const { t, pinnedId, sayo } = await pinnedReader();
    const error = await captureError(() =>
      asUser(t, sayo).query(api.functions.storage.getStorageBinding, {
        workspaceId: pinnedId,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("the audit trail refuses a pinned reader", async () => {
    const { t, pinnedId, sayo } = await pinnedReader();
    const error = await captureError(() =>
      asUser(t, sayo).query(api.functions.audit.listEvents, {
        workspaceId: pinnedId,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("connected AI clients refuse a pinned reader", async () => {
    const { t, pinnedId, sayo } = await pinnedReader();
    const error = await captureError(() =>
      asUser(t, sayo).query(api.functions.grants.listGrants, {
        workspaceId: pinnedId,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  /**
   * There is no opt-out, and this is why it needs no code to enforce one.
   *
   * `leaveWorkspace` deletes a membership row, and a pinned reader has none —
   * so it answers `{ left: false }` (its existing idempotent path for somebody
   * who is not a member) and the pin is untouched on the next read. Worth
   * pinning as a test rather than reasoning about: if the pin were ever
   * reworked into real rows, this would start succeeding and quietly give
   * people a way out that the product does not offer.
   */
  test("leaving is a no-op that cannot remove the pin", async () => {
    const { t, pinnedId, sayo } = await pinnedReader();

    expect(
      await asUser(t, sayo).mutation(api.functions.workspaces.leaveWorkspace, {
        workspaceId: pinnedId,
      }),
    ).toEqual({ left: false });

    const listed = await asUser(t, sayo).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    expect(listed.some((w) => w.slug === PINNED_CONTEXT_SLUG)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                       a deployment with no pinned context                  */
/* -------------------------------------------------------------------------- */

describe("a deployment that has no such workspace", () => {
  test("the console list is unchanged", async () => {
    const t = setupTest();
    const sayo = await createUser(t, "sayo@example.invalid");
    await createWorkspace(t, sayo, "sayo");

    const listed = await asUser(t, sayo).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]!.pinned).toBeUndefined();
  });

  test("an account with nothing has nothing, and still reaches onboarding", async () => {
    const t = setupTest();
    const fresh = await createUser(t, "fresh@example.invalid");
    expect(
      await asUser(t, fresh).query(api.functions.workspaces.listMyWorkspaces, {}),
    ).toEqual([]);
  });

  test("an MCP session covers only the grant's own context", async () => {
    const t = setupTest();
    const { workspaceId } = await customerWithGrant(t, {
      email: "sayo@example.invalid",
      slug: "sayo",
      token: "a",
    });

    const session = await t.query(
      internal.functions.controlPlane.resolveGrantByAccessToken,
      { hashedAccessToken: hashed("a") },
    );
    expect(session!.workspaces).toHaveLength(1);
    expect(session!.workspaces[0]!.workspaceId).toBe(workspaceId);
  });
});

/* -------------------------------------------------------------------------- */
/*              a workspace nobody at this deployment vouches for             */
/* -------------------------------------------------------------------------- */

describe("the slug selects the pinned context; it does not make one", () => {
  /*
    THE NAME IS AN ADDRESS, NOT A CREDENTIAL.

    `context-lc` is deliberately claimable — `lib/names.ts` reserves its
    lookalikes and says of the name itself that *"what protects a name we hold
    is holding it"*, because a reserved name is refused for everyone including
    us, and we would never be able to recreate this workspace after a delete.
    That reasoning is sound for a **handle**, and this feature is what turns the
    same string into a **trust anchor**: whatever row holds it is read by every
    account on the deployment and writes into every MCP session.

    Everywhere the row is not held — a self-hosted control plane, a fresh
    staging database, or this one after a delete frees the name — the first
    account to create a workspace called `context-lc` would be pinned into
    everybody's rail and every session. That is an author's notes reaching every
    user's agent under a handle that reads as ours, and, because
    `participatesInForms` needs only a write-scoped grant and a **non-empty**
    role, a form of theirs taking submissions from any user's client.

    So the pin asks for something an account cannot give itself: the workspace
    is `shared`, and somebody this deployment already trusts stands behind it —
    `ADMIN_EMAILS`, which lives in the Convex environment precisely because
    nothing this codebase executes can write it (`lib/admin.ts`). On a
    deployment with no staff configured there is no pinned context, which is the
    same answer a self-hoster already got and the one they should keep.
  */
  test("a stranger who claims the name is pinned for nobody", async () => {
    const t = setupTest();
    // No ADMIN_EMAILS: nobody at this deployment is staff, so nobody can
    // vouch for this row — exactly a self-hosted control plane.
    const squatter = await createUser(t, "squatter@example.invalid");
    await createWorkspace(t, squatter, PINNED_CONTEXT_SLUG, {
      kind: "shared",
      displayName: "Context",
    });
    const sayo = await createUser(t, "sayo@example.invalid");
    await createWorkspace(t, sayo, "sayo");

    const listed = await asUser(t, sayo).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    expect(listed.map((w) => w.slug)).toEqual(["sayo"]);
  });

  test("...and cannot be read through the file path either", async () => {
    const t = setupTest();
    const squatter = await createUser(t, "squatter@example.invalid");
    const pinnedId = await createWorkspace(t, squatter, PINNED_CONTEXT_SLUG, {
      kind: "shared",
      displayName: "Context",
    });
    const sayo = await createUser(t, "sayo@example.invalid");
    await createWorkspace(t, sayo, "sayo");

    const error = await captureError(() =>
      t.query(internal.functions.files.authorizeFileAccess, {
        workspaceId: pinnedId,
        actorUserId: sayo,
        minimum: "member" as const,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("...and does not reach an MCP session", async () => {
    const t = setupTest();
    const squatter = await createUser(t, "squatter@example.invalid");
    await createWorkspace(t, squatter, PINNED_CONTEXT_SLUG, {
      kind: "shared",
      displayName: "Context",
    });
    await customerWithGrant(t, {
      email: "sayo@example.invalid",
      slug: "sayo",
      token: "a",
    });

    const session = await t.query(
      internal.functions.controlPlane.resolveGrantByAccessToken,
      { hashedAccessToken: hashed("a") },
    );
    expect(session!.workspaces).toHaveLength(1);
    expect(session!.workspaces[0]!.slug).toBe("sayo");
  });

  test("an unverified staff address vouches for nothing", async () => {
    /*
      `requireAdmin` carries this line with the reason spelled out — an
      unverified address proves nothing about who holds the mailbox, so without
      it, signing up AS an allowlisted address is enough to become staff. The
      copy in `userIsStaff` needs the same guard and, measured, nothing else in
      this suite reddens when it is removed.
    */
    const t = setupTest();
    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
    const unverified = await t.run((ctx) =>
      ctx.db.insert("users", { email: "staff@example.invalid", createdAt: Date.now() }),
    );
    await createWorkspace(t, unverified, PINNED_CONTEXT_SLUG, {
      kind: "shared",
      displayName: "Context",
    });
    const sayo = await createUser(t, "sayo@example.invalid");
    await createWorkspace(t, sayo, "sayo");

    const listed = await asUser(t, sayo).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    expect(listed.map((w) => w.slug)).toEqual(["sayo"]);
  });

  test("a PERSONAL workspace holding the name is not a shared context to pin", async () => {
    // Belt for the same buckle: `pinnedContextRow` reports the row's own
    // `kind`, so without this a personal context — somebody's own, with their
    // own mailbox and their own ingestion alias — could be pinned into every
    // account's list as though it were a shared one.
    const t = setupTest();
    const staff = await createUser(t, "staff@example.invalid");
    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
    await createWorkspace(t, staff, PINNED_CONTEXT_SLUG);
    const sayo = await createUser(t, "sayo@example.invalid");
    await createWorkspace(t, sayo, "sayo");

    const listed = await asUser(t, sayo).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    expect(listed.map((w) => w.slug)).toEqual(["sayo"]);
  });
});
