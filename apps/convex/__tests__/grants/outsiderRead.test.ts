/**
 * An outsider reads exactly what was granted, read-only, and nothing else.
 *
 * `outsiderRead.test.ts` drives the real actions (`shares.readGrantedNote`,
 * `shares.listGrantedFolder`) against the real credential barrier and a bucket
 * stub, so a passing test means the note text really came back, and a failing
 * one means it really did not. The rule each test pins is in its name.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - trust the candidate grant row instead of re-deriving the caller's names
 *    from the live rows (`outsiderGrantsFor`): "a grant the live rows no
 *    longer name is not listed" fails;
 *  - drop the per-path `canSee` in `authorizeGrantRead`: "a private subfolder"
 *    and "a note held back by name" fail;
 *  - drop the per-entry `visibleGrantedPaths` filter from `listGrantedFolder`:
 *    "the listing leaves out a private subfolder" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import type { QueryCtx } from "../../_generated/server";
import { outsiderGrantsFor } from "../../functions/lib/grants/outsider";
import { grantedNamesFor } from "../../functions/lib/grantedNames";
import { asUser, captureError, errorCode } from "../fixtures.helpers";
import {
  attachEmail,
  setBase,
  TEAM_NOTE,
  grantEmail,
  grantUser,
  GONE,
  GONE_MARKER,
  HELD,
  listByPath,
  noteIdOf,
  PLAN,
  PLAN_MARKER,
  readByNoteId,
  readByPath,
  refusalOf,
  revokeAll,
  SALARIES,
  SALARIES_MARKER,
  SECRET,
  SECRET_MARKER,
  setListFor,
  trashNote,
  unverifiedUser,
  world,
  type World,
} from "./outsider.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const SHARE_UNAVAILABLE = "SHARE_UNAVAILABLE";

/** Every refusal an outsider can get, in one place, so a test can say "refused" and mean one thing. */
async function expectRefused(promise: Promise<unknown>): Promise<string> {
  const error = await captureError(() => promise);
  expect(errorCode(error)).toBe(SHARE_UNAVAILABLE);
  return refusalOf(error);
}

describe("an outsider granted a note by account reads it", () => {
  test("a non-member with an account grant reads the granted note, and only that", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.kola);

    const result = await readByNoteId(w, w.kola, await noteIdOf(w, PLAN));
    expect(result.path).toBe(PLAN);
    expect(result.text).toContain(PLAN_MARKER);

    // The grant reaches the note and nothing beside it: the same folder's other notes are refused.
    await expectRefused(readByPath(w, w.kola, HELD));
  });

  test("the grant is not membership: the outsider still reads through no member path", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.kola);
    // The member-only path never names an outsider, so their workspace list is still empty.
    const names = await w.t.run(async (ctx) => await grantedNamesFor(ctx as unknown as QueryCtx, w.ws, w.kola));
    expect(names).toEqual([]);
  });
});

describe("an outsider granted by a confirmed email reads it", () => {
  test("an added, confirmed sign-in address reads the note", async () => {
    const w = await world();
    await attachEmail(w.t, w.kola, "kola.work@example.test");
    await grantEmail(w, PLAN, "  Kola.Work@Example.TEST ");

    const result = await readByNoteId(w, w.kola, await noteIdOf(w, PLAN));
    expect(result.text).toContain(PLAN_MARKER);
  });

  test("an unverified address reads nothing, even when the owner named it", async () => {
    const w = await world();
    // An account whose only address is one nobody proved they read.
    const pending = await unverifiedUser(w.t, "pending.person@example.test");
    await grantEmail(w, PLAN, "pending.person@example.test");

    await expectRefused(readByNoteId(w, pending, await noteIdOf(w, PLAN)));
  });

  test("an address two accounts hold reads nothing, for either of them", async () => {
    const w = await world();
    // Kola added it as a sign-in address; carol's own account already holds it.
    await attachEmail(w.t, w.kola, "shared.inbox@example.test");
    const carolWithShared = await w.t.run((ctx) =>
      ctx.db.insert("users", { email: "shared.inbox@example.test", emailVerificationTime: Date.now(), createdAt: Date.now() }),
    );
    await grantEmail(w, PLAN, "shared.inbox@example.test");

    const noteId = await noteIdOf(w, PLAN);
    await expectRefused(readByNoteId(w, w.kola, noteId));
    await expectRefused(readByNoteId(w, carolWithShared, noteId));
  });
});

describe("a grant ends when it is taken back", () => {
  test("revoking the grant ends the outsider's read", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.kola);
    const noteId = await noteIdOf(w, PLAN);
    expect((await readByNoteId(w, w.kola, noteId)).text).toContain(PLAN_MARKER);

    await revokeAll(w, PLAN);
    await expectRefused(readByNoteId(w, w.kola, noteId));
  });
});

describe("every refusal is the one answer", () => {
  test("a trashed granted note is refused", async () => {
    const w = await world();
    await grantUser(w, GONE, w.kola);
    const noteId = await noteIdOf(w, GONE);
    expect((await readByNoteId(w, w.kola, noteId)).text).toContain(GONE_MARKER);

    await trashNote(w, GONE);
    await expectRefused(readByNoteId(w, w.kola, noteId));
    await expectRefused(readByPath(w, w.kola, GONE));
  });

  test("exists-not-granted, not-exists, trashed, other-workspace and malformed all answer byte-identically", async () => {
    const w = await world();
    await grantUser(w, GONE, w.kola);
    await trashNote(w, GONE);
    // The other workspace's note is granted to the same person, in a context they are not a member of here.
    await grantUser(w, PLAN, w.kola, w.beta);
    const elsewhere = await noteIdOf(w, PLAN, w.beta);

    const refusals = [
      await expectRefused(readByPath(w, w.kola, SALARIES)), // exists, not granted
      await expectRefused(readByPath(w, w.kola, "1-projects/does-not-exist.md")), // not there at all
      await expectRefused(readByNoteId(w, w.kola, "0190f2c0-0000-7000-8000-000000000000")), // no such id
      await expectRefused(readByPath(w, w.kola, GONE)), // trashed
      await expectRefused(readByNoteId(w, w.kola, elsewhere)), // granted, in another workspace
      await expectRefused(readByPath(w, w.kola, "1-projects/../../etc/passwd.md")), // malformed
    ];
    expect(new Set(refusals).size).toBe(1);
    expect(refusals[0]).toContain(SHARE_UNAVAILABLE);
    // The note that exists but is not granted is not readable, and its text never came back.
    expect(refusals.join("")).not.toContain(SALARIES_MARKER);
  });

  test("a signed-out caller gets the sign-in answer, the same for every target", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.kola);
    const a = await captureError(() => w.t.action(api.functions.shares.readGrantedNote, { workspaceId: w.ws, path: PLAN }));
    const b = await captureError(() => w.t.action(api.functions.shares.readGrantedNote, { workspaceId: w.ws, path: SALARIES }));
    expect(errorCode(a)).toBe("NOT_AUTHENTICATED");
    expect(refusalOf(a)).toBe(refusalOf(b));
  });
});

describe("a folder grant reaches its subtree, and nothing the subtree holds back", () => {
  async function folderWorld(): Promise<World> {
    const w = await world();
    // The folder is granted; its private subfolder and its held-back note are each closed by their own row.
    await grantUser(w, "1-projects", w.kola);
    await setListFor(w, "1-projects/private", []);
    await setListFor(w, HELD, []);
    return w;
  }

  test("reads a note under the granted folder", async () => {
    const w = await folderWorld();
    expect((await readByPath(w, w.kola, PLAN)).text).toContain(PLAN_MARKER);
  });

  test("a private subfolder's note is refused, though its folder is inside the grant", async () => {
    const w = await folderWorld();
    await expectRefused(readByPath(w, w.kola, SECRET));
  });

  test("a note held back by name inside the granted folder is refused", async () => {
    const w = await folderWorld();
    await expectRefused(readByPath(w, w.kola, HELD));
  });

  test("the listing shows what is granted and leaves out the private subfolder and the held-back note", async () => {
    const w = await folderWorld();
    const listing = await listByPath(w, w.kola, "1-projects");
    const names = listing.entries.map((entry) => entry.name).sort();
    // `gone.md` and `team-note.md` sit under the granted folder and no row holds them back, so the grant reaches them too.
    expect(names).toEqual(["gone.md", "plan.md", "team-note.md"]);
    // The subfolder is listed to no one outside it, and its own listing is refused too.
    await expectRefused(listByPath(w, w.kola, "1-projects/private"));
  });

  test("a note the members can see is not opened to an outsider by a folder grant", async () => {
    // The engine's own rendering for members would open this one (`team` base). Only the guest rendering refuses it.
    const w = await folderWorld();
    await setBase(w, TEAM_NOTE, "team");
    await expectRefused(readByPath(w, w.kola, TEAM_NOTE));
    const listing = await listByPath(w, w.kola, "1-projects");
    expect(listing.entries.map((entry) => entry.name)).not.toContain("team-note.md");
    // And a member still reads it, through the member path, which is unchanged.
    const member = await asUser(w.t, w.bob).query(api.functions.nodesListing.listFolder, { workspaceId: w.ws, path: "1-projects" });
    expect((member?.entries ?? []).map((entry) => entry.path)).toContain(TEAM_NOTE);
  });

  test("a folder grant does not reach the folder's neighbour", async () => {
    const w = await folderWorld();
    await expectRefused(readByPath(w, w.kola, SALARIES));
  });
});

describe("a grant in another workspace gives nothing here", () => {
  test("a grant in globex reaches no note of acme, by path or by id", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.kola, w.beta);

    // acme's own plan is not granted to kola at all.
    await expectRefused(readByPath(w, w.kola, PLAN));
    // globex's grant id, presented to acme, names no row in acme.
    await expectRefused(readByNoteId(w, w.kola, await noteIdOf(w, PLAN, w.beta)));
    // And outsiderGrantsFor lists the globex grant under globex only.
    const grants = await w.t.run((ctx) => outsiderGrantsFor(ctx as unknown as QueryCtx, w.kola));
    expect(grants.map((grant) => grant.workspaceId)).toEqual([w.beta]);
  });
});

describe("the candidate row is never trusted on its own", () => {
  test("a grant row the live rows do not name lists and reads nothing", async () => {
    const w = await world();
    // A real grant gives the rows a snapshot to be judged by.
    await grantUser(w, SALARIES, w.bob);
    // Then a grant row is written straight into the table, past the derivation that keeps the snapshot.
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws).eq("path", PLAN))
        .unique();
      if (row === null) throw new Error("no plan row");
      await ctx.db.insert("nodeAccess", {
        workspaceId: w.ws,
        nodeId: row._id,
        granteeKind: "user",
        granteeUserId: w.kola,
        role: "view",
        grantedBy: w.owner,
        at: Date.now(),
        source: "owner",
      });
    });

    const grants = await w.t.run((ctx) => outsiderGrantsFor(ctx as unknown as QueryCtx, w.kola));
    expect(grants).toEqual([]);
    await expectRefused(readByPath(w, w.kola, PLAN));
  });
});

describe("a member is not an outsider", () => {
  test("a member's grant is not listed as an outsider grant, and the member read is refused here", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.bob);

    const grants = await w.t.run((ctx) => outsiderGrantsFor(ctx as unknown as QueryCtx, w.bob));
    expect(grants).toEqual([]);
    // The member keeps the grant through grantedNamesFor, which is unchanged.
    const names = await w.t.run((ctx) => grantedNamesFor(ctx as unknown as QueryCtx, w.ws, w.bob));
    expect(names).toContain(`#${await noteIdOf(w, PLAN)}`);
    await expectRefused(readByNoteId(w, w.bob, await noteIdOf(w, PLAN)));
  });
});

describe("what an outsider is listed as holding", () => {
  test("a trashed granted note is not listed", async () => {
    const w = await world();
    await grantUser(w, GONE, w.kola);
    await grantUser(w, PLAN, w.kola);
    await trashNote(w, GONE);

    const grants = await w.t.run((ctx) => outsiderGrantsFor(ctx as unknown as QueryCtx, w.kola));
    expect(grants.map((grant) => grant.path)).toEqual([PLAN]);
  });

  test("the outsider's list and the outsider's read name the same grant", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.kola);
    const grants = await w.t.run((ctx) => outsiderGrantsFor(ctx as unknown as QueryCtx, w.kola));
    expect(grants).toMatchObject([{ workspaceId: w.ws, path: PLAN, kind: "file" }]);
  });
});
