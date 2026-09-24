import { describe, expect, test } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { hashToken } from "../../functions/lib/crypto";
import {
  gatewayPost,
  responseFingerprint,
  type TestConvex,
} from "../fixtures.helpers";
import {
  token,
  CLIENT_A,
  seedConnectedClient,
  twoConnectedTenants,
  bodyOf,
  startAndApprove,
  startAndApproveWith,
} from "./fixtures";

/* 10. The whole flow, end to end                                             */
/* -------------------------------------------------------------------------- */

/**
 * `/gateway/links/revoke` — THE ONE FREE IDENTIFIER IN THE LINKS ROUTES.
 *
 * The three `/gateway/links/*` routes all spend the two proofs: the secret at
 * the door, then the user's access token, with `expectedWorkspaceId` selecting
 * *within* that token's own set. `gatewayOwnerClearance` returns
 * `covered.workspaceId` — the id off the matched row — so for `create` and
 * `list` the workspace handed downstream is provably the argument's equal
 * whenever the call is allowed at all, and there is nothing a second id could
 * reach.
 *
 * **`revoke` is the exception, because `shareId` is not derived from anything.**
 * It arrives in the body, is normalized, and is used as a lookup key. Clearance
 * on context A therefore reaches a row that may belong to context B, and the
 * only thing between those two facts is one comparison:
 *
 *     if (row.workspaceId !== cleared.workspaceId) return false;
 *
 * Its own comment says what it is for — *"an id from another context must
 * answer exactly as an invented one does"* — and it carries two properties, not
 * one. Integrity: A cannot take down B's live link. And indistinguishability:
 * `revoked` must not tell A that a guessed share id is real somewhere else,
 * which is the existence oracle `SECURITY.md` counts as a bug in its own right.
 *
 * Measured: deleting that line failed **0** of the control-plane suite. The two
 * checks below are what that zero was missing; they are end-to-end through the
 * route rather than against the mutation, because the route is what a holder of
 * the gateway secret can actually reach.
 */
describe("/gateway/links/revoke", () => {
  /** A live `anyone` link, inserted directly so the test owns its id. */
  async function seedLink(
    t: TestConvex,
    workspaceId: Id<"workspaces">,
    createdBy: Id<"users">,
    entryPath: string,
    linkToken: string,
  ): Promise<string> {
    return await t.run(async (ctx) =>
      ctx.db.insert("noteShares", {
        workspaceId,
        entryPath,
        recipientKind: "anyone",
        recipient: "",
        createdBy,
        token: linkToken,
        status: "active",
        titleInPreview: true,
        createdAt: Date.now(),
      }),
    );
  }

  const statusOf = (t: TestConvex, shareId: string) =>
    t.run(async (ctx) => (await ctx.db.get(shareId as Id<"noteShares">))?.status);

  /*
    A grant wide enough to reach these routes at all.

    `gatewayOwnerClearance` wants owner role AND both `context:write` and
    `context:private`; `twoConnectedTenants` seeds read+write, which is right
    for the routes it was written for and one scope short of this one. Seeded
    here rather than widened there, because every other test in this file is
    about a grant that is deliberately not an owner's agent.
  */
  const AGENT_OWNER = token("links_owner_a");
  async function ownerAgent(
    t: TestConvex,
    workspaceId: Id<"workspaces">,
    userId: Id<"users">,
  ): Promise<void> {
    await seedConnectedClient(t, {
      workspaceId,
      userId,
      clientId: CLIENT_A,
      accessToken: AGENT_OWNER,
      refreshToken: `${AGENT_OWNER}-refresh`,
      scopes: ["context:read", "context:write", "context:private"],
    });
  }

  test("owner clearance on one context cannot revoke another context's link", async () => {
    const { t, alice, bob, aliceWs, bobWs } = await twoConnectedTenants();
    await ownerAgent(t, aliceWs, alice);
    const mine = await seedLink(t, aliceWs, alice, "1-projects/mine.md", token("link_a"));
    const theirs = await seedLink(t, bobWs, bob, "1-projects/theirs.md", token("link_b"));

    // Alice is a real owner, names her own context, and presents a live token.
    // Everything about the call is legitimate except the id she reaches for.
    const stolen = await gatewayPost(t, "/gateway/links/revoke", {
      accessToken: AGENT_OWNER,
      expectedWorkspaceId: aliceWs,
      shareId: theirs,
    });
    expect(stolen.status).toBe(200);
    expect(await bodyOf(stolen)).toEqual({ revoked: false });
    // The assertion that matters: Bob's link is still live.
    expect(await statusOf(t, theirs)).toBe("active");

    // Not vacuous — the same call against her own link goes through, so the
    // refusal above is about the boundary and not about a broken fixture.
    const own = await gatewayPost(t, "/gateway/links/revoke", {
      accessToken: AGENT_OWNER,
      expectedWorkspaceId: aliceWs,
      shareId: mine,
    });
    expect(await bodyOf(own)).toEqual({ revoked: true });
    expect(await statusOf(t, mine)).toBe("revoked");
  });

  test("another context's share id answers exactly as an invented one does", async () => {
    const { t, alice, bob, aliceWs, bobWs } = await twoConnectedTenants();
    await ownerAgent(t, aliceWs, alice);
    const theirs = await seedLink(t, bobWs, bob, "1-projects/theirs.md", token("link_c"));
    // A real row, deleted: syntactically a share id, and a share id of nobody's.
    const invented = await t.run(async (ctx) => {
      const id = await ctx.db.insert("noteShares", {
        workspaceId: aliceWs,
        entryPath: "1-projects/gone.md",
        recipientKind: "anyone",
        recipient: "",
        createdBy: alice,
        token: token("link_d"),
        status: "active",
        titleInPreview: true,
        createdAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });

    const ask = (shareId: string) =>
      gatewayPost(t, "/gateway/links/revoke", {
        accessToken: AGENT_OWNER,
        expectedWorkspaceId: aliceWs,
        shareId,
      });

    // Byte-identical, or the route is an existence oracle over share ids —
    // which are global, so "is this real somewhere" is a question about
    // somebody else's context.
    expect(await responseFingerprint(await ask(theirs))).toEqual(
      await responseFingerprint(await ask(invented)),
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("the full authorization flow produces a working, isolated grant", () => {
  test("register → authorize → approve → consume → grant → session → binding", async () => {
    const { t, alice, aliceWs, bobWs } = await twoConnectedTenants();

    const { code } = await startAndApprove(t, { alice, aliceWs });
    const consumed = await bodyOf(
      await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
    );
    const authorization = consumed.authorization as {
      workspaceId: string;
      userId: string;
      scope: string;
    };

    const accessToken = token("end_to_end");
    const refreshToken = `crt_end_to_end_${"0".repeat(18)}`;
    const created = await bodyOf(
      await gatewayPost(t, "/gateway/grants/create", {
        workspaceId: authorization.workspaceId,
        userId: authorization.userId,
        clientId: CLIENT_A,
        scopes: authorization.scope.split(" "),
        hashedRefreshToken: await hashToken(refreshToken),
        hashedAccessToken: await hashToken(accessToken),
        accessTokenExpiresAt: Date.now() + 3_600_000,
      }),
    );
    expect(typeof created.grantId).toBe("string");

    const session = await bodyOf(
      await gatewayPost(t, "/gateway/session", { accessToken }),
    );
    expect((session.session as { defaultWorkspaceId: string }).defaultWorkspaceId).toBe(
      aliceWs,
    );

    const binding = await bodyOf(
      await gatewayPost(t, "/gateway/binding", {
        accessToken,
        expectedWorkspaceId: aliceWs,
      }),
    );
    expect((binding.binding as { bucket: string }).bucket).toBe("tenant-a");

    // …and it reaches only its own workspace.
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/binding", {
          accessToken,
          expectedWorkspaceId: bobWs,
        }),
      ),
    ).toEqual({ binding: null });
  });
});

/* -------------------------------------------------------------------------- */
/* 11. A narrowed approval survives the whole flow                            */
/* -------------------------------------------------------------------------- */

/**
 * The narrowing has to reach the session, not just the screen.
 *
 * A tick box that changes a database row and not the answer the gateway gets is
 * the same bug with a nicer picture, so each of these follows one approval all
 * the way to `/gateway/session` — the payload the gateway builds its enforcement
 * from — and asserts what came out the far end.
 */
describe("what the person approved is what the session carries", () => {
  async function sessionScopesFor(
    t: TestConvex,
    who: { alice: Id<"users">; aliceWs: Id<"workspaces"> },
    grantedScopes: string[],
    overrides: Record<string, unknown> = {},
  ): Promise<string[]> {
    const { code } = await startAndApproveWith(t, who, grantedScopes, overrides);
    const consumed = await bodyOf(
      await gatewayPost(t, "/gateway/codes/consume", { code, clientId: CLIENT_A }),
    );
    const authorization = consumed.authorization as { workspaceId: string; userId: string; scope: string };

    const accessToken = token(`narrowed_${grantedScopes.length}_${Math.random()}`.slice(0, 40));
    await gatewayPost(t, "/gateway/grants/create", {
      workspaceId: authorization.workspaceId,
      userId: authorization.userId,
      clientId: CLIENT_A,
      // Exactly what the code carried. If `consumeAuthorizationCode` handed back
      // the *request* instead of the approval, this is where it would show up.
      scopes: authorization.scope.split(" "),
      hashedRefreshToken: await hashToken(`crt_narrowed_${accessToken}`),
      hashedAccessToken: await hashToken(accessToken),
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });

    const session = await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken }));
    return (session.session as { scopes: string[] }).scopes;
  }

  test("a read-only approval of a read-and-write request arrives read-only", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    expect(await sessionScopesFor(t, { alice, aliceWs }, ["context:read"])).toEqual([
      "context:read",
    ]);
  });

  test("an approval that named no tier arrives with no tier", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    // Alice owns this context. Under the old model that alone made the grant
    // private-tier, and nothing recorded a decision because there was none.
    expect(
      await sessionScopesFor(t, { alice, aliceWs }, ["context:read", "context:write"]),
    ).not.toContain("context:private");
  });

  test("an owner who chose private-tier arrives carrying it", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    expect(
      await sessionScopesFor(t, { alice, aliceWs }, [
        "context:read",
        "context:write",
        "context:private",
      ]),
    ).toEqual(["context:read", "context:write", "context:private"]);
  });
});
