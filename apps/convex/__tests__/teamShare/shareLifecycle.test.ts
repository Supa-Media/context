import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import {
  NOTE,
  scenario,
  teamLink,
} from "./fixtures.helpers";

describe("making one", () => {
  test("an owner gets a token", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * Owner-only, like every other decision about who reads a note. An editor may
   * write notes; publishing a link to one is not the same grant.
   */
  test("an editor cannot", async () => {
    const t = setupTest();
    const { editorId, workspaceId } = await scenario(t);
    expect(errorCode(await captureError(() => teamLink(t, editorId, workspaceId)))).toBe(
      "INSUFFICIENT_ROLE",
    );
  });

  test("a stranger cannot tell the context from one that does not exist", async () => {
    const t = setupTest();
    const { strangerId, workspaceId } = await scenario(t);
    expect(
      errorCode(await captureError(() => teamLink(t, strangerId, workspaceId))),
    ).toBe("WORKSPACE_NOT_FOUND");
  });

  /**
   * One link per note. The owner has probably already pasted it somewhere, so
   * asking again must not quietly invalidate what they sent.
   */
  test("asking twice hands back the same link", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const first = await teamLink(t, ownerId, workspaceId);
    const second = await teamLink(t, ownerId, workspaceId);
    expect(second.token).toBe(first.token);
  });

  test("the access map cannot be team-linked either", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    expect(
      errorCode(await captureError(() => teamLink(t, ownerId, workspaceId, "privacy.md"))),
    ).toBe("PATH_NOT_SHAREABLE");
  });

  test("it is listed as an audience, not as a person", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId);

    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0].recipient).toBe("Anyone with access");
  });
});

describe("who it opens for", () => {
  test("a member", async () => {
    const t = setupTest();
    const { ownerId, memberId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId);

    expect(
      await asUser(t, memberId).query(api.functions.shares.resolveShare, { token }),
    ).not.toBeNull();
  });

  test("an editor", async () => {
    const t = setupTest();
    const { ownerId, editorId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId);

    expect(
      await asUser(t, editorId).query(api.functions.shares.resolveShare, { token }),
    ).not.toBeNull();
  });

  test("the owner", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId);

    expect(
      await asUser(t, ownerId).query(api.functions.shares.resolveShare, { token }),
    ).not.toBeNull();
  });

  /**
   * THE test. The token makes the URL unguessable; it does not grant anything.
   * Somebody who is not in the context holding a real link gets the same
   * nothing as somebody holding an invented one.
   */
  test("not a stranger, even holding a real link", async () => {
    const t = setupTest();
    const { ownerId, strangerId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId);

    const real = await asUser(t, strangerId).query(api.functions.shares.resolveShare, {
      token,
    });
    const invented = await asUser(t, strangerId).query(
      api.functions.shares.resolveShare,
      { token: "z".repeat(64) },
    );
    expect(real).toBeNull();
    expect(real).toEqual(invented);
  });

  /**
   * The sentence "remove someone and the link stops working for them" is the
   * whole promise of a team link, and it is checked live on every read rather
   * than recorded at share time.
   */
  test("and not somebody who has been removed since", async () => {
    const t = setupTest();
    const { ownerId, memberId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId);
    expect(
      await asUser(t, memberId).query(api.functions.shares.resolveShare, { token }),
    ).not.toBeNull();

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", workspaceId).eq("userId", memberId),
        )
        .unique();
      await ctx.db.delete(membership!._id);
    });

    expect(
      await asUser(t, memberId).query(api.functions.shares.resolveShare, { token }),
    ).toBeNull();
  });

  test("a signed-out caller opens nothing", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId);
    expect(
      await captureError(() => t.query(api.functions.shares.resolveShare, { token })),
    ).toBeInstanceOf(Error);
  });
});

describe("taking it back", () => {
  test("revoking kills it for everybody at once", async () => {
    const t = setupTest();
    const { ownerId, memberId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId);
    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });

    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    expect(
      await asUser(t, memberId).query(api.functions.shares.resolveShare, { token }),
    ).toBeNull();
  });

  test("re-making it after a revoke mints a new token", async () => {
    const t = setupTest();
    const { ownerId, memberId, workspaceId } = await scenario(t);
    const first = await teamLink(t, ownerId, workspaceId);
    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    const second = await teamLink(t, ownerId, workspaceId);
    expect(second.token).not.toBe(first.token);
    // The link already sent stays dead.
    expect(
      await asUser(t, memberId).query(api.functions.shares.resolveShare, {
        token: first.token,
      }),
    ).toBeNull();
  });
});

describe("it is not a way around anything", () => {
  /**
   * A team link is an address for people who can already read the note. It
   * hands nobody a note their membership does not reach, and the two halves of
   * that are: membership is checked here, and visibility is checked on the read
   * itself against the live `privacy.md` at `team` scope — see
   * `shareRead.test.ts`.
   */
  test("it appears in no personal inbox, because it was sent to nobody", async () => {
    const t = setupTest();
    const { ownerId, memberId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId);

    expect(
      await asUser(t, memberId).query(api.functions.shares.listSharedWithMe, {}),
    ).toEqual([]);
  });

  test("a team link does not make its reader a member", async () => {
    const t = setupTest();
    const { ownerId, strangerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId);

    const memberships = await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(memberships.map((row) => row.userId)).not.toContain(strangerId);
  });

  /**
   * The audience lives in exactly one field. A share carrying both a
   * `recipientKind` and a separate `audience` could disagree with itself, and
   * the direction that fails is "more people can read this than the owner
   * chose".
   */
  test("the audience is stored once", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId);

    const row = await t.run((ctx) => ctx.db.query("noteShares").first());
    expect(row!.recipientKind).toBe("members");
    expect(row!.recipient).toBe("");
    expect(row).not.toHaveProperty("audience");
  });

  /** A personal share is untouched by any of this. */
  test("a personal share still refuses everybody but its recipient", async () => {
    const t = setupTest();
    const { ownerId, memberId, workspaceId } = await scenario(t);
    const lk = await createUser(t, "lk@example.invalid");
    await createWorkspace(t, lk, "lk");

    const { token } = await asUser(t, ownerId).mutation(
      api.functions.shares.createShare,
      { workspaceId, path: NOTE, recipient: "@lk" },
    );

    expect(
      await asUser(t, lk).query(api.functions.shares.resolveShare, { token }),
    ).not.toBeNull();
    // A member of the context is still not the person it was addressed to.
    expect(
      await asUser(t, memberId).query(api.functions.shares.resolveShare, { token }),
    ).toBeNull();
  });
});

/**
 * WHAT AN UNAUTHENTICATED CRAWLER IS TOLD ABOUT A READABLE LINK.
 *
 * `/console/@seyi?note=…` is **guessable**, so this is the one preview lookup
 * whose argument an attacker can construct. What bounds it is that it answers
 * only for notes the owner has explicitly team-linked: everything else is one
 * `null`, byte-identical to a note that does not exist.
 *
 * Every refusal below is that same `null`, and the tests compare whole
 * responses rather than "it was falsy", because the moment one of them starts
 * differing the probe learns something.
 */
describe("the readable link's preview", () => {
  /**
   * **One absence, and it has to stay one object.** `children` joined it when a
   * folder link learned to name what is inside — and an empty array is what an
   * unlinked path, a revoked link, a note, an empty folder and a folder whose
   * contents are all private every one of them answer with.
   */
  const NOTHING = { title: null, cardToken: null, children: [] as string[] };

  async function preview(t: TestConvex, slug: string, path: string) {
    return await t.query(api.functions.shares.previewForNote, { slug, path });
  }

  test("a team-linked note gives its title and its card", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId);

    expect(await preview(t, "owner-workspace", NOTE)).toEqual({
      title: "Overview",
      children: [],
      cardToken: token,
    });
  });

  test("the handle may be written with or without its sigil", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId);

    expect(await preview(t, "@owner-workspace", NOTE)).toEqual(
      await preview(t, "owner-workspace", NOTE),
    );
  });

  /**
   * THE bound. A note nobody has linked is the same answer as a note that does
   * not exist, so probing paths reveals only the set the owner published.
   */
  test("a note nobody linked is the same answer as one that does not exist", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId);

    expect(await preview(t, "owner-workspace", "1-projects/never-linked.md")).toEqual(NOTHING);
    expect(await preview(t, "owner-workspace", "1-projects/does-not-exist.md")).toEqual(
      NOTHING,
    );
  });

  test("a handle nobody holds says nothing", async () => {
    const t = setupTest();
    await scenario(t);
    expect(await preview(t, "nobody-at-all", NOTE)).toEqual(NOTHING);
  });

  /**
   * The owner's own switch. Turning the title off must reach this path, or the
   * control is one that is read and discarded — worse than one that does not
   * exist.
   */
  test("a link whose owner turned the title off says nothing", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await asUser(t, ownerId).mutation(api.functions.shares.createTeamShare, {
      workspaceId,
      path: NOTE,
      titleInPreview: false,
    });

    expect(await preview(t, "owner-workspace", NOTE)).toEqual(NOTHING);
  });

  test("revoking makes it indistinguishable from never linked", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId);
    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    expect(await preview(t, "owner-workspace", NOTE)).toEqual(NOTHING);
  });

  /**
   * A **personal** share's token is a locator whose holder the owner chose, and
   * this endpoint is unauthenticated — so it must never hand one out. Only
   * `members` rows are ever consulted.
   */
  test("a personal share is invisible here, token and all", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const lk = await createUser(t, "lk@example.invalid");
    await createWorkspace(t, lk, "lk");

    const { token } = await asUser(t, ownerId).mutation(
      api.functions.shares.createShare,
      { workspaceId, path: NOTE, recipient: "@lk" },
    );

    const answer = await preview(t, "owner-workspace", NOTE);
    expect(answer).toEqual(NOTHING);
    expect(JSON.stringify(answer)).not.toContain(token);
  });

  test("the access map and history are never previewed", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId);

    expect(await preview(t, "owner-workspace", "privacy.md")).toEqual(NOTHING);
    expect(await preview(t, "owner-workspace", ".history/1-projects/a.md")).toEqual(NOTHING);
  });

  test("a traversing path is refused rather than resolved", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId);

    expect(await preview(t, "owner-workspace", "1-projects/../../privacy.md")).toEqual(
      NOTHING,
    );
  });

  /**
   * Three fields, and every one of them had to be argued for separately.
   *
   * `title` is the note's own name; `cardToken` is a locator that grants
   * nothing; `children` is empty for a note and is two or three team-visible
   * names for a folder. Nothing about the owner, the context, or the path.
   *
   * The exact key set is asserted rather than a subset, because the failure
   * this guards against is somebody adding "just the workspace name" and
   * publishing it to the internet.
   */
  test("it returns the title, a card locator and what is inside — nothing else", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId);

    const answer = await preview(t, "owner-workspace", NOTE);
    expect(Object.keys(answer).sort()).toEqual(["cardToken", "children", "title"]);
    // A note has no children, and nothing had to read a bucket to say so.
    expect(answer.children).toEqual([]);
    expect(JSON.stringify(answer)).not.toContain("owner@example.invalid");
    expect(JSON.stringify(answer)).not.toContain("1-projects");
  });
});

