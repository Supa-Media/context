/**
 * The audit trail's arguments.
 *
 * `isolation.test.ts` covers who may read a trail. This covers the one
 * argument a caller controls, which used to be trusted further than it had
 * earned.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
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
