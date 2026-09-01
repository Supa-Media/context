/**
 * WHAT A FOLDER LINK SAYS IS INSIDE IT.
 *
 * A team link to a folder unfurled with one word — its own name — and a card
 * that says one word is barely better than the bare branding it replaced. It
 * now names two or three of the things inside, and that is the most sensitive
 * field this product has ever published: **the names of somebody's notes, to an
 * anonymous crawler, at an address anybody can type.**
 *
 * Four properties carry it, and each one is a test below rather than a comment:
 *
 *  1. **Only what a `team` reader may see.** The list comes out of `listFolder`
 *     at `team` scope — the same privacy engine the console and the gateway
 *     read through — so a private note and a private subfolder are gone before
 *     `previewChildrenFrom` is called at all. There is no second predicate here
 *     to disagree with the first.
 *  2. **Nothing counts what was dropped.** Three names, and no `+N more`. A
 *     total over the folder rather than over the visible set is an existence
 *     oracle by subtraction — the same one the console's note census is
 *     owner-only to prevent.
 *  3. **A filename is not a safe string.** These are keys out of a bucket we do
 *     not own, written by Obsidian, by rclone, or by the provider's own web
 *     console. Control characters go, length is bounded, and the count is
 *     bounded — here, and again at the edge.
 *  4. **Deterministic.** This list feeds the card image's cache key, and the
 *     Workers cache has no global purge, so the same folder must produce the
 *     same order or a re-render re-publishes an identical picture under a new
 *     URL.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3 } from "./storeStub.helpers";
import { PARA_FOLDERS } from "../functions/lib/scaffold";
import {
  FAKE_STORAGE,
  asUser,
  createUser,
  createWorkspace,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import {
  listFolder,
  setFolderVisibility,
  setVisibility,
  type FileStore,
} from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import {
  MAX_PREVIEW_CHILDREN,
  MAX_PREVIEW_CHILD_NAME,
  boundPreviewChildren,
  normalizePreviewChild,
  previewChildrenFrom,
} from "../functions/lib/shareTitle";

/** Characters a filename can carry that a card must never. */
const ESC = String.fromCharCode(27);
const NEWLINE = String.fromCharCode(10);

/**
 * A bucket with one owner-named folder in it, shared with the team, holding a
 * subfolder, two team notes and one the owner will hold back.
 */
async function bucket(): Promise<MemoryStore & FileStore> {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/README.md", "# Projects\n");
  store.seed("1-projects/transition/overview.md", "# Overview\n");
  store.seed("1-projects/transition/timeline.md", "# Timeline\n");
  store.seed("1-projects/transition/salaries.md", "# Salaries\n");
  store.seed("1-projects/transition/interviews/first.md", "# First\n");
  await setFolderVisibility(store, {
    path: "1-projects",
    visibility: "team",
    scope: "private",
  });
  return store;
}

/** What a folder link over `path` would carry, taken the way the product takes it. */
async function childrenOf(store: FileStore, path: string): Promise<string[]> {
  const listing = await listFolder(store, { path, scope: "team" });
  return previewChildrenFrom(listing.entries);
}

describe("only what a team reader may see", () => {
  test("a folder's team-visible notes and subfolders", async () => {
    const store = await bucket();
    // Folders first, then names ascending — three of the four, because three is
    // what a card holds.
    expect(await childrenOf(store, "1-projects/transition")).toEqual([
      "interviews/",
      "overview.md",
      "salaries.md",
    ]);
  });

  /**
   * **THE test.** The owner holds one note back and the card must stop naming
   * it — not because of a second filter written here, but because `listFolder`
   * at `team` scope never returns it. Sabotaging that scope to `private` is
   * what proves this is load-bearing rather than incidental.
   */
  test("a note the owner made private is not on the card", async () => {
    const store = await bucket();
    await setVisibility(store, {
      path: "1-projects/transition/salaries.md",
      visibility: "private",
      scope: "private",
    });

    const children = await childrenOf(store, "1-projects/transition");
    expect(children).not.toContain("salaries.md");
    expect(children).toEqual(["interviews/", "overview.md", "timeline.md"]);
  });

  test("a subfolder the owner made private is not on the card either", async () => {
    const store = await bucket();
    await setFolderVisibility(store, {
      path: "1-projects/transition/interviews",
      visibility: "private",
      scope: "private",
    });

    const children = await childrenOf(store, "1-projects/transition");
    expect(children).not.toContain("interviews/");
    expect(children).toEqual(["overview.md", "salaries.md", "timeline.md"]);
  });

  /**
   * A folder the owner never shared has nothing on its card, and that is the
   * same answer an empty folder gives. `listFolder` withholds it as an empty
   * listing rather than a refusal — the collapse that file argues for at
   * length — and this inherits it rather than restating it.
   */
  test("a private folder names nothing", async () => {
    const store = await bucket();
    store.seed("2-areas/private-thing/secret.md", "# Secret\n");
    expect(await childrenOf(store, "2-areas/private-thing")).toEqual([]);
  });

  test("a folder with nothing team-visible left names nothing", async () => {
    const store = await bucket();
    for (const path of [
      "1-projects/transition/overview.md",
      "1-projects/transition/timeline.md",
      "1-projects/transition/salaries.md",
    ]) {
      await setVisibility(store, { path, visibility: "private", scope: "private" });
    }
    await setFolderVisibility(store, {
      path: "1-projects/transition/interviews",
      visibility: "private",
      scope: "private",
    });

    expect(await childrenOf(store, "1-projects/transition")).toEqual([]);
  });

  /**
   * `.history/` holds every revision of every note the owner has ever written,
   * private ones included. It is never listed at any scope, so it can never
   * reach a card — asserted here because the consequence of it doing so is a
   * picture of somebody's filing cabinet.
   */
  test("plumbing never reaches a card", async () => {
    const store = await bucket();
    store.seed(".history/1-projects/transition/salaries.md.old.md", "# older\n");
    expect(await childrenOf(store, "")).not.toContain(".history/");
  });

  /** A note is not a folder, so a link to one names nothing inside it. */
  test("a note has no children", async () => {
    const store = await bucket();
    expect(await childrenOf(store, "1-projects/transition/overview.md")).toEqual([]);
  });
});

describe("the bounds, which are applied here and again at the edge", () => {
  test("at most three, however many are visible", () => {
    expect(
      previewChildrenFrom(
        ["a.md", "b.md", "c.md", "d.md", "e.md"].map((name) => ({
          kind: "file" as const,
          name,
        })),
      ),
    ).toHaveLength(MAX_PREVIEW_CHILDREN);
  });

  test("a long name is truncated rather than dropped", () => {
    const long = `${"x".repeat(200)}.md`;
    const [only] = previewChildrenFrom([{ kind: "file", name: long }]);
    expect(only).toHaveLength(MAX_PREVIEW_CHILD_NAME);
  });

  /**
   * A filename is a key out of a bucket we do not own. A newline in one lands
   * inside an `og:description`, where escaping has nothing to escape it *to*
   * and every unfurler renders it differently — so it is stripped where the
   * value is taken, the way `normalizePreviewTitle` strips one.
   */
  test("control characters are stripped, not escaped", () => {
    const hostile = `over${NEWLINE}view${ESC}notes.md`;
    const [only] = previewChildrenFrom([{ kind: "file", name: hostile }]);
    expect(only).toBe("over view notes.md");
    expect(only).not.toMatch(/\p{Cc}/u);
  });

  test("a name that is only control characters is dropped, not blanked", () => {
    expect(normalizePreviewChild("   ")).toBeNull();
    expect(previewChildrenFrom([{ kind: "file", name: NEWLINE + NEWLINE }])).toEqual([]);
  });

  test("the bound is re-applied to a stored list, never trusted", () => {
    // What a row written by an older deployment, or by a wider listing, holds.
    expect(boundPreviewChildren(["a", "b", "c", "d"])).toEqual(["a", "b", "c"]);
    expect(boundPreviewChildren(["y".repeat(99)])[0]).toHaveLength(
      MAX_PREVIEW_CHILD_NAME,
    );
  });
});

describe("deterministic, because it is a cache key", () => {
  test("folders come first, then names ascending", () => {
    expect(
      previewChildrenFrom([
        { kind: "file", name: "b.md" },
        { kind: "folder", name: "zed" },
        { kind: "file", name: "a.md" },
      ]),
    ).toEqual(["zed/", "a.md", "b.md"]);
  });

  test("the same folder in a different listing order is the same list", () => {
    const entries = [
      { kind: "file" as const, name: "b.md" },
      { kind: "folder" as const, name: "zed" },
      { kind: "file" as const, name: "a.md" },
    ];
    expect(previewChildrenFrom(entries)).toEqual(
      previewChildrenFrom([...entries].reverse()),
    );
  });

  /**
   * A folder keeps its slash. That is how the card says which of the three
   * names is a folder without a second field travelling beside them — one
   * field, so the two halves cannot disagree, which is the rule `recipientKind`
   * follows on the same table.
   */
  test("a folder child is marked by its own name, not by a second field", () => {
    expect(previewChildrenFrom([{ kind: "folder", name: "interviews" }])).toEqual([
      "interviews/",
    ]);
    expect(previewChildrenFrom([{ kind: "file", name: "interviews" }])).toEqual([
      "interviews",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* End to end: a real bucket, the real row, the real unauthenticated query      */
/* -------------------------------------------------------------------------- */

/**
 * The block above proves the derivation. This one proves the **wiring**, and
 * the wiring is where the security question actually lives: `snapshotChildren`
 * chooses the scope it lists at, and a `private` there would put the owner's
 * own hidden notes on a card served to an anonymous crawler. Nothing in the
 * block above would notice, because it names the scope itself.
 *
 * So the whole path runs: the real `S3Store` doing real SigV4 against a `fetch`
 * stub speaking S3, the real envelope opened by the real `decryptSecret`, the
 * real privacy manifest, the real row, and the real `previewForNote` — called
 * the way the router calls it, with no session.
 *
 * The card render itself throws (there is no wasm installed in this suite) and
 * is swallowed, which is the point of taking the listing *before* it: an
 * undrawable card must not cost the link its description.
 */
describe("end to end, from the bucket to the unauthenticated preview", () => {
  const FOLDER = "1-projects/transition";

  async function fixture() {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "owner-brain");

    const backend = memoryS3(FAKE_STORAGE.bucket);
    backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
    backend.seed("index.md", "# Context\n");
    backend.seed("1-projects/README.md", "# Projects\n");
    backend.seed(`${FOLDER}/overview.md`, "# Overview\n");
    backend.seed(`${FOLDER}/timeline.md`, "# Timeline\n");
    backend.seed(`${FOLDER}/salaries.md`, "# Salaries\n");
    backend.seed(`${FOLDER}/interviews/first.md`, "# First\n");
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
    return { t, owner, workspaceId };
  }

  /** Team-link `path`, then run the render the mutation scheduled. */
  async function linkAndRender(
    t: TestConvex,
    owner: Id<"users">,
    workspaceId: Id<"workspaces">,
    path: string,
  ): Promise<string> {
    const { token } = await asUser(t, owner).mutation(
      api.functions.shares.createTeamShare,
      { workspaceId, path },
    );
    const row = await t.run((ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    await t.action(internal.functions.shareCard.renderShareCard, { shareId: row!._id });
    return token;
  }

  /** Share `1-projects`, so a `team` reader has anything to see at all. */
  async function shareProjects(t: TestConvex, owner: Id<"users">, workspaceId: Id<"workspaces">) {
    await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId,
      path: "1-projects",
      visibility: "team",
    });
  }

  test("a linked folder unfurls with its name and what is inside it", async () => {
    const { t, owner, workspaceId } = await fixture();
    await shareProjects(t, owner, workspaceId);
    const token = await linkAndRender(t, owner, workspaceId, FOLDER);

    expect(
      await t.query(api.functions.shares.previewForNote, {
        slug: "owner-brain",
        path: FOLDER,
      }),
    ).toEqual({
      title: "Transition",
      cardToken: token,
      children: ["interviews/", "overview.md", "salaries.md"],
    });
  });

  /**
   * **THE wiring test.** `snapshotChildren` lists at `team`, and it is the only
   * thing standing between a private note and an anonymous crawler. Sabotage
   * that scope to `private` and this is what fails.
   */
  test("a private note in a shared folder never reaches the card", async () => {
    const { t, owner, workspaceId } = await fixture();
    await shareProjects(t, owner, workspaceId);
    await asUser(t, owner).action(api.functions.files.setNoteVisibility, {
      workspaceId,
      path: `${FOLDER}/salaries.md`,
      visibility: "private",
    });
    await linkAndRender(t, owner, workspaceId, FOLDER);

    const answer = await t.query(api.functions.shares.previewForNote, {
      slug: "owner-brain",
      path: FOLDER,
    });
    expect(answer.children).not.toContain("salaries.md");
    expect(answer.children).toEqual(["interviews/", "overview.md", "timeline.md"]);
  });

  /**
   * A folder nobody shared is a folder with nothing on its card. The link still
   * works for a member — reading is authorised by membership on every request —
   * but describing it to a crawler is the separate question, and the answer is
   * the same absence a note gets.
   */
  test("a folder the owner never shared names nothing", async () => {
    const { t, owner, workspaceId } = await fixture();
    await linkAndRender(t, owner, workspaceId, FOLDER);

    expect(
      (
        await t.query(api.functions.shares.previewForNote, {
          slug: "owner-brain",
          path: FOLDER,
        })
      ).children,
    ).toEqual([]);
  });

  /**
   * **Revocation still takes everything back at once.** The children are on the
   * same row as the title, behind the same `isLive` check, so a revoked link is
   * byte-identical to one that never existed — no "the folder is gone but here
   * is what was in it".
   */
  test("revoking takes the contents back with the title", async () => {
    const { t, owner, workspaceId } = await fixture();
    await shareProjects(t, owner, workspaceId);
    await linkAndRender(t, owner, workspaceId, FOLDER);

    const listed = await asUser(t, owner).query(api.functions.shares.listShares, {
      workspaceId,
    });
    await asUser(t, owner).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    expect(
      await t.query(api.functions.shares.previewForNote, {
        slug: "owner-brain",
        path: FOLDER,
      }),
    ).toEqual({ title: null, cardToken: null, children: [] });
  });

  /**
   * **The half of the rule that did not move.** `3-resources` is a name this
   * product wrote into every brain it scaffolds, so it is a handful of guesses
   * per handle rather than a name its owner chose — and naming what is inside
   * it would turn that handful of guesses into a listing of somebody's notes.
   * `isProductMandatedPath` refuses it before any of this runs, contents and
   * all, exactly as it did before folders could carry contents.
   */
  test.each([...PARA_FOLDERS])(
    "%s is refused with its contents, not just its name",
    async (folder) => {
      const { t, owner, workspaceId } = await fixture();
      await shareProjects(t, owner, workspaceId);
      await linkAndRender(t, owner, workspaceId, folder);

      expect(
        await t.query(api.functions.shares.previewForNote, {
          slug: "owner-brain",
          path: folder,
        }),
      ).toEqual({ title: null, cardToken: null, children: [] });
    },
  );

  /**
   * **A personal share never spends a listing**, and the row is where that
   * absence has to be. Only a team link is reachable by `previewForNote` — the
   * one place these names are ever published — so listing a bucket for a
   * personal share would be a round trip against the customer's quota for
   * something nothing will ever read.
   *
   * The row is patched to `name` rather than created that way, because
   * `checkSharePath` refuses a personal share over anything but a `.md` path,
   * and a `.md` path is short-circuited one line earlier. Creating the case
   * through the API therefore cannot reach this guard at all — measured:
   * deleting the `teamLink` line leaves that version of this test green, which
   * is a guard nobody has checked. This one fails.
   */
  test("a personal share never spends a listing", async () => {
    const { t, owner, workspaceId } = await fixture();
    await shareProjects(t, owner, workspaceId);
    const { token } = await asUser(t, owner).mutation(
      api.functions.shares.createTeamShare,
      { workspaceId, path: FOLDER },
    );
    const row = await t.run((ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    await t.run((ctx) =>
      ctx.db.patch(row!._id, { recipientKind: "name" as const, recipient: "lk" }),
    );
    await t.action(internal.functions.shareCard.renderShareCard, { shareId: row!._id });

    expect((await t.run((ctx) => ctx.db.get(row!._id)))?.previewChildren).toBeUndefined();
  });

  /** A note cannot have children, so a team link to one does not go looking. */
  test("a team link to a note stores no contents either", async () => {
    const { t, owner, workspaceId } = await fixture();
    await shareProjects(t, owner, workspaceId);
    const token = await linkAndRender(t, owner, workspaceId, `${FOLDER}/overview.md`);
    const row = await t.run((ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    expect(row?.previewChildren).toBeUndefined();
  });

  /**
   * **The bound is re-applied where the row is read, not trusted from where it
   * was written.**
   *
   * Nothing in the product writes a row like this one — but a row written by an
   * older deployment, or by a listing that ran before a bound was tightened,
   * would look exactly like it, and this is the last code that touches those
   * names before they are served to an anonymous reader. The title is bounded
   * twice for the same reason and the router bounds both a third time.
   */
  test("an over-long stored list is bounded again on the way out", async () => {
    const { t, owner, workspaceId } = await fixture();
    await shareProjects(t, owner, workspaceId);
    const token = await linkAndRender(t, owner, workspaceId, FOLDER);
    const row = await t.run((ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    await t.run((ctx) =>
      ctx.db.patch(row!._id, {
        previewChildren: ["a.md", "b.md", "c.md", "d.md", `${"x".repeat(200)}.md`],
      }),
    );

    const { children } = await t.query(api.functions.shares.previewForNote, {
      slug: "owner-brain",
      path: FOLDER,
    });
    expect(children).toEqual(["a.md", "b.md", "c.md"]);
  });

  /**
   * **Absent is not empty.** A listing that fails knows nothing, and clearing
   * on it would let one bad afternoon quietly strip the contents off every
   * folder link in the context — the rule `recordVerification` follows for the
   * note census one layer up. A listing that *succeeds with nothing visible* is
   * an answer and does clear, which the private-folder case above covers.
   */
  test("a bucket that will not answer leaves what is stored standing", async () => {
    const { t, owner, workspaceId } = await fixture();
    await shareProjects(t, owner, workspaceId);
    const token = await linkAndRender(t, owner, workspaceId, FOLDER);
    const row = await t.run((ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    expect(row?.previewChildren).toHaveLength(3);

    vi.stubGlobal("fetch", () => Promise.reject(new Error("the bucket is down")));
    await t.action(internal.functions.shareCard.renderShareCard, { shareId: row!._id });

    expect((await t.run((ctx) => ctx.db.get(row!._id)))?.previewChildren).toEqual(
      row?.previewChildren,
    );
  });
});
