import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import { SWEEP_COMPLETENESS_ROWS } from "../../functions/account";
import { MAX_ACTIVE_SHARES } from "../../functions/shares";
import {
  asUser,
  createUser,
  createWorkspace,
  setupTest,
} from "../fixtures.helpers";
import {
  scenario,
  share,
} from "./fixtures.helpers";

describe("each half of the share sweep, isolated", () => {
  test("the sweep marks the row revoked, whatever the read path would have done", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    await share(t, ownerId, workspaceId, "@lk");

    await asUser(t, lkId).mutation(api.functions.account.deleteAccount, {});

    // Read the row, not a query over it: this is the teardown's own guarantee,
    // and it must hold even if every redemption check were removed.
    const rows = await t.run((ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("revoked");
    expect(rows[0].revokedAt).toBeGreaterThan(0);
  });

  test("sharing with somebody who has not signed up yet still works when they do", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);

    // **The case a bare "the claim must predate the share" comparison breaks,
    // and it is a headline flow, not a corner.** `createShare` deliberately
    // accepts a handle nobody holds — a share with `@nobody` must look exactly
    // like a share with a real person — and `listSharedWithMe` exists so that
    // "somebody addressed by `@name` who never got the link must still be able
    // to find what was shared with them". Both are meaningless if claiming the
    // handle afterwards is what kills the share.
    //
    // It also fails **silently on both sides**: the recipient sees an empty
    // inbox, the owner still sees the share listed as live, and re-sharing
    // cannot repair it because the active-row branch freezes `createdAt`.
    const { token } = await share(t, ownerId, workspaceId, "@newcomer");
    const newcomer = await createUser(t, "newcomer@example.invalid");
    await createWorkspace(t, newcomer, "newcomer");

    expect(
      await asUser(t, newcomer).query(api.functions.shares.resolveShare, { token }),
    ).not.toBeNull();
    expect(
      await asUser(t, newcomer).query(api.functions.shares.listSharedWithMe, {}),
    ).toHaveLength(1);
    // The same order through `inviteMember` has always worked; the two must not
    // diverge, because the module comment says they are the same shape.
    expect(
      await asUser(t, newcomer).query(api.functions.invitations.listMyInvitations, {}),
    ).toEqual([]);
  });

  test("a handle that changed hands after the share was written does not carry it", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    const { token } = await share(t, ownerId, workspaceId, "@lk");

    // The sweep is deliberately taken out of the picture: the row is put back
    // to `active` after the deletion, so only the redemption side can refuse.
    // This is the half that has to hold when a future table slips the cascade.
    await asUser(t, lkId).mutation(api.functions.account.deleteAccount, {});
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("noteShares").collect()) {
        await ctx.db.patch(row._id, { status: "active", revokedAt: undefined });
      }
    });

    const successor = await createUser(t, "successor@example.invalid");
    await createWorkspace(t, successor, "lk");

    expect(
      await asUser(t, successor).query(api.functions.shares.resolveShare, { token }),
    ).toBeNull();
    expect(
      await asUser(t, successor).query(api.functions.shares.listSharedWithMe, {}),
    ).toEqual([]);
  });

  test("the person the handle already belonged to still redeems it", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    const { token } = await share(t, ownerId, workspaceId, "@lk");

    expect(
      await asUser(t, lkId).query(api.functions.shares.resolveShare, { token }),
    ).not.toBeNull();
    expect(
      await asUser(t, lkId).query(api.functions.shares.listSharedWithMe, {}),
    ).toHaveLength(1);
  });

  test("re-sharing after a revoke addresses whoever holds the handle now", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    await share(t, ownerId, workspaceId, "@lk");
    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    // The handle changes hands while the row sits revoked.
    await asUser(t, lkId).mutation(api.functions.account.deleteAccount, {});
    const successor = await createUser(t, "successor@example.invalid");
    await createWorkspace(t, successor, "lk");

    // The owner shares again, knowingly, with whoever `@lk` is today. A revoked
    // row is re-used for the new grant, so its pin has to be rewritten with the
    // token and the date — carrying the old one forward would address a fresh
    // share to a claim that no longer exists, and refuse the person the owner
    // just chose.
    const { token } = await share(t, ownerId, workspaceId, "@lk");
    expect(token).not.toBe(listed[0].token);

    expect(
      await asUser(t, successor).query(api.functions.shares.resolveShare, { token }),
    ).not.toBeNull();
    expect(
      await asUser(t, successor).query(api.functions.shares.listSharedWithMe, {}),
    ).toHaveLength(1);
  });

  test("every share addressed to the identifier goes, not just the first page", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);

    // **The completeness half, which nothing held.** Every other test in this
    // suite aims one share at one recipient, so a sweep that stopped after the
    // first row — or the first hundred — passed everything. What that buys an
    // attacker is not subtle: the rows it skips stay `active`, so the next
    // holder of the handle is handed live tokens by their own inbox, which is
    // precisely what the block above exists to prevent.
    //
    // Seeded directly because the point is the count, not the mint path, and
    // `MAX_ACTIVE_SHARES` would otherwise decide how many fit.
    const extra = SWEEP_COMPLETENESS_ROWS;
    await t.run(async (ctx) => {
      for (let i = 0; i < extra; i += 1) {
        await ctx.db.insert("noteShares", {
          workspaceId,
          entryPath: `1-projects/bulk/note-${i}.md`,
          recipientKind: "name",
          recipient: "lk",
          createdBy: ownerId,
          token: `token-${i}`.padEnd(64, "0"),
          status: "active",
          titleInPreview: true,
          createdAt: Date.now(),
        });
      }
    });

    await asUser(t, lkId).mutation(api.functions.account.deleteAccount, {});

    const left = await t.run((ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_recipient", (q) =>
          q.eq("recipientKind", "name").eq("recipient", "lk").eq("status", "active"),
        )
        .collect(),
    );
    expect(left).toEqual([]);

    // And the successor's inbox agrees, which is the shape the attack takes.
    const successor = await createUser(t, "successor@example.invalid");
    await createWorkspace(t, successor, "lk");
    expect(
      await asUser(t, successor).query(api.functions.shares.listSharedWithMe, {}),
    ).toEqual([]);
  });

  test("destroying a context takes every page of its shares, not just the first", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);

    // The sibling of the test above, and it exists because the sibling was
    // missed: this loop was reworked while fixing a review finding *about* the
    // other one, and truncating it passed all 1230 checks. A row left here
    // points at a workspace that no longer exists, which is the
    // dangling-capability half of what this block is for.
    // A full count of EACH status. The first version of this test seeded that
    // many rows *in total* and split them across the two, so neither status
    // reached the threshold the truncation it was written for needed — and the
    // sabotage passed. The cascade loops per status, so each status has to
    // carry enough on its own.
    const extra = SWEEP_COMPLETENESS_ROWS;
    await t.run(async (ctx) => {
      for (const status of ["active", "revoked"] as const) {
        for (let i = 0; i < extra; i += 1) {
          await ctx.db.insert("noteShares", {
            workspaceId,
            entryPath: `1-projects/bulk/${status}-${i}.md`,
            recipientKind: "name",
            recipient: `recipient-${status}-${i}`,
            createdBy: ownerId,
            token: `cascade-${status}-${i}`.padEnd(64, "0"),
            status,
            titleInPreview: true,
            createdAt: Date.now(),
            ...(status === "revoked" ? { revokedAt: Date.now() } : {}),
          });
        }
      }
    });

    await asUser(t, ownerId).mutation(api.functions.account.deleteAccount, {});

    expect(await t.run((ctx) => ctx.db.query("noteShares").collect())).toEqual([]);
  });

  test("a share addressed to an email does not follow the address to its next holder", async () => {
    const t = setupTest();
    const { ownerId, mailOnlyId, workspaceId } = await scenario(t);
    await share(t, ownerId, workspaceId, "mail-only@example.invalid");

    // Control: it reaches the mailbox's holder.
    expect(
      await asUser(t, mailOnlyId).query(api.functions.shares.listSharedWithMe, {}),
    ).toHaveLength(1);

    // Deleting the account frees the address, exactly as it frees a handle.
    // There is no claim date to compare for an address — `emailVerificationTime`
    // is re-stamped on every verifying sign-in — so the sweep is the whole
    // control here, and it has to fire.
    await asUser(t, mailOnlyId).mutation(api.functions.account.deleteAccount, {});

    const rows = await t.run((ctx) => ctx.db.query("noteShares").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("revoked");

    // And the next holder of the address, which is what "does not follow" in
    // this test's own name means. Today this cannot fail while the assertion
    // above passes — the schema validator would reject a misnamed field — so it
    // is an end-to-end anchor rather than an independent guard, and it is here
    // because the status literal is a proxy for this and the proxy is what the
    // test's name promises.
    const successor = await createUser(t, "successor@example.invalid");
    await t.run(async (ctx) => {
      await ctx.db.patch(successor, {
        email: "mail-only@example.invalid",
        emailVerificationTime: Date.now(),
      });
    });
    expect(
      await asUser(t, successor).query(api.functions.shares.listSharedWithMe, {}),
    ).toEqual([]);
  });

  test("a sharer who is no longer the owner cannot keep disclosing", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    const { token } = await share(t, ownerId, workspaceId, "@lk");

    // The workspace survives and the name is untouched, so nothing else in the
    // predicate can be what refuses this.
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect();
      for (const row of membership) {
        if (row.userId === ownerId) await ctx.db.delete(row._id);
      }
    });

    expect(
      await asUser(t, lkId).query(api.functions.shares.resolveShare, { token }),
    ).toBeNull();
    expect(await asUser(t, lkId).query(api.functions.shares.listSharedWithMe, {})).toEqual(
      [],
    );
  });

  test("a sharer demoted out of ownership cannot keep disclosing either", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    const { token } = await share(t, ownerId, workspaceId, "@lk");

    // Ownership is not transferable, so this state is reachable only by writing
    // it. That is the point: the check says "still the owner", not "still a
    // member", and the two are different sentences. Deleting the row holds only
    // the first half — this holds the second.
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect();
      for (const row of membership) {
        if (row.userId === ownerId) await ctx.db.patch(row._id, { role: "editor" });
      }
    });

    expect(
      await asUser(t, lkId).query(api.functions.shares.resolveShare, { token }),
    ).toBeNull();
    expect(await asUser(t, lkId).query(api.functions.shares.listSharedWithMe, {})).toEqual(
      [],
    );
  });

  test("a share pointing at a workspace that is gone resolves to nothing", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    const { token } = await share(t, ownerId, workspaceId, "@lk");

    // Only the workspace document goes, with its memberships deliberately left
    // behind. What refuses this is the predicate as a whole rather than any one
    // line — the early null check is redundant with the function's own return
    // value, which is recorded in `shareStillStands` rather than implied here.
    await t.run(async (ctx) => {
      await ctx.db.delete(workspaceId);
    });

    expect(
      await asUser(t, lkId).query(api.functions.shares.resolveShare, { token }),
    ).toBeNull();
    expect(await asUser(t, lkId).query(api.functions.shares.listSharedWithMe, {})).toEqual(
      [],
    );

    // And the reason has to be the workspace, not a crash: the same call for a
    // token that never existed answers identically.
    expect(
      await asUser(t, lkId).query(api.functions.shares.resolveShare, {
        token: "0".repeat(64),
      }),
    ).toBeNull();
  });
});

/**
 * THE ACTIVE-SHARE CAP.
 *
 * `assertShareCapacity` is the only thing bounding how many live shares one
 * context can have, and **nothing tested it** — `if (false && active.length >
 * MAX_ACTIVE_SHARES)` passed all 1231 checks. That matters beyond tidiness:
 * the account-deletion sweep is deliberately unbounded (completeness beats a
 * ceiling when the alternative is leaving a live capability standing), and the
 * argument for why that is acceptable rests on this cap being real.
 *
 * Seeded directly rather than through `createShare`, because a hundred round
 * trips through path validation and audit writes would be testing those.
 */
