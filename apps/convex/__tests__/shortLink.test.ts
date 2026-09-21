/**
 * SHORT LINKS — `context.lc/@seyi/intake`, the same share row under a name.
 *
 * A short link gives up the one property that makes `/s/<64 hex>` safe: nobody
 * can type a token, and everybody can type a word. That is the product — a
 * link goes in an email signature, on a card, into a sentence somebody says
 * out loud — and it is only defensible because of what it does *not* change.
 *
 * So the properties proved here are the boundaries, not the happy path:
 *
 *  1. **It is a locator, never a tier.** A short link reaches exactly what its
 *     token reaches, through the same `authorizeShareRead`, against the live
 *     `privacy.md`. A private note is absent through it.
 *  2. **Revocation kills both addresses at once**, and a revoked slug is
 *     indistinguishable from one nobody ever claimed.
 *  3. **The token never comes back.** Somebody who guessed a slug must not end
 *     up holding the bearer value, which would outlive the name they guessed.
 *  4. **Only an owner claims one**, and only one live row per name.
 *  5. **A name this product writes cannot be claimed**, so the `@name/<path>`
 *     addressing `CLAUDE.md` keeps the door open for cannot be squatted.
 *  6. **The card names the note or names nothing**, with one shape for every
 *     absence.
 */

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { cardImageLeaf, cardSignature, hashTitle } from "../functions/lib/cardKey";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import {
  MAX_SHORT_LINK_SLUG,
  isClaimableShortLinkSlug,
  shortLinkSlugFrom,
  shortLinkSlugRejection,
} from "../functions/lib/shareSlug";
import shortLinkSlugCases from "../../../infra/router/src/shortLinkSlug.fixtures.json";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const ENTRY = "1-projects/intake/overview.md";
const OTHER = "1-projects/intake/rates.md";
const PRIVATE_NOTE = "2-areas/salaries.md";
const PRIVATE_MARKER = "zzq-private-marker-2f71-never-through-a-short-link";

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  member: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const member = await createUser(t, "member@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "seyi");
  await t.run(async (ctx) => {
    await ctx.db.insert("workspaceMembers", {
      workspaceId,
      userId: member,
      role: "member" as const,
      joinedAt: Date.now(),
    });
  });

  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed(ENTRY, "# New project intake\n\nWhat I need before a first call.\n");
  backend.seed(OTHER, "# Rates\n\nThe numbers.\n");
  backend.seed(PRIVATE_NOTE, `# Salaries\n\n${PRIVATE_MARKER}\n`);
  vi.stubGlobal("fetch", backend.fetchImpl);

  const encryptedSecretAccessKey = await encryptSecret(
    FAKE_STORAGE.secretAccessKey,
    requireKeyset(),
    { workspaceId },
  );
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId,
    path: "1-projects",
    visibility: "team",
  });

  return { t, owner, member, workspaceId, backend };
}

/** Mint an unlisted link over `path` and return its share id and token. */
async function unlisted(
  f: Fixture,
  path: string = ENTRY,
): Promise<{ shareId: Id<"noteShares">; token: string }> {
  const { token } = await asUser(f.t, f.owner).action(
    api.functions.shares.createLinkShare,
    { workspaceId: f.workspaceId, path },
  );
  const rows = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
    workspaceId: f.workspaceId,
  });
  const row = rows.find((candidate) => candidate.token === token);
  expect(row).toBeDefined();
  return { shareId: row!.shareId, token };
}

/** Claim `slug` for a freshly minted unlisted link over `path`. */
async function shortLink(
  f: Fixture,
  slug: string,
  path: string = ENTRY,
): Promise<{ shareId: Id<"noteShares">; token: string }> {
  const share = await unlisted(f, path);
  await asUser(f.t, f.owner).mutation(api.functions.shares.setShareSlug, {
    shareId: share.shareId,
    slug,
  });
  return share;
}

/** Open a short link with no session at all, which is the whole point. */
function openAnonymously(f: Fixture, slug: string, path?: string) {
  return f.t.action(api.functions.shares.readShortLink, {
    handle: "seyi",
    slug,
    ...(path === undefined ? {} : { path }),
  });
}

/* ------------------------------ the slug rules ---------------------------- */

describe("what may be claimed", () => {
  test("an ordinary word is claimable", () => {
    for (const slug of ["intake", "rates", "2026-intake", "a", "book-a-call"]) {
      expect(shortLinkSlugRejection(slug)).toBeNull();
    }
  });

  test("shape refusals each say what to do about them", () => {
    expect(shortLinkSlugRejection("")).toMatch(/needs a name/);
    expect(shortLinkSlugRejection("a".repeat(MAX_SHORT_LINK_SLUG + 1))).toMatch(/at most/);
    expect(shortLinkSlugRejection("Intake")).toMatch(/lowercase/);
    expect(shortLinkSlugRejection("-intake")).toMatch(/hyphen/);
    expect(shortLinkSlugRejection("intake-")).toMatch(/hyphen/);
    expect(shortLinkSlugRejection("my intake")).toMatch(/lowercase/);
    expect(shortLinkSlugRejection("client/intake")).toMatch(/lowercase/);
    expect(shortLinkSlugRejection("intake.md")).toMatch(/lowercase/);
  });

  test("a name this product writes into every workspace cannot be claimed", () => {
    // The folder and the file are the same guess to somebody typing a URL, and
    // only one of them is on the list this reads.
    for (const slug of ["1-projects", "0-inbox", "4-archive", "index", "privacy", "todo"]) {
      expect(shortLinkSlugRejection(slug)).toMatch(/Context writes/);
    }
  });

  test("a word the console may want under a handle is reserved", () => {
    for (const slug of ["settings", "billing", "mcp", "oauth", "s"]) {
      expect(shortLinkSlugRejection(slug)).toMatch(/reserved/);
    }
  });

  test("a share token cannot be a name, because the length rule gets there first", () => {
    // Stated where it is enforced. A separate "not 64 hex" rule was written
    // and this check found it unreachable: a token is 64 characters and a slug
    // stops at 48, so one address can only ever have one meaning.
    expect(shortLinkSlugRejection("a".repeat(64))).toMatch(/at most/);
    expect(shortLinkSlugRejection("a".repeat(48))).toBeNull();
  });

  test("the shape rule agrees with the router's copy of it, case for case", () => {
    // The router cannot import from `apps/convex`, so the rule is written
    // twice. Neither copy is trusted to match a comment: both run this corpus,
    // and `preview.test.ts` there runs the same file.
    for (const item of shortLinkSlugCases.cases) {
      expect(
        shortLinkSlugFrom(item.segment) !== null,
        `${JSON.stringify(item.segment)} parses`,
      ).toBe(item.parses);
      expect(
        isClaimableShortLinkSlug(item.segment),
        `${JSON.stringify(item.segment)} is claimable`,
      ).toBe(item.claimable);
    }
    // Non-vacuity: a corpus that lost its entries would pass by running
    // nothing, and it should only ever grow.
    expect(shortLinkSlugCases.cases.length).toBeGreaterThan(20);
    expect(shortLinkSlugCases.cases.some((item) => item.parses)).toBe(true);
    expect(shortLinkSlugCases.cases.some((item) => !item.parses)).toBe(true);
    expect(
      shortLinkSlugCases.cases.some((item) => item.parses && !item.claimable),
      "the corpus must hold a well-formed name that still cannot be claimed",
    ).toBe(true);
  });

  test("the edge's shape check accepts exactly what may be claimed, reserved words included", () => {
    // Reserved words parse and then resolve to nothing, because no row can
    // hold one. A second list here would be a second place to disagree.
    expect(shortLinkSlugFrom("settings")).toBe("settings");
    expect(shortLinkSlugFrom("intake")).toBe("intake");
    expect(shortLinkSlugFrom("Intake")).toBeNull();
    expect(shortLinkSlugFrom("a/b")).toBeNull();
    expect(shortLinkSlugFrom("../etc")).toBeNull();
    expect(shortLinkSlugFrom("")).toBeNull();
    expect(isClaimableShortLinkSlug("intake")).toBe(true);
    expect(isClaimableShortLinkSlug("settings")).toBe(false);
  });
});

/* --------------------------- what it reaches ------------------------------ */

describe("what a short link reaches", () => {
  test("a reader with no session gets the note", async () => {
    const f = await fixture();
    await shortLink(f, "intake");

    const result = await openAnonymously(f, "intake");
    expect(result.path).toBe(ENTRY);
    expect(result.text).toContain("# New project intake");
    expect(result.openToAnyone).toBe(true);
  });

  test("the case somebody types does not decide whether the link works", async () => {
    const f = await fixture();
    await shortLink(f, "intake");
    const result = await openAnonymously(f, "INTAKE");
    expect(result.path).toBe(ENTRY);
  });

  test("and a private note is absent through it, exactly as through its token", async () => {
    const f = await fixture();
    await shortLink(f, "intake");

    const failure = await captureError(() => openAnonymously(f, "intake", PRIVATE_NOTE));
    expect(JSON.stringify(failure)).not.toContain(PRIVATE_MARKER);
  });

  test("a note the link is not rooted at is refused, bound and all", async () => {
    const f = await fixture();
    await shortLink(f, "intake");
    // `OTHER` is team-visible and is not linked from the entry note, so the
    // traversal bound is the only thing refusing it — the same bound the token
    // path is held to.
    const failure = await captureError(() => openAnonymously(f, "intake", OTHER));
    expect(failure).not.toBeNull();
  });

  test("an unclaimed name, a released one and a revoked one refuse identically", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");

    const never = await captureError(() => openAnonymously(f, "nothing-here"));

    await asUser(f.t, f.owner).mutation(api.functions.shares.setShareSlug, {
      shareId: share.shareId,
      slug: null,
    });
    const released = await captureError(() => openAnonymously(f, "intake"));

    await asUser(f.t, f.owner).mutation(api.functions.shares.setShareSlug, {
      shareId: share.shareId,
      slug: "intake",
    });
    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, {
      shareId: share.shareId,
    });
    const revoked = await captureError(() => openAnonymously(f, "intake"));

    expect(JSON.stringify(never)).toBe(JSON.stringify(released));
    expect(JSON.stringify(never)).toBe(JSON.stringify(revoked));
  });

  test("revoking the share kills the token too, so there is one revocation", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");
    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, {
      shareId: share.shareId,
    });

    const byToken = await captureError(() =>
      f.t.action(api.functions.shares.readSharedNote, { token: share.token }),
    );
    expect(byToken).not.toBeNull();
  });

  test("an unknown handle refuses exactly as an unclaimed name does", async () => {
    const f = await fixture();
    await shortLink(f, "intake");

    const strangerHandle = await captureError(() =>
      f.t.action(api.functions.shares.readShortLink, { handle: "nobody", slug: "intake" }),
    );
    const unknownSlug = await captureError(() => openAnonymously(f, "nothing-here"));
    expect(JSON.stringify(strangerHandle)).toBe(JSON.stringify(unknownSlug));
  });

  test("the token is never handed to whoever opened the link", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");
    const result = await openAnonymously(f, "intake");
    expect(JSON.stringify(result)).not.toContain(share.token);
  });

  test("and resolving a slug to its token is declared internal", () => {
    // `convex-test` resolves a function by path and runs it, so calling this
    // one through the public surface proves nothing — the enforcement is
    // Convex's own, at the API boundary, and what decides it is the word in
    // the declaration. So the declaration is what this reads.
    const source = readFileSync(
      new URL("../functions/shares.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("export const shortLinkToken = internalQuery({");
    expect(source).not.toContain("export const shortLinkToken = query({");
  });
});

/* ----------------------------- who may claim ------------------------------ */

describe("claiming a name", () => {
  test("a member cannot claim one", async () => {
    const f = await fixture();
    const share = await unlisted(f);

    const failure = await captureError(() =>
      asUser(f.t, f.member).mutation(api.functions.shares.setShareSlug, {
        shareId: share.shareId,
        slug: "intake",
      }),
    );
    expect(failure).not.toBeNull();
    const unopened = await captureError(() => openAnonymously(f, "intake"));
    expect(unopened).not.toBeNull();
  });

  test("somebody outside the context is told the share does not exist", async () => {
    const f = await fixture();
    const share = await unlisted(f);
    const stranger = await createUser(f.t, "stranger@example.invalid");

    const failure = await captureError(() =>
      asUser(f.t, stranger).mutation(api.functions.shares.setShareSlug, {
        shareId: share.shareId,
        slug: "intake",
      }),
    );
    expect(errorCode(failure)).toBe("SHARE_NOT_FOUND");
  });

  test("a second live link cannot take a name already claimed", async () => {
    const f = await fixture();
    await shortLink(f, "intake");
    const second = await unlisted(f, OTHER);

    const failure = await captureError(() =>
      asUser(f.t, f.owner).mutation(api.functions.shares.setShareSlug, {
        shareId: second.shareId,
        slug: "intake",
      }),
    );
    expect(errorCode(failure)).toBe("SLUG_TAKEN");

    // And the link already pasted somewhere still points where it did.
    const result = await openAnonymously(f, "intake");
    expect(result.path).toBe(ENTRY);
  });

  test("re-claiming the same name on the same link is not a collision with itself", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");
    await asUser(f.t, f.owner).mutation(api.functions.shares.setShareSlug, {
      shareId: share.shareId,
      slug: "intake",
    });
    expect((await openAnonymously(f, "intake")).path).toBe(ENTRY);
  });

  test("a revoked link's name is free again", async () => {
    const f = await fixture();
    const first = await shortLink(f, "intake");
    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, {
      shareId: first.shareId,
    });

    const second = await unlisted(f, OTHER);
    await asUser(f.t, f.owner).mutation(api.functions.shares.setShareSlug, {
      shareId: second.shareId,
      slug: "intake",
    });
    expect((await openAnonymously(f, "intake")).path).toBe(OTHER);
  });

  test("a rejected name is refused with the reason, and nothing is written", async () => {
    const f = await fixture();
    const share = await unlisted(f);

    const failure = await captureError(() =>
      asUser(f.t, f.owner).mutation(api.functions.shares.setShareSlug, {
        shareId: share.shareId,
        slug: "1-projects",
      }),
    );
    expect(errorCode(failure)).toBe("SLUG_REJECTED");

    const rows = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    expect(rows.find((row) => row.shareId === share.shareId)?.slug).toBeUndefined();
  });

  test("the owner's own listing shows what was claimed", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");
    const rows = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    expect(rows.find((row) => row.shareId === share.shareId)?.slug).toBe("intake");
  });
});

/* -------------------------------- the card -------------------------------- */

describe("what a short link unfurls with", () => {
  test("the note's name, which is the whole reason to have one", async () => {
    const f = await fixture();
    await shortLink(f, "intake");
    const preview = await f.t.query(api.functions.shares.previewForShortLink, {
      handle: "seyi",
      slug: "intake",
    });
    expect(preview.title).toBe("Overview");
  });

  /*
    A SHORT LINK HAS ITS OWN CARD, AND ITS ADDRESS IS NOT A CAPABILITY.

    It used to unfurl with the product's marketing image, and the reason was
    sound: a card was addressable only by the share's **token**, a slug is a
    word anybody can type, and a preview that answered a guessed word with a
    64-character secret publishes the secret.

    The premise turned out to be a choice. `cardBytesForShortLink` addresses the
    same picture by the handle and slug the crawler already used to ask for the
    title, so the image arrives and the token never moves. These tests are about
    that boundary rather than about the picture: what may be asked for, by whom,
    and what every refusal looks like.
  */
  /** Give a share the leaf a successful render would have left on it. */
  async function drawCard(
    f: Fixture,
    share: { shareId: Id<"noteShares">; token: string },
    title = "Overview",
  ): Promise<void> {
    await f.t.mutation(internal.functions.shareCard.recordCardLeaf, {
      shareId: share.shareId,
      leaf: cardImageLeaf(share.token, title),
    });
  }

  function cardAt(f: Fixture, handle: string, slug: string) {
    return f.t.query(internal.functions.shareCard.cardLocationForShortLink, {
      handle,
      slug,
    });
  }

  /*
    WHOSE CONTEXT THE PICTURE MAY NAME.

    The card leads with the workspace handle, because a share is somebody's
    note being handed to somebody else. What bounds that is the *address*: a
    short link has already told the crawler `@seyi` before it asked for
    anything, and a token link has not. Drawing the handle on a token link's
    card would tell everyone it is ever forwarded to whose context it is —
    permanently, because a platform that unfurls a link copies the image.

    So this is the disclosure rule, checked at the one place it is decided.
  */
  test("a short link's card may name the workspace, because its URL already did", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");
    const subject = await f.t.query(internal.functions.shareCard.cardSubject, {
      shareId: share.shareId,
    });
    // `@seyi`, not `seyi`: the card interpolates this without decoration, and
    // a bare slug looks correct in a row and wrong in a picture.
    expect(subject?.handle).toBe("@seyi");
  });

  test("a token link's card may not, and that is the whole of the rule", async () => {
    const f = await fixture();
    // Same mint, same audience, same note — the only difference is that nobody
    // claimed a name, so the address discloses nothing.
    const share = await unlisted(f);
    const subject = await f.t.query(internal.functions.shareCard.cardSubject, {
      shareId: share.shareId,
    });
    expect(subject?.handle).toBeNull();
  });

  test("...and releasing the name takes it back off the card", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");
    await asUser(f.t, f.owner).mutation(api.functions.shares.setShareSlug, {
      shareId: share.shareId,
      slug: null,
    });
    const subject = await f.t.query(internal.functions.shareCard.cardSubject, {
      shareId: share.shareId,
    });
    expect(subject?.handle).toBeNull();
  });

  test("what the card calls the link comes off the row, never off the note", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");
    expect(
      (
        await f.t.query(internal.functions.shareCard.cardSubject, {
          shareId: share.shareId,
        })
      )?.kind,
    ).toBe("note");

    await asUser(f.t, f.owner).mutation(api.functions.shares.setShareCollecting, {
      shareId: share.shareId,
      collecting: true,
    });
    // A collect link is a form, and its card says so — with the one subtitle
    // that does not tell the reader to sign in, because the page it points at
    // takes answers from people who have no account to sign in to.
    expect(
      (
        await f.t.query(internal.functions.shareCard.cardSubject, {
          shareId: share.shareId,
        })
      )?.kind,
    ).toBe("form");
  });

  test("a claimed slug resolves to the card's leaf, and answers with its version", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");
    await drawCard(f, share);

    expect((await cardAt(f, "seyi", "intake"))?.leaf).toBe(
      cardImageLeaf(share.token, "Overview"),
    );
    const preview = await f.t.query(api.functions.shares.previewForShortLink, {
      handle: "seyi",
      slug: "intake",
    });
    expect(preview.cardVersion).toMatch(/^[0-9a-f]{8}$/);
  });

  test("...and the version is a cache key, not the token and not the leaf", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");
    await drawCard(f, share);
    const { cardVersion } = await f.t.query(
      api.functions.shares.previewForShortLink,
      { handle: "seyi", slug: "intake" },
    );
    // Eight hex characters, over the title alone. It exists because the edge
    // cannot invalidate an image and a different URL is the only invalidation
    // there is — not to describe the picture, and never to carry the secret
    // whose absence is the reason this route can exist at all.
    expect(cardVersion).toBe(hashTitle(cardSignature("Overview")));
    expect(share.token).not.toContain(cardVersion ?? "");
  });

  test("a share with no card yet has no version and no leaf", async () => {
    const f = await fixture();
    await shortLink(f, "intake");
    expect(await cardAt(f, "seyi", "intake")).toBeNull();
    expect(
      (
        await f.t.query(api.functions.shares.previewForShortLink, {
          handle: "seyi",
          slug: "intake",
        })
      ).cardVersion,
    ).toBeNull();
  });

  test("a card drawn for a title the owner has since replaced resolves nothing", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");
    // The leaf a *different* title would have produced, which is the state a
    // failed re-render leaves behind: nothing clears the field, so the tags
    // would update while the picture went on publishing the old name. The
    // card is the one thing here that cannot be taken back.
    await drawCard(f, share, "Something else entirely");
    expect(await cardAt(f, "seyi", "intake")).toBeNull();
    expect(
      (
        await f.t.query(api.functions.shares.previewForShortLink, {
          handle: "seyi",
          slug: "intake",
        })
      ).cardVersion,
    ).toBeNull();
  });

  test("a link shared with named people has no card at its slug", async () => {
    const f = await fixture();
    /*
      The rule `previewForShortLink` applies to the title, applied to the
      picture — and applied again rather than inherited, because these are two
      routes and a crawler can ask either. A memorable address for a link
      shared with named people is a reasonable thing to want and still works;
      it is the note's *name* that must not travel to somebody who guessed the
      word, and a cached unfurl cannot be taken back.
    */
    const created = await asUser(f.t, f.owner).mutation(
      api.functions.shares.createShare,
      { workspaceId: f.workspaceId, path: ENTRY, recipient: "@dan" },
    );
    const rows = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    const row = rows.find((candidate) => candidate.token === created.token)!;
    await asUser(f.t, f.owner).mutation(api.functions.shares.setShareSlug, {
      shareId: row.shareId,
      slug: "named",
    });
    await drawCard(f, { shareId: row.shareId, token: created.token });

    expect(await cardAt(f, "seyi", "named")).toBeNull();
  });

  test("a link whose owner turned the title off has no card either", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");
    /*
      THE SAME SWITCH, ASKED OF THE PICTURE.

      `previewForShortLink` has this test already — *a link whose owner turned
      the title off names nothing* — and the card route grew its own copy of
      the refusal. Two routes, two copies, and only one of them was checked:
      deleting `if (!share.titleInPreview) return null;` from
      `cardLocationForShortLink` reddened **nothing** in 3,204 tests.

      What that guard holds is not a nicety. The switch exists so an owner can
      hand out a link whose address says nothing about what is behind it, and
      the card is the one answer here that cannot be taken back — a crawler
      that has cached the picture has the note's name for good, whatever the
      owner changes afterwards.

      The console turns it off by re-minting the link, which supersedes the row
      in place and keeps its token and its slug.
    */
    await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
      workspaceId: f.workspaceId,
      path: ENTRY,
      titleInPreview: false,
    });
    // Drawn anyway, so the absence below is the switch and not a missing leaf.
    await drawCard(f, share);

    expect(await cardAt(f, "seyi", "intake")).toBeNull();
  });

  /*
    WHY THE EXPIRY BRANCH BESIDE THEM IS NOT TESTED HERE.

    `cardLocationForShortLink` also refuses an expired share, and that check is
    **unreachable from this route today**: `mintLinkShare` is the only path
    that writes `recipientKind: "anyone"` and it never sets `expiresAt`, while
    every path that does set one — all three inside `createShare` — needs a
    `recipient`, which makes the row a named share that the `anyone` refusal
    above has already turned away.

    So a test for it would assert a state this product cannot produce, and
    would pass just as happily with the branch deleted. It is written down
    instead: **the day an `anyone` link can be time-boxed, that branch becomes
    live and wants the test this comment is standing in for.**
  */

  test("every absence is the same absence", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");
    await drawCard(f, share);

    expect(await cardAt(f, "nobody", "intake")).toBeNull();
    expect(await cardAt(f, "seyi", "never-claimed")).toBeNull();
    expect(await cardAt(f, "seyi", "Not A Slug At All")).toBeNull();

    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, {
      shareId: share.shareId,
    });
    // Revoked reads exactly as never-existed, which is what keeps a revocation
    // invisible to whoever is probing for one.
    expect(await cardAt(f, "seyi", "intake")).toBeNull();
  });

  test("and never the note's contents, so no crawler reaches the bucket", async () => {
    const f = await fixture();
    await shortLink(f, "intake");
    const before = f.backend.requests.length;
    await f.t.query(api.functions.shares.previewForShortLink, {
      handle: "seyi",
      slug: "intake",
    });
    expect(f.backend.requests.length).toBe(before);
  });

  test("every absence is the same absence", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");
    const generic = { title: null, cardVersion: null };

    expect(
      await f.t.query(api.functions.shares.previewForShortLink, {
        handle: "nobody",
        slug: "intake",
      }),
    ).toEqual(generic);
    expect(
      await f.t.query(api.functions.shares.previewForShortLink, {
        handle: "seyi",
        slug: "never-claimed",
      }),
    ).toEqual(generic);
    expect(
      await f.t.query(api.functions.shares.previewForShortLink, {
        handle: "seyi",
        slug: "Not A Slug At All",
      }),
    ).toEqual(generic);

    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, {
      shareId: share.shareId,
    });
    expect(
      await f.t.query(api.functions.shares.previewForShortLink, {
        handle: "seyi",
        slug: "intake",
      }),
    ).toEqual(generic);
  });

  /*
    A SHORT LINK OVER A NAMED-RECIPIENT SHARE MUST NOT UNFURL.

    Every other check in this block builds its link with `unlisted`, which is
    `createLinkShare` — an `anyone` row, where a public title is the point.
    `createShare` is the other door: it takes a `@name` or an email, so its
    audience is named people, and it defaults `titleInPreview` to `true` the
    same way.

    Before short links that default was unreachable. The only address that
    resolved such a row was its 64-hex token, which nobody guesses, so the flag
    sat true on rows whose title no stranger could ask for. A slug is an
    owner-chosen word, and `setShareSlug` does not ask what the row's audience
    is — so the same default became answerable at a guessable address, to a
    caller with no session, for a note shared with named people only.

    The link itself still works: a named recipient signs in and reads it, and
    `readSharedNote` decides that exactly as before. What must not travel is the
    title, to somebody who is not on the list.
  */
  test("a link shared with named people does not unfurl its title to strangers", async () => {
    const f = await fixture();
    const { shareId } = await asUser(f.t, f.owner).mutation(
      api.functions.shares.createShare,
      { workspaceId: f.workspaceId, path: ENTRY, recipient: "@somebody" },
    ).then(async () => {
      const rows = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
        workspaceId: f.workspaceId,
      });
      const row = rows.find((candidate) => candidate.audience !== "anyone");
      expect(row).toBeDefined();
      return { shareId: row!.shareId };
    });
    await asUser(f.t, f.owner).mutation(api.functions.shares.setShareSlug, {
      shareId,
      slug: "intake",
    });
    expect(
      await f.t.query(api.functions.shares.previewForShortLink, {
        handle: "seyi",
        slug: "intake",
      }),
    ).toEqual({ title: null, cardVersion: null });
  });

  test("a link whose owner turned the title off names nothing", async () => {
    const f = await fixture();
    const share = await shortLink(f, "intake");
    // The console turns the card's name off by re-minting the link, which
    // supersedes the row in place and keeps its token — and, the check below
    // insists, its name.
    await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
      workspaceId: f.workspaceId,
      path: ENTRY,
      titleInPreview: false,
    });
    void share;
    expect(
      await f.t.query(api.functions.shares.previewForShortLink, {
        handle: "seyi",
        slug: "intake",
      }),
    ).toEqual({ title: null, cardVersion: null });
  });
});
