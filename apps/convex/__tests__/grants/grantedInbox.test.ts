/**
 * What an outsider sees in Shared with me: the grants the live rows still name
 * for them, as `kind: "grant"` items beside the share items.
 *
 * The rule each test pins is in its name. The list is judged by the same
 * `outsiderGrantsFor` the read path uses, so a grant the read refuses is never
 * listed, and a grant the list shows is one the read will open.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - list grants without the `guestCanSee` filter: "a private subfolder" fails;
 *  - list grants for members too: "a member does not see the member's own grant" fails;
 *  - drop the dedupe against share items: "one row per note" fails;
 *  - trust the candidate row (no live re-derivation): "a revoked grant disappears" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

// Each test builds a whole workspace with a bucket and a copied tree, which takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });
import { api } from "../../_generated/api";
import { asUser, captureError, errorCode, readIntoTree, type TestConvex } from "../fixtures.helpers";
import {
  attachEmail,
  grantEmail,
  grantUser,
  noteIdOf,
  PLAN,
  revokeAll,
  SALARIES,
  SECRET,
  setListFor,
  world,
} from "./outsider.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface InboxRow {
  kind: "share" | "grant";
  workspaceId: string;
  entryPath: string;
  [key: string]: unknown;
}

type Who = Parameters<typeof asUser>[1];

async function inboxOf(t: TestConvex, who: Who): Promise<InboxRow[]> {
  return (await asUser(t, who).query(api.functions.shares.listSharedWithMe, {})) as unknown as InboxRow[];
}

function grantsOf(rows: InboxRow[]): InboxRow[] {
  return rows.filter((row) => row.kind === "grant");
}

describe("an outsider's Shared with me lists the grant she holds", () => {
  test("a granted note is listed as a grant item, with its workspace and its note id", async () => {
    const w = await world();
    // The note's heading is a fact the tree reads from its body, which a fresh copy has not yet done.
    await readIntoTree(w.t, w.ws);
    await grantUser(w, PLAN, w.kola);

    const rows = await inboxOf(w.t, w.kola);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "grant",
      workspaceId: w.ws,
      slug: "acme",
      displayName: "Acme",
      workspaceKind: "shared",
      entryPath: PLAN,
      itemKind: "file",
      noteId: await noteIdOf(w, PLAN),
      // The note's own heading, as the share items give it.
      title: "Plan",
      // Recorded by the owner who wrote the row.
      sharedBy: w.owner,
    });
  });

  test("a granted folder is listed as a folder grant item", async () => {
    const w = await world();
    await grantUser(w, "1-projects", w.kola);

    const rows = await inboxOf(w.t, w.kola);
    expect(rows).toMatchObject([{ kind: "grant", entryPath: "1-projects", itemKind: "folder" }]);
  });

  test("a grant made to a confirmed address is listed to the account that holds it", async () => {
    const w = await world();
    await attachEmail(w.t, w.kola, "kola.inbox@example.test");
    await grantEmail(w, PLAN, "kola.inbox@example.test");

    expect(grantsOf(await inboxOf(w.t, w.kola))).toMatchObject([{ entryPath: PLAN }]);
  });
});

describe("what is not listed", () => {
  test("a member does not see the member's own grant in this list", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.bob);

    expect(grantsOf(await inboxOf(w.t, w.bob))).toEqual([]);
  });

  test("a revoked grant disappears from the list", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.kola);
    expect(grantsOf(await inboxOf(w.t, w.kola))).toHaveLength(1);

    await revokeAll(w, PLAN);
    expect(grantsOf(await inboxOf(w.t, w.kola))).toEqual([]);
  });

  test("another person's grant is not listed to the caller", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.carol);

    expect(grantsOf(await inboxOf(w.t, w.kola))).toEqual([]);
    expect(grantsOf(await inboxOf(w.t, w.carol))).toMatchObject([{ entryPath: PLAN }]);
  });

  test("a private subfolder's note under a granted folder is not listed", async () => {
    const w = await world();
    // The folder is granted; its private subfolder is closed by its own row.
    await grantUser(w, "1-projects", w.kola);
    await setListFor(w, "1-projects/private", []);

    const rows = await inboxOf(w.t, w.kola);
    expect(rows.map((row) => row.entryPath)).toEqual(["1-projects"]);
    expect(rows.map((row) => row.entryPath)).not.toContain(SECRET);
  });

  test("a note in a workspace the caller holds no grant in is not listed", async () => {
    const w = await world();
    await grantUser(w, SALARIES, w.bob);

    expect(await inboxOf(w.t, w.kola)).toEqual([]);
  });
});

describe("one row per note", () => {
  test("a note both shared with the caller and granted to them is one row, the share", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.kola);
    await asUser(w.t, w.owner).mutation(api.functions.shares.createShare, {
      workspaceId: w.ws,
      path: PLAN,
      recipient: "kola@example.invalid",
    });

    const rows = await inboxOf(w.t, w.kola);
    const forPlan = rows.filter((row) => row.entryPath === PLAN);
    expect(forPlan).toHaveLength(1);
    expect(forPlan[0]!.kind).toBe("share");
  });
});

describe("signed out", () => {
  test("the list refuses a caller with no session, as it did before grants were listed", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.kola);

    const error = await captureError(() => w.t.query(api.functions.shares.listSharedWithMe, {}));
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });
});
