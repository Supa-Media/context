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
import { readFileSync } from "node:fs";
import {
  GENERIC_ROOT_KEYS,
  INDEX_KEY,
  PARA_FOLDERS,
  PRIVACY_KEY,
  PRODUCT_MANDATED_PATHS,
  isProductMandatedPath,
  scaffoldFiles,
} from "../functions/lib/scaffold";
import { isPlumbing } from "../functions/lib/privacy";
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
   * **THE test, and the one that reversed a decision.**
   *
   * The rule here was "a folder never carries a title", and its reasoning was
   * sound about the wrong thing. `previewForNote` is unauthenticated, so what
   * licenses it answering at all is that the address is not guessable — and
   * `scaffold.ts` writes `0-inbox`, `1-projects`, `2-areas`, `3-resources` and
   * `4-archive` into every brain this product creates. Five guesses per handle
   * were enough to learn which of those their owner had team-linked, so folders
   * were refused wholesale.
   *
   * Wholesale was too much. Guessability is a property of a *name*, not of
   * file-versus-folder, and `1-projects/transition` is no more guessable than
   * `1-projects/transition/overview.md` — one is five known values, the other
   * is a name its owner typed, and they are not the same argument. The refusal
   * belonged on the five, and `isProductMandatedPath` is where they now live
   * beside the six scaffolded filenames that were always in it.
   *
   * So: a folder the owner named unfurls with its name.
   */
  test("a folder the owner named unfurls with its name", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, FOLDER);

    expect(
      await t.query(api.functions.shares.previewForNote, {
        slug: "owner-brain",
        path: FOLDER,
      }),
    ).toMatchObject({ title: "Transition" });
  });

  /** ...and it gets a card to render that name onto, like any other link. */
  test("and it gets a card", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const { token } = await teamLink(t, ownerId, workspaceId, FOLDER);

    expect(
      await t.query(api.functions.shares.previewForNote, {
        slug: "owner-brain",
        path: FOLDER,
      }),
    ).toMatchObject({ cardToken: token });
  });

  /**
   * The half of the reversal that is still a refusal: the five names the
   * product wrote itself. This drives `PARA_FOLDERS` rather than restating it,
   * for the reason the scaffolded-files case below gives — a sixth folder would
   * otherwise become a sixth guess in silence.
   */
  test.each([...PARA_FOLDERS])(
    "%s is a folder anybody can guess, so its card stays frozen",
    async (path) => {
      const t = setupTest();
      const { ownerId, workspaceId } = await scenario(t);
      await teamLink(t, ownerId, workspaceId, path);

      expect(
        await t.query(api.functions.shares.previewForNote, { slug: "owner-brain", path }),
      ).toEqual({ title: null, cardToken: null });
    },
  );

  /**
   * The guard's SHAPE, which the two cases above do not pin between them:
   * `isProductMandatedPath` matches a scaffolded name **exactly**, and relaxing
   * that to `startsWith` — the obvious way to write "and everything under it" —
   * would silently freeze every note in the brain, since every one of them is
   * under a PARA folder. Both fixtures below are owner-chosen names that a
   * prefix match would swallow.
   */
  test.each([
    ["1-projects-archive", "a folder whose name begins with a scaffolded one"],
    ["1-projects/overview.md", "a note inside a scaffolded folder"],
  ])("%s still previews (%s)", async (path) => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, path);

    const answer = await t.query(api.functions.shares.previewForNote, {
      slug: "owner-brain",
      path,
    });
    expect(answer.title).not.toBeNull();
  });

  test.each([
    // A path that is not a note and not a folder either. The rule is neither
    // "ends in .md" nor "has no extension" — it is "the owner named it" — and
    // an attachment the owner linked is a name the owner chose.
    ["1-projects/a.md.png", "A.md.png"],
    ["1-projects/x.mdx", "X.mdx"],
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
   * The note-only rule's own premise, which the cases above assume rather than
   * check: that a note FILENAME is not guessable.
   *
   * For a fresh brain that is false, and by more than one file. `scaffoldFiles`
   * writes `privacy.md`, `index.md`, and a `README.md` into every one of the
   * five PARA folders — six guessable note names before the owner has written
   * anything — and the connected-client house rules put a `todo.md` at the
   * root. That is the same exhaustible space the five folder names are, so it
   * gets the same answer.
   *
   * This drives `scaffoldFiles` instead of restating its output on purpose: a
   * seventh scaffolded file would otherwise become a seventh guess silently,
   * and the whole reason this rule exists is that somebody counted the folders
   * once and never counted again.
   */
  test.each([
    ...scaffoldFiles("para")
      .map((file) => file.key)
      // `privacy.md` is in that list and cannot be team-linked at all —
      // `checkTeamSharePath` refuses plumbing long before the preview is
      // reached, so there is no share row for this to be asked about.
      .filter((key) => key.toLowerCase().endsWith(".md") && !isPlumbing(key)),
    "todo.md",
  ])("%s is a name anybody can guess, so its card stays frozen", async (path) => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, path);

    expect(
      await t.query(api.functions.shares.previewForNote, { slug: "owner-brain", path }),
    ).toEqual({ title: null, cardToken: null });
  });

  /**
   * The folder names the PRODUCT picks, which are not the five PARA ones.
   *
   * `#163` was right that guessability is a property of a name rather than of
   * file-versus-folder — `1-projects/transition` is exactly as unguessable as
   * the note inside it — and replaced a blanket `.md` refusal with a list.
   * Blanket rules hide their own edges, though, and the `.md` test had been
   * covering one: the session folder the gateway writes into is chosen by US,
   * not by the owner.
   *
   * `defaultSessionFolder` in `apps/mcp/src/index.js` returns
   * `4-archive/chat-history` when the manifest has a `4-archive` rule and
   * `0-inbox/sessions` otherwise, so every brain whose owner has ever run
   * `save_context` has one of them. Two guesses per handle, on names nobody
   * chose, which is the same shape as the five PARA folders and gets the same
   * answer.
   *
   * The nested platform folder beneath (`<folder>/<platform>/`) is a third
   * name we pick, but it only exists under one of these two, so refusing the
   * parent is where the bound belongs.
   */
  test.each([
    "4-archive/chat-history",
    "0-inbox/sessions",
  ])("%s is a folder this product named, not its owner", async (path) => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, path);

    expect(
      await t.query(api.functions.shares.previewForNote, { slug: "owner-brain", path }),
    ).toEqual({ title: null, cardToken: null });
  });

  /**
   * The gateway-written names are tied to their writers, not restated beside
   * them.
   *
   * This list has now shipped short four times — folders, the `.md` product
   * names, the session folders, and the hook capture folders — and each time
   * the fix was to add literals. Literals are unavoidable here (`apps/convex`
   * cannot import the Worker or the hook package), so what closes the loop is
   * reading the writers and asserting the list covers what they produce. That
   * is what `scaffoldFiles` already gets, and what these did not.
   */
  test("every folder `defaultSessionFolder` can return is in the list", () => {
    const gateway = readFileSync(
      new URL("../../mcp/src/index.js", import.meta.url),
      "utf8",
    );
    const fn = gateway.match(/function defaultSessionFolder\(rules\) \{\s*return [^;]*;/);
    expect(fn, "defaultSessionFolder is not the shape this reads").not.toBeNull();
    const returned = [...fn![0].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    expect(returned.length).toBeGreaterThan(1);
    for (const folder of returned) expect(PRODUCT_MANDATED_PATHS).toContain(folder);
  });

  test("and every client the hook installs has its capture folder in the list", () => {
    const install = readFileSync(
      new URL("../../../packages/hook/src/install.js", import.meta.url),
      "utf8",
    );
    // `writeInboxCapture` files an `external_id` capture under
    // `0-inbox/<safeSlug(source)>/`, and the hook's source is `hook:<id>`.
    //
    // This pins ONE of the four inputs to that folder name — the roster, which
    // is the one most likely to move. It does not read the `hook:` prefix in
    // `transcript.js`, nor `safeSlug`, nor the `0-inbox/` prefix. Measured:
    // changing the prefix to `context-hook:` leaves the suite green while every
    // real capture folder falls off the list. Stated rather than implied,
    // because a guard that reads one input of four looks like it reads all of
    // them.
    //
    // `0-inbox/inbox`, `0-inbox/granola` and `0-inbox/capture` have no
    // writer-driven check at all: they are pinned only by the router mirror,
    // which says "the two copies disagree" and never "the list is short". When
    // both copies were short, as they were before this PR, nothing fired.
    const ids = [...install.matchAll(/^\s{4}id: "([a-z0-9-]+)",$/gm)].map((m) => m[1]);

    expect(ids.length).toBeGreaterThan(2);
    for (const id of ids) expect(PRODUCT_MANDATED_PATHS).toContain(`0-inbox/hook-${id}`);
  });

  /**
   * **A canary, not a scan, and the difference is the point.**
   *
   * `store.put("<N>-folder/...")` matches the one literal form the gateway
   * uses today, so reformatting that line fires — which is what makes it worth
   * having. It does NOT see a template literal, a line break after `put(`,
   * single quotes, a hoisted constant, or a path built by a helper. Measured:
   * injecting ``store.put(`2-areas/calendar/agenda-${d}.md`, md)`` leaves the
   * whole suite green.
   *
   * The template-literal blindness is the one that matters, because
   * `0-inbox/${sourceSlug}/` and `${folder}/${platform}/` — the writers behind
   * the fourth omission and the named residual — are exactly that shape. A new
   * hardcoded path is caught; a new computed one is not, and no regex over
   * source will change that.
   *
   * It also reads `index.js` alone. `store.put` appears in `search/shards.js`,
   * `search/maintain.js` and `store/index.js`, all writing dot-prefixed keys
   * that `isPlumbing` refuses — safe today, and out of scope by argument now
   * rather than by silence.
   */
  test("and the calendar path the cron hardcodes", () => {
    const gateway = readFileSync(
      new URL("../../mcp/src/index.js", import.meta.url),
      "utf8",
    );
    const written = [...gateway.matchAll(/store\.put\("([0-4]-[a-z]+\/[^"]+)"/g)].map(
      (m) => m[1],
    );

    expect(written.length).toBeGreaterThan(0);
    for (const path of written) expect(PRODUCT_MANDATED_PATHS).toContain(path);
  });

  /**
   * The router's restated copy really does restate this one.
   *
   * `infra/router/src/preview.ts` refuses the same names to save a round trip,
   * and it holds a hand-written literal because it is a separate deployment
   * that cannot import this module. The comment there claimed the two were
   * "held together by running both against the same names"; they were not, and
   * a comment claiming a check nobody wrote is the thing that went wrong one
   * commit ago in `listFolder`. So here is the check.
   *
   * It reads the router's source rather than importing it, which is what the
   * mobile scope mirror does in `__tests__/consentScopes.test.ts` for the same
   * reason. Drift is not dangerous — the derived copy here is authoritative, so
   * a stale router costs a wasted round trip and never a title — but it is
   * silent, and silent is how the folder count stayed at five.
   */
  test("the edge router refuses exactly the same names", () => {
    const source = readFileSync(
      new URL("../../../infra/router/src/preview.ts", import.meta.url),
      "utf8",
    );
    const literal = source.match(/const PRODUCT_MANDATED_PATHS = new Set\(\[([^\]]*)\]\)/);
    expect(literal, "PRODUCT_MANDATED_PATHS is not a literal Set in preview.ts").not.toBeNull();
    const routed = [...literal![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    // The predicate's own list, not a third restatement of it. This array used
    // to be written out here, so the test held the router's copy against a copy
    // of its own and never asked the predicate — and adding a path to the
    // predicate left it green with the router short.
    expect([...routed].sort()).toEqual([...PRODUCT_MANDATED_PATHS].sort());
    // ...and the literal is not merely equal to the list, it is equal to what
    // the predicate actually does, which is the thing the router is mirroring.
    for (const path of routed) expect(isProductMandatedPath(path)).toBe(true);
  });

  /**
   * ...and a name the OWNER chose still carries its title, which is the whole
   * point. A rule that refused every note would have been the frozen card back.
   */
  test("while a name the owner chose still previews", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, "1-projects/acme-migration.md");

    expect(
      await t.query(api.functions.shares.previewForNote, {
        slug: "owner-brain",
        path: "1-projects/acme-migration.md",
      }),
      // "Acme migration": `titleFromPath` uppercases the first character and
      // turns hyphens into spaces. Measured — a first guess here said
      // "Acme-migration", which is the same mistake the `UPPER` comment above
      // records, made a second time by predicting instead of running it.
    ).toMatchObject({ title: "Acme migration" });
  });

  /**
   * And a scaffolded folder's refusal is byte-identical to every other one, so
   * a probe cannot tell "they team-linked `1-projects`" from "no such handle".
   * This is the property the whole rule exists to produce; without it, naming
   * the five names would only move the oracle rather than close it.
   */
  test("and that refusal is the same one an unknown handle gets", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await teamLink(t, ownerId, workspaceId, PARA_FOLDERS[1]);

    const folder = await t.query(api.functions.shares.previewForNote, {
      slug: "owner-brain",
      path: PARA_FOLDERS[1],
    });
    const stranger = await t.query(api.functions.shares.previewForNote, {
      slug: "nobody-at-all",
      path: PARA_FOLDERS[1],
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
