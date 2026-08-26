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
