import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { MAX_ACTIVE_SHARES } from "../../functions/shares";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import {
  NOTE,
  OTHER_NOTE,
  scenario,
  share,
} from "./fixtures";

describe("the recipient's own channel", () => {
  test("listSharedWithMe shows what was shared with me and nothing else", async () => {
    const t = setupTest();
    const { ownerId, lkId, mailOnlyId, workspaceId } = await scenario(t);
    await share(t, ownerId, workspaceId, "@lk");
    await share(t, ownerId, workspaceId, "mail-only@example.invalid", OTHER_NOTE);

    const mine = await asUser(t, lkId).query(api.functions.shares.listSharedWithMe, {});
    expect(mine).toHaveLength(1);
    expect(mine[0].entryPath).toBe(NOTE);

    const theirs = await asUser(t, mailOnlyId).query(
      api.functions.shares.listSharedWithMe,
      {},
    );
    expect(theirs).toHaveLength(1);
    expect(theirs[0].entryPath).toBe(OTHER_NOTE);
  });

  test("a revoked share disappears from the recipient's list", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    await share(t, ownerId, workspaceId, "@lk");
    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    const mine = await asUser(t, lkId).query(api.functions.shares.listSharedWithMe, {});
    expect(mine).toHaveLength(0);
  });
});

describe("the audit trail", () => {
  test("creating and revoking a share are both recorded against the acting person", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await share(t, ownerId, workspaceId, "@lk");
    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    const events = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    const actions = events.map((event) => event.action);
    expect(actions).toContain("share.created");
    expect(actions).toContain("share.revoked");

    const created = events.find((event) => event.action === "share.created")!;
    expect(created.actorUserId).toBe(ownerId);
    expect(created.paths).toContain(NOTE);
  });
});

/**
 * WHAT SWEEPS A SHARE WHEN ITS ADDRESSEE OR ITS CONTEXT STOPS EXISTING.
 *
 * A share is a capability addressed to a **string** — a `@handle` or a mailbox
 * — and resolved only when somebody presents it. That is the same deliberate
 * design as an invitation, for the same anti-enumeration reason, and it has the
 * same consequence: the identifier can change hands while the capability sits
 * there waiting.
 *
 * `account.ts` already knows this. `voidCapabilitiesAddressedTo` exists for it,
 * and its doc comment is the argument in full — *"a freed name must inherit
 * nothing… a stranger walking into a context that was shared with a person who
 * no longer exists"*. It covers `workspaceInvitations`. A share is a second,
 * **longer-lived** capability addressed the same way: an invitation is a
 * one-time offer that dies on answer, a share is standing and by default never
 * expires.
 *
 * Two directions, and neither is hypothetical — both were measured end to end
 * against the code as merged, before this block existed:
 *
 *  - **The addressee's name is freed.** Alice deletes her account; the handle
 *    `@alice` returns to the pool; Carol claims it. Every standing share
 *    addressed to `@alice` is now Carol's, and `listSharedWithMe` — the
 *    recipient's own inbox — hands her the live tokens unasked. She never
 *    needed the link.
 *  - **The context is destroyed.** Its memberships, grants, invitations and
 *    audit trail are swept; its shares were not, so they survive as rows
 *    pointing at a workspace that no longer exists.
 *
 * The rule this codebase already follows for authority is **sweep at teardown
 * AND re-check at redemption** — `deleteWorkspaceCascade` may omit
 * `oauthAuthorizations` only because `createGrant` re-checks membership when
 * the code is redeemed. So both halves are asserted here: the rows go, and
 * `resolveShare` refuses even when handed a row the sweep missed.
 */
describe("a freed name inherits nothing, and neither does a destroyed context", () => {
  test("a standing share does not follow the handle to its next owner", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    const { token } = await share(t, ownerId, workspaceId, "@lk");

    // Control: it works for the person it was addressed to.
    expect(
      await asUser(t, lkId).query(api.functions.shares.resolveShare, { token }),
    ).not.toBeNull();

    // `@lk` gives up their account, which frees the handle.
    await asUser(t, lkId).mutation(api.functions.account.deleteAccount, {});

    const successor = await createUser(t, "successor@example.invalid");
    await createWorkspace(t, successor, "lk");

    // Their own inbox must not be the delivery channel for somebody else's
    // share. This is the half that needs no link at all.
    expect(
      await asUser(t, successor).query(api.functions.shares.listSharedWithMe, {}),
    ).toEqual([]);

    // And the link itself, if they were to find it, resolves to nothing.
    expect(
      await asUser(t, successor).query(api.functions.shares.resolveShare, { token }),
    ).toBeNull();
  });

  test("destroying a context takes its shares with it", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    const { token } = await share(t, ownerId, workspaceId, "@lk");

    await asUser(t, ownerId).mutation(api.functions.account.deleteAccount, {});

    // No dangling capability rows pointing at a workspace that is gone.
    const leftover = await t.run((ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(leftover).toEqual([]);

    // The recipient's side agrees, by both channels.
    expect(await asUser(t, lkId).query(api.functions.shares.listSharedWithMe, {})).toEqual(
      [],
    );
    expect(
      await asUser(t, lkId).query(api.functions.shares.resolveShare, { token }),
    ).toBeNull();
  });

  test("redemption re-checks, so a row the sweep missed is still refused", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    const { token } = await share(t, ownerId, workspaceId, "@lk");

    // Simulate the cascade missing this table — a future table added to the
    // schema and not to the teardown, which is exactly how this was found.
    // Everything else about the workspace goes.
    await asUser(t, ownerId).mutation(api.functions.account.deleteAccount, {});
    await t.run(async (ctx) => {
      // Whatever the sweep did or did not do, leave exactly one row carrying
      // this token — `by_token` is a `.unique()` lookup, and the point of the
      // test is the re-check, not the cardinality.
      for (const row of await ctx.db.query("noteShares").collect()) {
        if (row.token === token) await ctx.db.delete(row._id);
      }
      await ctx.db.insert("noteShares", {
        workspaceId,
        entryPath: NOTE,
        recipientKind: "name",
        recipient: "lk",
        createdBy: ownerId,
        token,
        status: "active",
        titleInPreview: true,
        createdAt: Date.now(),
      });
    });

    expect(
      await asUser(t, lkId).query(api.functions.shares.resolveShare, { token }),
    ).toBeNull();
    expect(await asUser(t, lkId).query(api.functions.shares.listSharedWithMe, {})).toEqual(
      [],
    );
  });
});

/**
 * THE TWO HALVES, HELD SEPARATELY.
 *
 * The block above proves the outcome: a freed name and a destroyed context both
 * stop working. It does **not** prove which line stops them, and that turned out
 * to matter — sabotaging the teardown sweep and sabotaging the redemption
 * re-check each left the entire suite green, because each closes the case the
 * other closes. Two guards that mask one another are, for testing purposes, one
 * guard with a spare, and the spare is exactly what nobody notices going.
 *
 * So each test here removes one half from the picture by construction, and the
 * db is read directly where the point is what was *written* rather than what a
 * query answers.
 */
describe("how many shares a context may have outstanding", () => {
  /** One active row per note, so nothing supersedes anything. */
  async function seedActive(
    t: TestConvex,
    workspaceId: Id<"workspaces">,
    ownerId: Id<"users">,
    count: number,
  ): Promise<void> {
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i += 1) {
        await ctx.db.insert("noteShares", {
          workspaceId,
          entryPath: `1-projects/cap/note-${i}.md`,
          recipientKind: "name",
          recipient: `holder-${i}`,
          createdBy: ownerId,
          token: `cap-${i}`.padEnd(64, "0"),
          status: "active",
          titleInPreview: true,
          createdAt: Date.now(),
        });
      }
    });
  }

  test("the cap is the number the refusal names, not one more", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await seedActive(t, workspaceId, ownerId, MAX_ACTIVE_SHARES - 1);

    // The last one under the cap goes through.
    await share(t, ownerId, workspaceId, "@lk", "1-projects/cap/last.md");

    // The next is refused, and the refusal says so.
    const error = await captureError(() =>
      share(t, ownerId, workspaceId, "@lk", "1-projects/cap/over.md"),
    );
    expect(errorCode(error)).toBe("TOO_MANY_SHARES");
    // The refusal states the number, and this test is named for that. Without
    // this line, hardcoding a different number into the message passes — the
    // copy and the bound could disagree again, which is the defect this whole
    // block exists to have caught.
    expect((error as { data?: { message?: string } }).data?.message).toContain(
      String(MAX_ACTIVE_SHARES),
    );

    // And the count really is the advertised number — the message promises
    // `MAX_ACTIVE_SHARES` outstanding, so `MAX_ACTIVE_SHARES + 1` rows would
    // make the copy wrong as well as the bound.
    const active = await t.run((ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_workspace_status", (q) =>
          q.eq("workspaceId", workspaceId).eq("status", "active"),
        )
        .collect(),
    );
    expect(active).toHaveLength(MAX_ACTIVE_SHARES);
  });

  test("at the cap, re-sharing a note that is already shared still works", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await seedActive(t, workspaceId, ownerId, MAX_ACTIVE_SHARES);

    // Supersession returns before the capacity check, and must: re-sharing is
    // the same grant, so a full context would otherwise be unable to adjust a
    // share it already has — including turning its preview title off.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("noteShares")
        .withIndex("by_workspace_status", (q) =>
          q.eq("workspaceId", workspaceId).eq("status", "active"),
        )
        .first();
      await ctx.db.patch(row!._id, { recipientKind: "name", recipient: "lk" });
    });

    const again = await asUser(t, ownerId).mutation(api.functions.shares.createShare, {
      workspaceId,
      path: "1-projects/cap/note-0.md",
      recipient: "@lk",
      titleInPreview: false,
    });
    expect(again.token).toBe("cap-0".padEnd(64, "0"));
  });

  test("re-activating a revoked share is refused at the cap, like any other row", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await seedActive(t, workspaceId, ownerId, MAX_ACTIVE_SHARES);

    // Revoke one and replace it, so the live count is back at the cap with a
    // revoked row sitting beside it.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("noteShares")
        .withIndex("by_workspace_status", (q) =>
          q.eq("workspaceId", workspaceId).eq("status", "active"),
        )
        .first();
      await ctx.db.patch(row!._id, {
        status: "revoked",
        revokedAt: Date.now(),
        recipientKind: "name",
        recipient: "lk",
      });
    });
    await share(t, ownerId, workspaceId, "@lk", "1-projects/cap/replacement.md");

    // Re-sharing the revoked note turns that row active again, which is the
    // second of the two ways a live row appears — and it has to pass the same
    // cap the insert does. Gating the check on `existing === null` is a
    // one-token change that makes this the way past it, and it survived the
    // whole suite until this test existed.
    const error = await captureError(() =>
      share(t, ownerId, workspaceId, "@lk", "1-projects/cap/note-0.md"),
    );
    expect(errorCode(error)).toBe("TOO_MANY_SHARES");
  });

  test("a revoked share does not count against the cap", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await seedActive(t, workspaceId, ownerId, MAX_ACTIVE_SHARES);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("noteShares")
        .withIndex("by_workspace_status", (q) =>
          q.eq("workspaceId", workspaceId).eq("status", "active"),
        )
        .first();
      await ctx.db.patch(row!._id, { status: "revoked", revokedAt: Date.now() });
    });

    // Revoking is what the refusal tells the owner to do, so it has to be what
    // makes room. If revoked rows counted, the advice would be a dead end.
    await share(t, ownerId, workspaceId, "@lk", "1-projects/cap/fresh.md");
  });
});
