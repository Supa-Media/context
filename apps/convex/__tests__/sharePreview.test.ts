/**
 * THE SHARE LINK PREVIEW — the one unauthenticated surface in this product.
 *
 * `previewTitleForToken` takes no session. That is a deliberate exception to a
 * rule stated in capitals in `infra/router/og-card.source.html` and asserted
 * byte-for-byte across nine URL variants in the router's own suite: every
 * context.lc path unfurls one frozen card that says nothing about anybody.
 *
 * The exception is narrow and the tests below are what keep it narrow:
 *
 *  1. **A share token is not a guessable path.** `/@seyi` is guessable, which
 *     is why it stays frozen. A token is 32 CSPRNG bytes the owner handed to
 *     somebody. Nothing here may accept anything *but* a token.
 *  2. **One shape, always.** Unknown, revoked, expired, disabled, untitled —
 *     all `{ title: null }`. A crawler that could tell revoked from
 *     never-issued would report to a whole Slack channel that an owner acted.
 *  3. **The title never comes from the note.** It is owner-chosen or derived
 *     from the filename, so an unfurl never reads the customer's bucket and no
 *     note content enters the control plane.
 *  4. **Nothing else is ever returned.** The response has one field. A test
 *     asserts its exact key set, because the failure mode here is somebody
 *     adding "just the workspace name" and publishing it to the internet.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  MAX_PREVIEW_TITLE,
  normalizePreviewTitle,
  titleFromPath,
} from "../functions/lib/shareTitle";
import {
  asUser,
  createUser,
  createWorkspace,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

const NOTE = "1-projects/transition/implementation-handoff.md";

async function scenario(t: TestConvex) {
  const ownerId = await createUser(t, "owner@example.invalid");
  const lkId = await createUser(t, "lk@example.invalid");
  const workspaceId = await createWorkspace(t, ownerId, "owner-brain");
  await createWorkspace(t, lkId, "lk");
  return { ownerId, lkId, workspaceId };
}

async function shareWith(
  t: TestConvex,
  ownerId: Id<"users">,
  workspaceId: Id<"workspaces">,
  extra: { previewTitle?: string; titleInPreview?: boolean; path?: string } = {},
): Promise<string> {
  const { path, ...rest } = extra;
  const { token } = await asUser(t, ownerId).mutation(
    api.functions.shares.createShare,
    { workspaceId, path: path ?? NOTE, recipient: "@lk", ...rest },
  );
  return token;
}

/** The preview endpoint, called the way the router calls it: with no session. */
function preview(t: TestConvex, token: string) {
  return t.query(api.functions.shares.previewTitleForToken, { token });
}

describe("deriving a title from a path", () => {
  test("a filename becomes a sentence", () => {
    expect(titleFromPath("1-projects/transition/implementation-handoff.md")).toBe(
      "Implementation handoff",
    );
    expect(titleFromPath("overview.md")).toBe("Overview");
    expect(titleFromPath("2-areas/public_worship/org-chart.md")).toBe("Org chart");
  });

  test("a PARA-style numeric prefix on the filename is dropped", () => {
    expect(titleFromPath("1-projects/01-kickoff-notes.md")).toBe("Kickoff notes");
  });

  /**
   * Only the first letter. Title-casing every word turns `q3-budget-for-lk`
   * into something nobody wrote, and this string goes on a card with the
   * owner's name nowhere near it to explain the difference.
   */
  test("only the first letter is capitalised", () => {
    expect(titleFromPath("q3-budget-for-lk.md")).toBe("Q3 budget for lk");
  });

  test("a filing code is not a title", () => {
    expect(titleFromPath("0-inbox/2026-08-29.md")).toBeNull();
    expect(titleFromPath("1-projects/.md")).toBeNull();
  });

  test("a very long filename is bounded", () => {
    const long = `${"word-".repeat(60)}end.md`;
    expect(titleFromPath(long)!.length).toBeLessThanOrEqual(MAX_PREVIEW_TITLE);
  });
});

describe("normalising a title the owner typed", () => {
  test("whitespace collapses and the ends are trimmed", () => {
    expect(normalizePreviewTitle("  Chapter   transition  ")).toBe(
      "Chapter transition",
    );
  });

  /**
   * Control characters are stripped at the point of storage. They cannot break
   * the router's HTML — it escapes on the way out — but a newline in an
   * `og:title` renders differently across unfurlers, and fixing it once here
   * beats fixing it at every read.
   */
  test("control characters are stripped", () => {
    expect(normalizePreviewTitle("Chapter\u0000\ntransition\u007f")).toBe(
      "Chapter transition",
    );
  });

  test("a title that is only whitespace is no title", () => {
    expect(normalizePreviewTitle("   ")).toBeNull();
    expect(normalizePreviewTitle("")).toBeNull();
  });

  test("a long title is bounded", () => {
    expect(normalizePreviewTitle("x".repeat(500))!.length).toBe(MAX_PREVIEW_TITLE);
  });
});

describe("what an unauthenticated crawler is told", () => {
  test("a live share with a title unfurls with it", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await shareWith(t, ownerId, workspaceId);

    expect(await preview(t, token)).toEqual({ title: "Implementation handoff" });
  });

  test("the owner's own title wins over the filename", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await shareWith(t, ownerId, workspaceId, {
      previewTitle: "Chapter transition — for LK",
    });

    expect(await preview(t, token)).toEqual({ title: "Chapter transition — for LK" });
  });

  test("a title that normalises to nothing falls back to the filename", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await shareWith(t, ownerId, workspaceId, { previewTitle: "   " });

    expect(await preview(t, token)).toEqual({ title: "Implementation handoff" });
  });

  /**
   * The response has exactly one key. The failure this guards is somebody
   * adding "just the workspace name" for a nicer card and publishing it to
   * every crawler on the internet.
   */
  test("nothing but the title is ever returned", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await shareWith(t, ownerId, workspaceId);

    const result = await preview(t, token);
    expect(Object.keys(result)).toEqual(["title"]);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("owner-brain");
    expect(serialised).not.toContain("1-projects");
    expect(serialised).not.toContain("lk");
  });
});

describe("every absence is the same absence", () => {
  test("an unknown token", async () => {
    const t = setupTest();
    await scenario(t);
    expect(await preview(t, "a-token-that-was-never-issued")).toEqual({ title: null });
  });

  test("an empty token", async () => {
    const t = setupTest();
    await scenario(t);
    expect(await preview(t, "")).toEqual({ title: null });
  });

  test("a revoked share is indistinguishable from one that never existed", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await shareWith(t, ownerId, workspaceId);
    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    expect(await preview(t, token)).toEqual(await preview(t, "never-issued"));
  });

  test("an expired share", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await shareWith(t, ownerId, workspaceId);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });

    expect(await preview(t, token)).toEqual({ title: null });
  });

  test("a share whose owner turned the title off", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await shareWith(t, ownerId, workspaceId, { titleInPreview: false });

    expect(await preview(t, token)).toEqual({ title: null });
  });

  test("a share over a note whose filename yields no title", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await shareWith(t, ownerId, workspaceId, {
      path: "0-inbox/2026-08-29.md",
    });

    expect(await preview(t, token)).toEqual({ title: null });
  });
});

describe("the title never comes from the note", () => {
  /**
   * There is no bucket in this test at all — no binding, no storage stub. If
   * the preview path ever started reading note contents, it could not answer
   * here, and this test would fail rather than quietly adding an anonymous GET
   * against every customer's bucket on every Slack unfurl.
   */
  test("a preview resolves with no storage connected whatsoever", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await shareWith(t, ownerId, workspaceId);

    const bindings = await t.run((ctx) => ctx.db.query("storageBindings").collect());
    expect(bindings).toHaveLength(0);
    expect(await preview(t, token)).toEqual({ title: "Implementation handoff" });
  });
});
