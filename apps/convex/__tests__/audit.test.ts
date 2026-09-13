/**
 * The audit trail's arguments.
 *
 * `isolation.test.ts` covers who may read a trail. This covers the one
 * argument a caller controls, which used to be trusted further than it had
 * earned.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { scopeForRole } from "../functions/files";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

async function workspaceWithEvents(count: number) {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i += 1) {
      await ctx.db.insert("auditEvents", {
        workspaceId,
        actorUserId: owner,
        action: "note.read",
        paths: [`1-projects/note-${i}.md`],
        at: Date.now() + i,
      });
    }
  });
  return { t, owner, workspaceId };
}

describe("listEvents.limit", () => {
  test("defaults, and honours a sane explicit limit", async () => {
    const { t, owner, workspaceId } = await workspaceWithEvents(5);

    const all = await asUser(t, owner).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    expect(all.length).toBeGreaterThanOrEqual(5);

    const limited = await asUser(t, owner).query(
      api.functions.audit.listEvents,
      { workspaceId, limit: 2 },
    );
    expect(limited).toHaveLength(2);
  });

  /**
   * `v.number()` is float64, and float64 includes `NaN`.
   *
   * The old handler clamped with `Math.min(Math.max(limit, 1), 200)`, which
   * maps `NaN` to `NaN`, and `.take(NaN)` throws a `TypeError` — a plain
   * `Error` with a `null` payload, which the client scrubs to "Server Error".
   * That is precisely the dead end `lib/workspaceAuth.ts` forbids, reached
   * through an argument nobody thought of as attacker-controlled. Convex
   * encodes `NaN` natively, so this is client-reachable, not theoretical.
   */
  test("refuses NaN with a coded error instead of throwing a bare TypeError", async () => {
    const { t, owner, workspaceId } = await workspaceWithEvents(3);

    const error = await captureError(() =>
      asUser(t, owner).query(api.functions.audit.listEvents, {
        workspaceId,
        limit: Number.NaN,
      }),
    );

    expect(errorCode(error)).toBe("INVALID_LIMIT");
    // A `ConvexError` carries a payload; a `TypeError` reaches the client with
    // `data: null` and nothing actionable in it.
    expect((error as { data?: unknown }).data).not.toBeNull();
  });

  test("refuses the rest of what float64 admits", async () => {
    const { t, owner, workspaceId } = await workspaceWithEvents(3);

    for (const limit of [
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2.5,
      0,
      -1,
      1e9,
    ]) {
      const error = await captureError(() =>
        asUser(t, owner).query(api.functions.audit.listEvents, {
          workspaceId,
          limit,
        }),
      );
      expect(errorCode(error), `limit=${limit} was accepted`).toBe(
        "INVALID_LIMIT",
      );
    }
  });

  test("a bad limit is refused after membership, so it is not an existence oracle", async () => {
    const { t, workspaceId } = await workspaceWithEvents(1);
    const stranger = await createUser(t, "stranger@example.invalid");

    // A non-member passing a nonsense limit learns that they are not a member,
    // not that the limit was nonsense — the authorization answer comes first
    // and is the same one they would get for a workspace that never existed.
    const error = await captureError(() =>
      asUser(t, stranger).query(api.functions.audit.listEvents, {
        workspaceId,
        limit: Number.NaN,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });
});

/**
 * INGESTION SETTINGS ARE OWNER-ONLY IN BOTH DIRECTIONS, AND THE TRAIL IS PART
 * OF THAT.
 *
 * `getIngestionSettings` and `updateIngestionSettings` both require `owner`,
 * deliberately: an allow-list over a header the sender wrote is the only thing
 * between a stranger and a note in somebody's inbox, and members "cannot read
 * or change the allow-list" is what holds the original risk after sharing a
 * personal context stopped killing its capture address.
 *
 * The audit row was not part of that. `listEvents` gates on membership, and
 * `ingestion.settings.updated` carries `allowedSendersBefore/After`,
 * `allowedDomainsBefore/After`, `allowAnySenderBefore/After`, the attachment
 * policy and the target folder. So anyone the owner invited into their workspace
 * could read the list's cardinality, whether it is open to any sender, and
 * where captures land -- and from `ingestion.captured` rows, the timing and
 * byte size of every message the owner receives.
 *
 * Contents were never recorded, so this is metadata rather than the list. It
 * is withheld the way `getStorageBinding` withholds the note census from a
 * non-owner, and for the same reason: a member deriving what they are not being
 * shown is the thing that census is owner-only to prevent.
 *
 * The event itself stays visible. "Something changed the capture policy, and
 * who" is what the trail exists to answer, and hiding the row would hide that.
 */
describe("an ingestion row's details are the owner's", () => {
  async function sharedWorkspaceWithIngestionEvent() {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const member = await createUser(t, "member@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceMembers", {
        workspaceId,
        userId: member,
        role: "member",
        joinedAt: Date.now(),
      });
      await ctx.db.insert("auditEvents", {
        workspaceId,
        actorUserId: owner,
        action: "ingestion.settings.updated",
        paths: ["0-inbox/"],
        at: Date.now(),
        details: {
          allowedSendersBefore: 2,
          allowedSendersAfter: 3,
          allowAnySenderAfter: false,
          widened: true,
        },
      });
    });
    return { t, owner, member, workspaceId };
  }

  test("the owner still sees what changed", async () => {
    const { t, owner, workspaceId } = await sharedWorkspaceWithIngestionEvent();
    const rows = await asUser(t, owner).query(api.functions.audit.listEvents, {
      workspaceId,
      limit: 10,
    });
    expect(rows[0]?.action).toBe("ingestion.settings.updated");
    expect(rows[0]?.details?.allowedSendersAfter).toBe(3);
  });

  test("a member sees that it happened and not what it said", async () => {
    const { t, member, workspaceId } = await sharedWorkspaceWithIngestionEvent();
    const rows = await asUser(t, member).query(api.functions.audit.listEvents, {
      workspaceId,
      limit: 10,
    });
    expect(rows[0]?.action, "the event itself is not hidden").toBe(
      "ingestion.settings.updated"
    );
    expect(rows[0]?.actorEmail, "nor is who did it").toBe("owner@example.invalid");
    expect(rows[0]?.details).toBeUndefined();
  });
});

/**
 * THE DETAIL GATE IS AN ALLOW-LIST, BECAUSE A DENY-LIST PUBLISHES BY DEFAULT.
 *
 * The first version of the gate above withheld `details` for actions whose
 * name starts with `ingestion.`, which is the shape this file's own
 * neighbours warn about: `OVERRIDABLE_STORAGE_CODES` is a list of codes safe
 * to override rather than a list of codes that are denials, precisely so a
 * code added next year is closed rather than open.
 *
 * It was not a hypothetical hole. `share.created` records
 * `details: { recipient: formatInvitee(...) }` -- the email address or handle
 * of somebody the owner shared one note with, who need not be a member of
 * anything. `listShares` requires `owner`, so that recipient is owner-only
 * through the shares API and was readable by every member through the trail.
 * Third-party PII, through a gate written for a different family of rows.
 *
 * So the question is inverted: an action's `details` reach a member only if
 * that action is named on `MEMBER_VISIBLE_DETAIL_ACTIONS`, and every action
 * that is not -- including one added next year, and including one this file
 * has never heard of -- is the owner's.
 */
describe("audit details are allow-listed, not deny-listed", () => {
  async function sharedWorkspaceWithRows() {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const member = await createUser(t, "member@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceMembers", {
        workspaceId,
        userId: member,
        role: "member",
        joinedAt: Date.now(),
      });
      await ctx.db.insert("auditEvents", {
        workspaceId,
        actorUserId: owner,
        action: "file.write",
        paths: ["1-projects/atlas.md"],
        at: 1_000,
        details: { conflictCheck: "etag" },
      });
      await ctx.db.insert("auditEvents", {
        workspaceId,
        actorUserId: owner,
        action: "share.created",
        paths: ["1-projects/atlas.md"],
        at: 2_000,
        details: { recipient: "outsider@example.invalid" },
      });
      await ctx.db.insert("auditEvents", {
        workspaceId,
        actorUserId: owner,
        action: "member.invited",
        paths: [],
        at: 3_000,
        details: { invitee: "recruit@example.invalid", role: "member" },
      });
      // An action nobody has classified. A deny-list publishes it; an
      // allow-list withholds it.
      await ctx.db.insert("auditEvents", {
        workspaceId,
        actorUserId: owner,
        action: "billing.plan_changed",
        paths: [],
        at: 4_000,
        details: { last4: "4242" },
      });
    });
    return { t, owner, member, workspaceId };
  }

  async function rowsFor(t: ReturnType<typeof setupTest>, who: Id<"users">, workspaceId: Id<"workspaces">) {
    const rows = await asUser(t, who).query(api.functions.audit.listEvents, {
      workspaceId,
      limit: 20,
    });
    return new Map(rows.map((row) => [row.action, row]));
  }

  test("the owner reads every detail", async () => {
    const { t, owner, workspaceId } = await sharedWorkspaceWithRows();
    const rows = await rowsFor(t, owner, workspaceId);
    expect(rows.get("share.created")?.details?.recipient).toBe(
      "outsider@example.invalid"
    );
    expect(rows.get("member.invited")?.details?.invitee).toBe(
      "recruit@example.invalid"
    );
    expect(rows.get("billing.plan_changed")?.details?.last4).toBe("4242");
  });

  /**
   * This test used to assert the opposite of its second clause -- that a
   * member reads *what* was shared, and only the recipient is withheld. The
   * path gate took that half away, deliberately: a share row names one note,
   * and `listShares` is owner-only, so "the owner shared `X`" was a note's
   * identity travelling one rung lower through the trail. What survives is
   * that the event happened and who did it, which is what the trail is for.
   */
  test("a member reads that a share happened, and neither its note nor its recipient", async () => {
    const { t, member, workspaceId } = await sharedWorkspaceWithRows();
    const rows = await rowsFor(t, member, workspaceId);
    const share = rows.get("share.created");
    expect(share, "the event itself is not hidden").toBeDefined();
    expect(share?.actorEmail, "nor is who did it").toBe("owner@example.invalid");
    expect(share?.paths, "but not which note").toEqual([]);
    expect(share?.pathsWithheld).toBe(true);
    expect(share?.details, "the recipient is a stranger's address").toBeUndefined();
  });

  test("a member reads neither an invitee nor an action nobody classified", async () => {
    const { t, member, workspaceId } = await sharedWorkspaceWithRows();
    const rows = await rowsFor(t, member, workspaceId);
    expect(rows.get("member.invited")?.details).toBeUndefined();
    expect(
      rows.get("billing.plan_changed")?.details,
      "an unclassified action is withheld by default"
    ).toBeUndefined();
  });

  test("an ordinary file row keeps its details for a member", async () => {
    const { t, member, workspaceId } = await sharedWorkspaceWithRows();
    const rows = await rowsFor(t, member, workspaceId);
    expect(
      rows.get("file.write")?.details?.conflictCheck,
      "withholding everything would make the trail useless"
    ).toBe("etag");
  });
});

/**
 * TWO ENTRIES CAME OFF THE ALLOW-LIST, EACH BY THE LIST'S OWN CRITERIA.
 *
 * The list above was written with three reasons for withholding, and the first
 * version of it then broke two of them with its own entries.
 *
 * **A count taken at the actor's scope.** `file.move`, `file.copy`,
 * `file.duplicate` and `file.archive` record `{ files: result.paths.length }`,
 * and `keysUnder` expands that list at the *actor's* clearance -- `private`
 * for the owner. So an owner archiving a `team` folder holding three team
 * notes and three private ones wrote `files: 6` where the member could list
 * three. That is the subtraction `getStorageBinding` withholds the note census
 * to prevent, arriving through the trail instead. The count is kept for the
 * owner and withheld from members rather than dropped at the call site, so
 * nothing is lost from the record itself.
 *
 * **A scope another API will not show.** `listGrants` shows every grant only
 * to a workspace `owner`; an editor and a member alike see their own and
 * nothing else.
 * `grant.created` records `{ scopes, tier }` and `oauth.authorized` records
 * `{ scope, grantedScope, tier }`, so a read-only member could read which AI
 * clients everybody else connected, with what reach -- the same shape as the
 * `ingestion.*` hole this gate was written to close, one rung lower.
 *
 * `grant.revoked` stays, deliberately rather than by omission: its details are
 * `{ onBehalfOfSelf }` or `{ reason: "refresh_token_reuse" }`, which name no
 * scope, no client and no third party. "A grant was revoked, and why" is the
 * kind of thing an audit trail exists to tell the people in a context.
 */
describe("the allow-list's own criteria are applied to the allow-list", () => {
  async function sharedBrainWith(action: string, details: Record<string, string | number | boolean | null>) {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const member = await createUser(t, "member@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceMembers", {
        workspaceId,
        userId: member,
        role: "member",
        joinedAt: Date.now(),
      });
      await ctx.db.insert("auditEvents", {
        workspaceId,
        actorUserId: owner,
        action,
        paths: ["1-projects", "4-archive/2026/1-projects"],
        at: Date.now(),
        details,
      });
    });
    const rows = await asUser(t, member).query(api.functions.audit.listEvents, {
      workspaceId,
      limit: 10,
    });
    return rows[0];
  }

  for (const action of ["file.move", "file.copy", "file.duplicate", "file.archive"]) {
    test(`a member cannot subtract a private-note count out of ${action}`, async () => {
      const row = await sharedBrainWith(action, { files: 6, recoverable: true });
      expect(row?.action, "the event itself is not hidden").toBe(action);
      expect(row?.details, "the count was taken at the owner's clearance").toBeUndefined();
    });
  }

  test("a member cannot read another person's granted scopes", async () => {
    const row = await sharedBrainWith("grant.created", {
      scopes: "context:read context:write context:private",
      tier: "private",
    });
    expect(row?.action).toBe("grant.created");
    expect(row?.details, "listGrants shows this to the owner only").toBeUndefined();
  });

  test("nor what an authorization was granted", async () => {
    const row = await sharedBrainWith("oauth.authorized", {
      grantedScope: "context:read context:private",
      tier: "private",
    });
    expect(row?.details).toBeUndefined();
  });

  test("but a revocation still says it happened and why", async () => {
    const row = await sharedBrainWith("grant.revoked", { reason: "refresh_token_reuse" });
    expect(
      row?.details?.reason,
      "it names no scope, no client and no third party"
    ).toBe("refresh_token_reuse");
  });

  /**
   * `exception: true` paired with `visibility: "private"` says this note's
   * classification differs from its folder's default -- a private note
   * counted inside a folder whose default the member CAN read, once `paths`
   * no longer rides beside it to make the flag redundant. The identical shape
   * `workspace.structure_applied`'s `folderCount` was struck from this list
   * for above.
   */
  test("a member cannot tell a note's visibility differs from its folder's default", async () => {
    const row = await sharedBrainWith("visibility.note", {
      visibility: "private",
      exception: true,
    });
    expect(row?.action, "the event itself is not hidden").toBe("visibility.note");
    expect(
      row?.details,
      "visibility and exception together are a private-note existence oracle",
    ).toBeUndefined();
  });

  /**
   * `visibility.folder` keeps no `exception` field, and its subject -- a
   * folder's own default -- is one a member watching that folder already
   * learns first-hand the instant their own listing of it changes. It stays
   * on the allow-list deliberately, not by oversight.
   */
  test("but a folder's own default is visible, having no exception field", async () => {
    const row = await sharedBrainWith("visibility.folder", { visibility: "team" });
    expect(row?.details?.visibility).toBe("team");
  });
});

/**
 * THE PATH GATE IS THE CLEARANCE BOUNDARY, NOT A SECOND OPINION ABOUT IT.
 *
 * `listEvents` releases a row's `paths` on two grounds a Convex `query` can
 * actually verify: the reader has `private` clearance, or the reader is the
 * row's own actor. It cannot run `canSee` -- that needs `privacy.md`, which
 * lives in the customer's bucket, behind the credential decrypt that
 * `runFileOperation` is the sole member of `CREDENTIAL_BARRIERS` to keep in
 * one place. So the gate is a sound under-approximation: it releases only
 * paths the reader demonstrably already had.
 *
 * `files.test.ts` proves the attack end to end, against a real bucket and the
 * real privacy engine. These are the control-plane edges around it.
 */
describe("a row's paths are the reader's clearance or the reader's own hands", () => {
  async function sharedWorkspace() {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const editor = await createUser(t, "editor@example.invalid");
    const member = await createUser(t, "member@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");
    await t.run(async (ctx) => {
      for (const [userId, role] of [
        [editor, "editor"],
        [member, "member"],
      ] as const) {
        await ctx.db.insert("workspaceMembers", {
          workspaceId,
          userId,
          role,
          joinedAt: Date.now(),
        });
      }
      await ctx.db.insert("auditEvents", {
        workspaceId,
        actorUserId: owner,
        action: "file.create",
        paths: ["2-areas/acquisition-of-acme.md"],
        at: 1_000,
        details: { conflictCheck: "none" },
      });
      // Nobody's own row: ingestion acts with no `actorUserId` at all. It has
      // to fall to the clearance leg, which is the closed direction.
      await ctx.db.insert("auditEvents", {
        workspaceId,
        action: "ingestion.captured",
        paths: ["0-inbox/2026-09-09-from-a-stranger.md"],
        at: 2_000,
      });
      await ctx.db.insert("auditEvents", {
        workspaceId,
        actorUserId: member,
        action: "file.write",
        paths: ["1-projects/the-member-wrote-this.md"],
        at: 3_000,
        details: { conflictCheck: "etag" },
      });
    });
    return { t, owner, editor, member, workspaceId };
  }

  async function pathsSeenBy(
    t: ReturnType<typeof setupTest>,
    who: Id<"users">,
    workspaceId: Id<"workspaces">,
  ) {
    const rows = await asUser(t, who).query(api.functions.audit.listEvents, {
      workspaceId,
      limit: 20,
    });
    return rows.flatMap((row) => row.paths);
  }

  test("the owner reads every path", async () => {
    const { t, owner, workspaceId } = await sharedWorkspace();
    expect(await pathsSeenBy(t, owner, workspaceId)).toEqual([
      "1-projects/the-member-wrote-this.md",
      "0-inbox/2026-09-09-from-a-stranger.md",
      "2-areas/acquisition-of-acme.md",
    ]);
  });

  test("a member reads their own row's paths and nobody else's", async () => {
    const { t, member, workspaceId } = await sharedWorkspace();
    expect(await pathsSeenBy(t, member, workspaceId)).toEqual([
      "1-projects/the-member-wrote-this.md",
    ]);
  });

  /**
   * WRITE ACCESS IS NOT CLEARANCE.
   *
   * `scopeForRole` gives an `editor` `team`, the same as a read-only member --
   * being able to write is a separate grant from being able to see what the
   * owner marked private. A path gate keyed on "can they write" rather than
   * "what can they see" would hand every editor the whole trail.
   */
  test("an editor is a team-scoped reader here, exactly like a member", async () => {
    const { t, editor, workspaceId } = await sharedWorkspace();
    expect(await pathsSeenBy(t, editor, workspaceId)).toEqual([]);
  });

  /**
   * The gate is written as `role === "owner"` because a query cannot import
   * `functions/files.ts` -- that module reaches the store factory and the
   * credential decrypt, and pulling it into an audit query would drag both
   * across a boundary `structure.test.ts` exists to police. This pins the
   * equivalence instead, so a change to `scopeForRole` that stopped meaning
   * "owner alone holds `private`" fails here rather than silently widening
   * the trail.
   */
  test("and `owner` is exactly the set of roles holding `private` clearance", () => {
    expect(scopeForRole("owner")).toBe("private");
    expect(scopeForRole("editor")).toBe("team");
    expect(scopeForRole("member")).toBe("team");
  });

  /**
   * `workspace.structure_applied` records `{ template, folderCount }`, and
   * `folderCount === paths.length` exactly. That cost nothing while `paths`
   * was published to members; the moment it is not, it is an exact census of
   * the top-level folders of a context whose scaffold manifest is
   * `default_visibility: private` -- the member can list none of them. It came
   * off the detail allow-list in the same commit that closed `paths`, which is
   * the revisit its old entry asked for.
   */
  test("a scaffold's folder count came off the allow-list with the paths it counted", async () => {
    const { t, member, owner, workspaceId } = await sharedWorkspace();
    await t.run(async (ctx) => {
      await ctx.db.insert("auditEvents", {
        workspaceId,
        actorUserId: owner,
        action: "workspace.structure_applied",
        paths: ["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive"],
        at: 4_000,
        details: { template: "para", folderCount: 5 },
      });
    });
    const rows = await asUser(t, member).query(api.functions.audit.listEvents, {
      workspaceId,
      limit: 20,
    });
    const scaffold = rows.find(
      (row) => row.action === "workspace.structure_applied",
    );
    expect(scaffold, "the event itself is not hidden").toBeDefined();
    expect(scaffold?.paths).toEqual([]);
    expect(
      scaffold?.details,
      "folderCount is paths.length under another name",
    ).toBeUndefined();

    const ownersView = await asUser(t, owner).query(
      api.functions.audit.listEvents,
      { workspaceId, limit: 20 },
    );
    expect(
      ownersView.find((row) => row.action === "workspace.structure_applied")
        ?.details?.folderCount,
      "withheld from the member, never dropped from the record",
    ).toBe(5);
  });
});
