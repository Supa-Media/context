/**
 * AN UNLISTED SHARE — a link whose reader never signs in.
 *
 * Every other share in this product is a locator over a grant addressed to
 * somebody: possession of the URL is not what authorizes the read, membership
 * or identity is, and that is what makes revocation mean something. An
 * `anyone` share is the one kind where possession *is* the authorization, and
 * the owner asked for it deliberately with that cost in front of them — see
 * "An unlisted share is the third audience" in `CLAUDE.md`.
 *
 * So the properties worth proving here are the ones that stop it from becoming
 * the public tier non-negotiable #5 still refuses:
 *
 *  1. **It reaches exactly what a signed-in share reaches.** One note at
 *     `team` scope through the live `privacy.md`, plus that note's own links.
 *     A private note is absent through an unlisted link exactly as it is
 *     through a personal one — the manifest is checked on every read, and
 *     nothing about visibility is stored on the row.
 *  2. **It widens nothing else.** No other token becomes anonymously
 *     redeemable, and an anonymous caller holding a personal token learns
 *     nothing it did not already know.
 *  3. **Revocation works, and is invisible.** A revoked unlisted link is
 *     indistinguishable, to an anonymous holder, from one that never existed.
 *  4. **An unlisted link cannot be minted over a private note**, and cannot be
 *     minted by anybody but the owner.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
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

const ENTRY = "1-projects/transition/overview.md";
const LINKED = "1-projects/transition/proposal.md";
const PRIVATE_NOTE = "2-areas/salaries.md";
const PRIVATE_MARKER = "zzq-private-body-marker-4a91-never-shared";

/** Serialize a thrown error's payload so two failures can be compared exactly. */
function errorShape(error: unknown): string {
  return JSON.stringify((error as { data?: unknown }).data ?? null);
}

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  member: Id<"users">;
  lk: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  const lk = await createUser(t, "lk@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "atlas");
  await createWorkspace(t, lk, "lk");
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
  backend.seed(
    ENTRY,
    ["# Chapter transition", "", "See [the proposal](proposal.md).", ""].join("\n"),
  );
  backend.seed(LINKED, "# Proposal\n\nThe numbers.\n");
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

  return { t, owner, member, lk, workspaceId, backend };
}

/** Mint an unlisted link over `path`. */
async function unlisted(f: Fixture, path: string = ENTRY): Promise<string> {
  const { token } = await asUser(f.t, f.owner).action(
    api.functions.shares.createLinkShare,
    { workspaceId: f.workspaceId, path },
  );
  return token;
}

/** Read with NO session at all — the whole point of this file. */
function readAnonymously(f: Fixture, token: string, path?: string) {
  return f.t.action(api.functions.shares.readSharedNote, {
    token,
    ...(path === undefined ? {} : { path }),
  });
}

/* -------------------------------------------------------------------------- */

describe("what an unlisted link reaches", () => {
  test("a reader with no session at all gets the note", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    const result = await readAnonymously(f, token);
    expect(result.path).toBe(ENTRY);
    expect(result.text).toContain("# Chapter transition");
    expect(result.entryPath).toBe(ENTRY);
  });

  test("and the notes the entry note links to, exactly as a personal share does", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    const entry = await readAnonymously(f, token);
    expect(entry.links).toContain(LINKED);

    const linked = await readAnonymously(f, token, LINKED);
    expect(linked.text).toContain("# Proposal");
  });

  test("a note that is not linked from the entry note is refused", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    const error = await captureError(() => readAnonymously(f, token, PRIVATE_NOTE));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  /**
   * The single most important test in this file. Possession authorizes the
   * *read*; it never decides what the read may see. That stays the live
   * `privacy.md`, which is why nothing about visibility is stored on the row.
   */
  test("a note made private after the link was minted reads as absent", async () => {
    const f = await fixture();
    const token = await unlisted(f);
    expect((await readAnonymously(f, token)).text).toContain("# Chapter transition");

    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects",
      visibility: "private",
    });

    const error = await captureError(() => readAnonymously(f, token));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  /**
   * The courtesy refusal, and the one place it is deliberately imprecise: a
   * private note and a note that is not there are the same answer at `team`
   * scope, which is what stops that scope enumerating private paths.
   */
  test("an unlisted link can never be minted over a private note", async () => {
    const f = await fixture();
    const error = await captureError(() => unlisted(f, PRIVATE_NOTE));
    expect(errorCode(error)).toBe("PATH_NOT_TEAM_VISIBLE");
  });

  test("nor over privacy.md, which is the access map itself", async () => {
    const f = await fixture();
    const error = await captureError(() => unlisted(f, PRIVACY_KEY));
    expect(errorCode(error)).toBe("PATH_NOT_SHAREABLE");
  });

  test("only the owner may mint one", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.member).action(api.functions.shares.createLinkShare, {
        workspaceId: f.workspaceId,
        path: ENTRY,
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });
});

describe("what an unlisted link does NOT widen", () => {
  /**
   * The property that keeps this one kind of share from becoming a public
   * tier: an anonymous caller holding a *personal* token is told about their
   * own session and nothing about the share, byte for byte the same as one
   * holding a token nobody ever minted.
   */
  test("a personal share stays unreadable without a session, and says only that", async () => {
    const f = await fixture();
    const { token } = await asUser(f.t, f.owner).mutation(
      api.functions.shares.createShare,
      { workspaceId: f.workspaceId, path: ENTRY, recipient: "@lk" },
    );

    const held = await captureError(() => readAnonymously(f, token));
    const invented = await captureError(() => readAnonymously(f, "0".repeat(64)));

    expect(errorCode(held)).toBe("NOT_AUTHENTICATED");
    expect(errorShape(held)).toBe(errorShape(invented));
  });

  test("a members-only team link stays unreadable without a session", async () => {
    const f = await fixture();
    const { token } = await asUser(f.t, f.owner).mutation(
      api.functions.shares.createTeamShare,
      { workspaceId: f.workspaceId, path: ENTRY },
    );

    const error = await captureError(() => readAnonymously(f, token));
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });

  test("a signed-in stranger reads an unlisted link too — that is what it is for", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    const result = await asUser(f.t, f.lk).action(
      api.functions.shares.readSharedNote,
      { token },
    );
    expect(result.text).toContain("# Chapter transition");
  });
});

describe("taking an unlisted link back", () => {
  test("a revoked link is dead", async () => {
    const f = await fixture();
    const token = await unlisted(f);
    const [live] = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, {
      shareId: live!.shareId,
    });

    const error = await captureError(() => readAnonymously(f, token));
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });

  /**
   * And indistinguishable from one that never existed. A holder who could tell
   * "the owner took this back" from "this was never a link" has learned
   * something about a context they are not in — the rule every other refusal
   * on this path already follows.
   */
  test("and a revoked link is byte-identical to one that never existed", async () => {
    const f = await fixture();
    const token = await unlisted(f);
    const [live] = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, {
      shareId: live!.shareId,
    });

    const revoked = await captureError(() => readAnonymously(f, token));
    const invented = await captureError(() => readAnonymously(f, "1".repeat(64)));
    expect(errorShape(revoked)).toBe(errorShape(invented));
  });

  test("re-minting after a revocation gives a new token, so the old link stays dead", async () => {
    const f = await fixture();
    const first = await unlisted(f);
    const [live] = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, {
      shareId: live!.shareId,
    });

    const second = await unlisted(f);
    expect(second).not.toBe(first);
    expect((await readAnonymously(f, second)).text).toContain("# Chapter transition");
    expect(errorCode(await captureError(() => readAnonymously(f, first)))).toBe(
      "NOT_AUTHENTICATED",
    );
  });

  test("minting twice over one note supersedes rather than accumulating", async () => {
    const f = await fixture();
    const first = await unlisted(f);
    const second = await unlisted(f);

    expect(second).toBe(first);
    const rows = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    expect(rows).toHaveLength(1);
  });
});

describe("a share page is read-only, and only a member is offered a way out", () => {
  /**
   * The page draws rendered markdown and calls one action; there is no write
   * anywhere in the feature (`apps/mobile/__tests__/shareReadOnly.test.ts`
   * checks that structurally). What the server owes it is the one fact it
   * cannot work out for itself: whether *this* reader could edit the note
   * somewhere they already have access to.
   */
  test("an anonymous reader is told nothing about where to edit", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    expect((await readAnonymously(f, token)).editableInContext).toBeNull();
  });

  test("nor is a signed-in stranger, who is not in this context at all", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    const result = await asUser(f.t, f.lk).action(
      api.functions.shares.readSharedNote,
      { token },
    );
    expect(result.editableInContext).toBeNull();
  });

  /**
   * `member` is deliberately not enough. The console is read-only for that
   * role too, so a route offered to them would lead to the same document
   * behind the same glass — a button that goes nowhere useful is worse than
   * no button.
   */
  test("nor a member, for whom the console is read-only too", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    const result = await asUser(f.t, f.member).action(
      api.functions.shares.readSharedNote,
      { token },
    );
    expect(result.editableInContext).toBeNull();
  });

  test("the owner opening their own link is sent to their console", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    const result = await asUser(f.t, f.owner).action(
      api.functions.shares.readSharedNote,
      { token },
    );
    expect(result.editableInContext).toBe("atlas");
  });

  /**
   * Live rather than stored. A route offered on the strength of a role
   * somebody used to have is a button that leads to a refusal — and the
   * direction it must fail is towards no button.
   */
  test("and it goes away the moment that membership does", async () => {
    const f = await fixture();
    const token = await unlisted(f);
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceMembers")
        .filter((q) => q.eq(q.field("userId"), f.member))
        .unique();
      await ctx.db.patch(row!._id, { role: "editor" as const });
    });

    const asEditor = await asUser(f.t, f.member).action(
      api.functions.shares.readSharedNote,
      { token },
    );
    expect(asEditor.editableInContext).toBe("atlas");

    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceMembers")
        .filter((q) => q.eq(q.field("userId"), f.member))
        .unique();
      await ctx.db.delete(row!._id);
    });

    const afterRemoval = await asUser(f.t, f.member).action(
      api.functions.shares.readSharedNote,
      { token },
    );
    expect(afterRemoval.editableInContext).toBeNull();
  });
});

describe("what an unlisted link unfurls as", () => {
  /**
   * The card is the same feature it always was — an owner-chosen title derived
   * from the path, never read from the note — and it works here for the same
   * reason it works for a personal share: `previewTitleForToken` looks at
   * liveness and the title switch, and has never cared which kind of share it
   * is.
   */
  test("a live unlisted link unfurls with its title", async () => {
    const f = await fixture();
    const token = await unlisted(f);

    expect(
      await f.t.query(api.functions.shares.previewTitleForToken, { token }),
    ).toEqual({ title: "Overview", openToAnyone: true });
  });

  /**
   * The one field the card needed that it did not have. Without it the
   * description reads "Sign in to read it" at somebody who needs no account,
   * which is the product being wrong on the first surface a stranger sees.
   */
  test("and says a reader needs no account, where every other kind does not", async () => {
    const f = await fixture();
    const open = await unlisted(f, LINKED);
    const { token: personal } = await asUser(f.t, f.owner).mutation(
      api.functions.shares.createShare,
      { workspaceId: f.workspaceId, path: ENTRY, recipient: "@lk" },
    );

    const openCard = await f.t.query(api.functions.shares.previewTitleForToken, {
      token: open,
    });
    const personalCard = await f.t.query(api.functions.shares.previewTitleForToken, {
      token: personal,
    });
    expect(openCard.openToAnyone).toBe(true);
    expect(personalCard.openToAnyone).toBe(false);
  });

  /**
   * And a revoked one is byte-identical to a token nobody minted — over the
   * whole tuple, not just its first field. A crawler that could tell "revoked,
   * and it used to be open" from "never existed" has learned two things about
   * a context it is not in.
   */
  test("a revoked unlisted link is the same absence as one that never existed", async () => {
    const f = await fixture();
    const token = await unlisted(f);
    const [live] = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    await asUser(f.t, f.owner).mutation(api.functions.shares.revokeShare, {
      shareId: live!.shareId,
    });

    expect(
      await f.t.query(api.functions.shares.previewTitleForToken, { token }),
    ).toEqual(
      await f.t.query(api.functions.shares.previewTitleForToken, {
        token: "2".repeat(64),
      }),
    );
  });
});

describe("what the console needs to build the link", () => {
  /**
   * The mint returns the title it stored, so the slug in the copied URL and
   * the name on the card are the same string. A console deriving its own would
   * be a second copy of `titleFromPath` free to drift from the one that ran.
   */
  test("minting answers with the name the link is built from", async () => {
    const f = await fixture();
    const { token, title } = await asUser(f.t, f.owner).action(
      api.functions.shares.createLinkShare,
      { workspaceId: f.workspaceId, path: ENTRY },
    );

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(title).toBe("Overview");
  });

  /**
   * …and `null` when the owner has the preview title off. A URL survives more
   * forwards than a card does, so a setting that hides the name has to hide it
   * in the link too.
   */
  test("and with nothing, when the owner has the name switched off", async () => {
    const f = await fixture();
    const { title } = await asUser(f.t, f.owner).action(
      api.functions.shares.createLinkShare,
      { workspaceId: f.workspaceId, path: ENTRY, titleInPreview: false },
    );

    expect(title).toBeNull();
  });

  test("pressing it again returns the same token, so a link already sent stays live", async () => {
    const f = await fixture();
    const first = await asUser(f.t, f.owner).action(
      api.functions.shares.createLinkShare,
      { workspaceId: f.workspaceId, path: ENTRY },
    );
    const second = await asUser(f.t, f.owner).action(
      api.functions.shares.createLinkShare,
      { workspaceId: f.workspaceId, path: ENTRY },
    );

    expect(second).toEqual(first);
  });
});

describe("how the owner sees it", () => {
  test("the audience names the rule, because there is nobody to name", async () => {
    const f = await fixture();
    await unlisted(f);

    const [row] = await asUser(f.t, f.owner).query(api.functions.shares.listShares, {
      workspaceId: f.workspaceId,
    });
    expect(row!.recipient).toBe("Anyone with the link");
    expect(row!.audience).toBe("anyone");
  });
});
