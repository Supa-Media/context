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
