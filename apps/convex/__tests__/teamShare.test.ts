/**
 * A LINK FOR EVERYONE WHO ALREADY HAS ACCESS.
 *
 * The second kind of share, and its authorization runs the other way round from
 * the first:
 *
 *  - A **personal** share is addressed to one named person. Holding the token
 *    is not enough; you must be who it was sent to.
 *  - A **team** share is addressed to nobody. Holding the token is not enough
 *    either — you must be a **member of the context**, checked live on every
 *    read, so removing somebody takes the link with them.
 *
 * In both cases the token is what makes the URL unguessable and *not* what
 * grants access. That distinction is what makes the link's card safe to carry
 * the note's title, where `/console/@slug?note=…` addresses the same note and
 * must not: anyone who knows the handle can type that one, so a titled card
 * there would answer "does this note exist?" to whoever asked.
 *
 * The property with teeth is the last one below: **a team share is not a way
 * around visibility.** It reaches only what the reader's membership already
 * reaches, so it can never hand somebody a note their role could not open.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

const NOTE = "1-projects/transition/overview.md";

async function scenario(t: TestConvex) {
  const ownerId = await createUser(t, "owner@example.invalid");
  const memberId = await createUser(t, "member@example.invalid");
  const editorId = await createUser(t, "editor@example.invalid");
  const strangerId = await createUser(t, "stranger@example.invalid");

  const workspaceId = await createWorkspace(t, ownerId, "owner-brain");
  await addMember(t, workspaceId, memberId, "member");
  await addMember(t, workspaceId, editorId, "editor");
  await createWorkspace(t, strangerId, "elsewhere");

  return { ownerId, memberId, editorId, strangerId, workspaceId };
}

function teamLink(
  t: TestConvex,
  actorId: Id<"users">,
  workspaceId: Id<"workspaces">,
  path: string = NOTE,
) {
  return asUser(t, actorId).mutation(api.functions.shares.createTeamShare, {
    workspaceId,
    path,
  });
}

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
  const NOTHING = { title: null, cardToken: null };

  async function preview(t: TestConvex, slug: string, path: string) {
    return await t.query(api.functions.shares.previewForNote, { slug, path });
  }

  test("a team-linked note gives its title and its card", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId);

    expect(await preview(t, "owner-brain", NOTE)).toEqual({
      title: "Overview",
      cardToken: token,
    });
  });

  test("the handle may be written with or without its sigil", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId);

    expect(await preview(t, "@owner-brain", NOTE)).toEqual(
      await preview(t, "owner-brain", NOTE),
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

    expect(await preview(t, "owner-brain", "1-projects/never-linked.md")).toEqual(NOTHING);
    expect(await preview(t, "owner-brain", "1-projects/does-not-exist.md")).toEqual(
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

    expect(await preview(t, "owner-brain", NOTE)).toEqual(NOTHING);
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

    expect(await preview(t, "owner-brain", NOTE)).toEqual(NOTHING);
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

    const answer = await preview(t, "owner-brain", NOTE);
    expect(answer).toEqual(NOTHING);
    expect(JSON.stringify(answer)).not.toContain(token);
  });

  test("the access map and history are never previewed", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId);

    expect(await preview(t, "owner-brain", "privacy.md")).toEqual(NOTHING);
    expect(await preview(t, "owner-brain", ".history/1-projects/a.md")).toEqual(NOTHING);
  });

  test("a traversing path is refused rather than resolved", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId);

    expect(await preview(t, "owner-brain", "1-projects/../../privacy.md")).toEqual(
      NOTHING,
    );
  });

  /** One field, and it is the title. Nothing about the owner or the context. */
  test("it returns the title and a card locator, and nothing else", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId);

    const answer = await preview(t, "owner-brain", NOTE);
    expect(Object.keys(answer).sort()).toEqual(["cardToken", "title"]);
    expect(JSON.stringify(answer)).not.toContain("owner@example.invalid");
    expect(JSON.stringify(answer)).not.toContain("1-projects");
  });
});

describe("a folder gets a link too", () => {
  const FOLDER = "1-projects/transition";

  /**
   * A team link is an *address*, and a folder has one — so "a link to this
   * folder" is a sentence that means something. A **personal** share stays
   * note-only: "share this folder with one outsider" would have to decide what
   * a folder share reaches, and "the notes in it, but not its subfolders,
   * unless those are also team" is a rule nobody could predict.
   */
  test("an owner can link a folder", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId, FOLDER);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * **A folder link works; its card stays frozen.**
   *
   * `previewForNote` is unauthenticated, and the argument that licenses it
   * answering at all turns on one word in CLAUDE.md: *guessable*. A share link
   * is `/s/<64 hex>`, so the premise the frozen card protects does not hold
   * there. A team link is `/@name/path`, which is guessable — and the original
   * decision survived that only because the probe space was note FILENAMES.
   *
   * Widening the preview to folders collapsed that space to five values.
   * `scaffold.ts` writes `0-inbox`, `1-projects`, `2-areas`, `3-resources` and
   * `4-archive` into every brain this product creates, and CLAUDE.md documents
   * them. Five guesses per handle confirmed the handle existed and returned a
   * live 64-hex token — from an unauthenticated caller who set a crawler's
   * User-Agent.
   *
   * So the link keeps working and the card does not: a folder unfurls as the
   * generic product card, which is what every guessable address gets. This is
   * the existing decision applied, not a new one — "a share link's preview may
   * carry a title; nothing else's may."
   */
  test("a folder link's card stays frozen, because its address is guessable", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, FOLDER);

    expect(
      await t.query(api.functions.shares.previewForNote, {
        slug: "owner-brain",
        path: FOLDER,
      }),
    ).toEqual({ title: null, cardToken: null });
  });

  /**
   * The guard's SHAPE, which the folder case alone does not pin: `endsWith`
   * relaxed to `includes`, or the `toLowerCase` dropped, both leave the folder
   * test green because the five scaffold names contain no `.md` at all. The
   * attack stays closed under either, but the rule this whole change rests on
   * would be held by nothing.
   */
  test.each([
    ["1-projects/a.md.png", null],
    ["1-projects/x.mdx", null],
    // "UPPER", not "Upper": `titleFromPath` uppercases the first character and
    // leaves the rest, which is what a note called README deserves. Measured —
    // the first version of this line predicted title-casing and was wrong.
    ["1-projects/UPPER.MD", "UPPER"],
    ["1-projects/a.png.md", "A.png"],
  ])("%s previews as %s", async (path, title) => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, path);

    expect(
      await t.query(api.functions.shares.previewForNote, { slug: "owner-brain", path }),
    ).toMatchObject({ title });
  });

  /**
   * And the refusal is byte-identical to every other one, so a probe cannot
   * tell "this is a folder, they exist" from "no such handle".
   */
  test("and that refusal is the same one an unknown handle gets", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, FOLDER);

    const folder = await t.query(api.functions.shares.previewForNote, {
      slug: "owner-brain",
      path: FOLDER,
    });
    const stranger = await t.query(api.functions.shares.previewForNote, {
      slug: "nobody-at-all",
      path: FOLDER,
    });
    expect(folder).toEqual(stranger);
  });

  test("a member opens it and a stranger does not", async () => {
    const t = setupTest();
    const { ownerId, memberId, strangerId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId, FOLDER);

    expect(
      await asUser(t, memberId).query(api.functions.shares.resolveShare, { token }),
    ).not.toBeNull();
    expect(
      await asUser(t, strangerId).query(api.functions.shares.resolveShare, { token }),
    ).toBeNull();
  });

  /**
   * The refusal that survives the folder relaxation. `.history/` is every
   * revision of every note and `privacy.md` is the access map; widening the
   * path check to allow folders must not widen it to those.
   */
  test.each([
    [".history", "the history store"],
    [".history/1-projects", "a folder inside it"],
    [".images", "the image store"],
    ["privacy.md", "the access map"],
  ])("%s cannot be linked (%s)", async (path) => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    expect(
      errorCode(await captureError(() => teamLink(t, ownerId, workspaceId, path))),
    ).toBe("PATH_NOT_SHAREABLE");
  });

  /**
   * The axis the fixtures above hold constant: every path in them is a note, a
   * folder, or plumbing. The rule as written is none of those three — it is
   * "anything that is not plumbing" — and narrowing it to what its own comment
   * described ("a note, or a path with no extension") passed all 1,374 checks.
   *
   * So this pins what the code actually does. A member can already read a
   * non-note file at their tier, and a team link grants nothing, so linking one
   * is no escalation — but the rule should be held as written rather than as
   * imagined, in both directions: wide enough for an attachment, and still
   * refusing plumbing.
   */
  test("a non-note file can be linked too, because the rule is 'not plumbing'", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId, "1-projects/diagram.png");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  /** A personal share is still note-only. */
  test("a non-note file cannot be shared with one person either", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const lk = await createUser(t, "lk2@example.invalid");
    await createWorkspace(t, lk, "lk2");

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, ownerId).mutation(api.functions.shares.createShare, {
            workspaceId,
            path: "1-projects/diagram.png",
            recipient: "@lk2",
          }),
        ),
      ),
    ).toBe("PATH_NOT_SHAREABLE");
  });

  /** A personal share is still note-only. */
  test("a folder cannot be shared with one person", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const lk = await createUser(t, "lk@example.invalid");
    await createWorkspace(t, lk, "lk");

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, ownerId).mutation(api.functions.shares.createShare, {
            workspaceId,
            path: FOLDER,
            recipient: "@lk",
          }),
        ),
      ),
    ).toBe("PATH_NOT_SHAREABLE");
  });
});
