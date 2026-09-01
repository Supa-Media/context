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
 * policy and the target folder. So anyone the owner invited into their brain
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
  async function sharedBrainWithIngestionEvent() {
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
    const { t, owner, workspaceId } = await sharedBrainWithIngestionEvent();
    const rows = await asUser(t, owner).query(api.functions.audit.listEvents, {
      workspaceId,
      limit: 10,
    });
    expect(rows[0]?.action).toBe("ingestion.settings.updated");
    expect(rows[0]?.details?.allowedSendersAfter).toBe(3);
  });

  test("a member sees that it happened and not what it said", async () => {
    const { t, member, workspaceId } = await sharedBrainWithIngestionEvent();
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
  async function sharedBrainWithRows() {
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
    const { t, owner, workspaceId } = await sharedBrainWithRows();
    const rows = await rowsFor(t, owner, workspaceId);
    expect(rows.get("share.created")?.details?.recipient).toBe(
      "outsider@example.invalid"
    );
    expect(rows.get("member.invited")?.details?.invitee).toBe(
      "recruit@example.invalid"
    );
    expect(rows.get("billing.plan_changed")?.details?.last4).toBe("4242");
  });

  test("a member reads a share's path and never its recipient", async () => {
    const { t, member, workspaceId } = await sharedBrainWithRows();
    const rows = await rowsFor(t, member, workspaceId);
    const share = rows.get("share.created");
    expect(share, "the event itself is not hidden").toBeDefined();
    expect(share?.paths, "nor is what was shared").toEqual([
      "1-projects/atlas.md",
    ]);
    expect(share?.details, "the recipient is a stranger's address").toBeUndefined();
  });

  test("a member reads neither an invitee nor an action nobody classified", async () => {
    const { t, member, workspaceId } = await sharedBrainWithRows();
    const rows = await rowsFor(t, member, workspaceId);
    expect(rows.get("member.invited")?.details).toBeUndefined();
    expect(
      rows.get("billing.plan_changed")?.details,
      "an unclassified action is withheld by default"
    ).toBeUndefined();
  });

  test("an ordinary file row keeps its details for a member", async () => {
    const { t, member, workspaceId } = await sharedBrainWithRows();
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
 * to `editor` and above; a plain member sees their own and nothing else.
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
    expect(row?.details, "listGrants shows this to editors and above only").toBeUndefined();
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
});
