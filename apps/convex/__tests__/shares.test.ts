/**
 * NOTE SHARES — the control-plane half.
 *
 * A share is a standing, revocable grant to read one team-visible note,
 * addressed to one person who is **not** a member of the context. Three
 * properties are being proved here, and they fail in different directions:
 *
 *  1. **A share narrows, never widens.** It hands over one note. It is not a
 *     membership, so it must not appear anywhere membership does, and it must
 *     not be creatable over `privacy.md` or anything under `.history/`.
 *  2. **A share is bound to the person it was addressed to.** Holding the token
 *     is not enough. Presenting one you were not sent must fail exactly like
 *     presenting one that never existed — and so must presenting a revoked one,
 *     because otherwise revocation would be observable to whoever kept the link.
 *  3. **A share box is not an existence oracle.** The attacker is the *sharer*:
 *     anybody with an account has one. Sharing with `@nobody` must be
 *     indistinguishable from sharing with a real person, which is why several
 *     tests below compare whole responses rather than "both succeeded".
 *
 * The one deliberate asymmetry with `invitations.test.ts` is that `createShare`
 * returns its token, where `inviteMember` returns `null`. That is safe because
 * the token is minted from `crypto.getRandomValues` before anything is looked
 * up, so it carries no information about the recipient — and it is *necessary*,
 * because the product is a link somebody pastes into a chat. The test named
 * "a share with a stranger is byte-identical to a share with a real person"
 * is what keeps that distinction honest: it compares the responses with the
 * tokens removed, and would fail the moment any other field started varying.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { SWEEP_COMPLETENESS_ROWS } from "../functions/account";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

const NOTE = "1-projects/transition/overview.md";
const OTHER_NOTE = "1-projects/transition/proposal.md";

/** Serialize a thrown error's payload so two failures can be compared exactly. */
function errorShape(error: unknown): string {
  return JSON.stringify((error as { data?: unknown }).data ?? null);
}

/**
 * An owner with a context, a member of it, and two outsiders — one of whom has
 * claimed a `@handle` and one of whom exists only as an address.
 */
async function scenario(t: TestConvex): Promise<{
  ownerId: Id<"users">;
  memberId: Id<"users">;
  lkId: Id<"users">;
  mailOnlyId: Id<"users">;
  workspaceId: Id<"workspaces">;
}> {
  const ownerId = await createUser(t, "owner@example.invalid");
  const memberId = await createUser(t, "member@example.invalid");
  const lkId = await createUser(t, "lk@example.invalid");
  const mailOnlyId = await createUser(t, "mail-only@example.invalid");

  const workspaceId = await createWorkspace(t, ownerId, "owner-brain");
  await addMember(t, workspaceId, memberId, "member");

  // `@lk` resolves through the personal context that owns the slug.
  await createWorkspace(t, lkId, "lk");

  return { ownerId, memberId, lkId, mailOnlyId, workspaceId };
}

async function share(
  t: TestConvex,
  actorId: Id<"users">,
  workspaceId: Id<"workspaces">,
  recipient: string,
  path: string = NOTE,
): Promise<{ token: string }> {
  return await asUser(t, actorId).mutation(api.functions.shares.createShare, {
    workspaceId,
    path,
    recipient,
  });
}

describe("creating a share", () => {
  test("an owner can share a note with somebody outside the context", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);

    const created = await share(t, ownerId, workspaceId, "@lk");

    expect(created.token).toMatch(/^[A-Za-z0-9_-]{16,}$/);

    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0].recipient).toBe("@lk");
    expect(listed[0].entryPath).toBe(NOTE);
    expect(listed[0].titleInPreview).toBe(true);
  });

  test("sharing is owner-only — an ordinary member cannot hand a note out", async () => {
    const t = setupTest();
    const { memberId, workspaceId } = await scenario(t);

    const error = await captureError(() => share(t, memberId, workspaceId, "@lk"));
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("a non-member cannot tell the context apart from one that does not exist", async () => {
    const t = setupTest();
    const { lkId, workspaceId } = await scenario(t);

    const error = await captureError(() => share(t, lkId, workspaceId, "@lk"));
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  /**
   * The oracle test. Two shares, one to a real handle and one to a handle
   * nobody has ever claimed, compared field by field with the tokens removed.
   *
   * If a future change makes `createShare` resolve its recipient — to store a
   * `userId`, to answer "sent" versus "no such person", to skip writing a row
   * nobody can use — this is what fails.
   */
  test("a share with a stranger is byte-identical to a share with a real person", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);

    const real = await share(t, ownerId, workspaceId, "@lk");
    const nobody = await share(t, ownerId, workspaceId, "@nobody-at-all", OTHER_NOTE);

    expect(Object.keys(real).sort()).toEqual(Object.keys(nobody).sort());
    expect(real.token).not.toBe(nobody.token);

    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    const shapeOf = (recipient: string) => {
      const row = listed.find((entry) => entry.recipient === recipient)!;
      return JSON.stringify({
        ...row,
        shareId: null,
        // Excluded because it is CSPRNG output and must differ. That it carries
        // nothing about the recipient is what the format assertion below says.
        token: null,
        entryPath: null,
        // Derived from `entryPath`, which is already excluded — and the two
        // shares deliberately point at different notes. That it depends on the
        // path and on nothing about the recipient is asserted below.
        previewTitle: null,
        recipient: null,
        createdAt: null,
      });
    };
    expect(shapeOf("@lk")).toBe(shapeOf("@nobody-at-all"));

    for (const row of listed) {
      expect(row.token).toMatch(/^[0-9a-f]{64}$/);
    }

    // The preview title is a function of the path alone. Sharing the *same*
    // note with a real person and with a stranger must title both identically,
    // or the card would be the oracle the response body is not.
    await share(t, ownerId, workspaceId, "@someone-else");
    const bothOnEntry = await asUser(t, ownerId).query(
      api.functions.shares.listShares,
      { workspaceId },
    );
    const titles = bothOnEntry
      .filter((row) => row.entryPath === NOTE)
      .map((row) => row.previewTitle);
    expect(titles).toHaveLength(2);
    expect(new Set(titles).size).toBe(1);
    expect(titles[0]).toBe("Overview");
  });

  test("a malformed recipient is refused, and the refusal is about the string", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);

    const error = await captureError(() => share(t, ownerId, workspaceId, "not a name"));
    expect(errorCode(error)).toBe("INVALID_INVITEE");
  });

  test("the access map itself cannot be shared", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);

    const error = await captureError(() =>
      share(t, ownerId, workspaceId, "@lk", "privacy.md"),
    );
    expect(errorCode(error)).toBe("PATH_NOT_SHAREABLE");
  });

  test("nothing under a dot-folder can be shared", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);

    const error = await captureError(() =>
      share(t, ownerId, workspaceId, "@lk", ".history/1-projects/overview.md"),
    );
    expect(errorCode(error)).toBe("PATH_NOT_SHAREABLE");
  });

  test("a traversal path is refused before anything is written", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);

    const error = await captureError(() =>
      share(t, ownerId, workspaceId, "@lk", "1-projects/../../etc/passwd"),
    );
    expect(errorCode(error)).toBe("PATH_INVALID");

    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    expect(listed).toHaveLength(0);
  });

  test("only a note can be shared, not an attachment", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);

    const error = await captureError(() =>
      share(t, ownerId, workspaceId, "@lk", "3-resources/slides.pdf"),
    );
    expect(errorCode(error)).toBe("PATH_NOT_SHAREABLE");
  });

  /**
   * Re-sharing is one grant, not two — and it keeps the token, because the
   * owner has already sent that link to the person it addresses.
   */
  test("re-sharing the same note with the same person supersedes in place", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);

    const first = await share(t, ownerId, workspaceId, "@lk");
    const second = await share(t, ownerId, workspaceId, "@lk");

    expect(second.token).toBe(first.token);

    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    expect(listed).toHaveLength(1);
  });

  test("the same note may be shared with two different people", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);

    const one = await share(t, ownerId, workspaceId, "@lk");
    const two = await share(t, ownerId, workspaceId, "mail-only@example.invalid");

    expect(one.token).not.toBe(two.token);
    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    expect(listed).toHaveLength(2);
  });
});

describe("resolving a share", () => {
  test("the addressed person resolves it by handle", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    const { token } = await share(t, ownerId, workspaceId, "@lk");

    const resolved = await asUser(t, lkId).query(api.functions.shares.resolveShare, {
      token,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.entryPath).toBe(NOTE);
    expect(resolved!.workspaceId).toBe(workspaceId);
  });

  test("the addressed person resolves it by verified email", async () => {
    const t = setupTest();
    const { ownerId, mailOnlyId, workspaceId } = await scenario(t);
    const { token } = await share(t, ownerId, workspaceId, "mail-only@example.invalid");

    const resolved = await asUser(t, mailOnlyId).query(
      api.functions.shares.resolveShare,
      { token },
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.entryPath).toBe(NOTE);
  });

  /**
   * The capability test. Somebody else's token is not a key, and the refusal
   * for holding one must be the same absence as a token that was never issued.
   */
  test("holding somebody else's token is worth exactly nothing", async () => {
    const t = setupTest();
    const { ownerId, mailOnlyId, workspaceId } = await scenario(t);
    const { token } = await share(t, ownerId, workspaceId, "@lk");

    const stolen = await asUser(t, mailOnlyId).query(api.functions.shares.resolveShare, {
      token,
    });
    const invented = await asUser(t, mailOnlyId).query(
      api.functions.shares.resolveShare,
      { token: "a-token-that-was-never-issued" },
    );
    expect(stolen).toBeNull();
    expect(stolen).toEqual(invented);
  });

  test("a revoked share is indistinguishable from one that never existed", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    const { token } = await share(t, ownerId, workspaceId, "@lk");

    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    const afterRevoke = await asUser(t, lkId).query(api.functions.shares.resolveShare, {
      token,
    });
    const invented = await asUser(t, lkId).query(api.functions.shares.resolveShare, {
      token: "a-token-that-was-never-issued",
    });
    expect(afterRevoke).toBeNull();
    expect(afterRevoke).toEqual(invented);
  });

  test("an expired share stops resolving", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    const { token } = await share(t, ownerId, workspaceId, "@lk");

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });

    const resolved = await asUser(t, lkId).query(api.functions.shares.resolveShare, {
      token,
    });
    expect(resolved).toBeNull();
  });

  test("a signed-out caller resolves nothing", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const { token } = await share(t, ownerId, workspaceId, "@lk");

    const error = await captureError(() =>
      t.query(api.functions.shares.resolveShare, { token }),
    );
    expect(error).toBeInstanceOf(Error);
  });

  /**
   * A share is not a membership, and this is the assertion that says so. If
   * somebody later models a share as a `viewer` row in `workspaceMembers`, the
   * recipient acquires an MCP grant over every team note in the context and
   * this fails.
   */
  test("a share recipient is not a member and cannot reach the context", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    await share(t, ownerId, workspaceId, "@lk");

    const error = await captureError(() =>
      asUser(t, lkId).query(api.functions.shares.listShares, { workspaceId }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");

    const memberships = await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(memberships.map((row) => row.userId)).not.toContain(lkId);
  });
});

describe("revoking a share", () => {
  test("revocation is owner-only", async () => {
    const t = setupTest();
    const { ownerId, memberId, workspaceId } = await scenario(t);
    await share(t, ownerId, workspaceId, "@lk");
    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });

    const error = await captureError(() =>
      asUser(t, memberId).mutation(api.functions.shares.revokeShare, {
        shareId: listed[0].shareId,
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
  });

  test("an outsider revoking gets the same absence as a share that never existed", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    await share(t, ownerId, workspaceId, "@lk");
    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });

    const theirs = await captureError(() =>
      asUser(t, lkId).mutation(api.functions.shares.revokeShare, {
        shareId: listed[0].shareId,
      }),
    );
    expect(errorCode(theirs)).toBe("SHARE_NOT_FOUND");

    // The same absence the owner gets for a share that is already gone.
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });
    const spent = await captureError(() =>
      asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
        shareId: listed[0].shareId,
      }),
    );
    expect(errorShape(theirs)).toBe(errorShape(spent));
  });

  test("a revoked share leaves the listing", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await share(t, ownerId, workspaceId, "@lk");
    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });

    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    const after = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    expect(after).toHaveLength(0);
  });

  /**
   * Revocation must be final. Re-sharing after a revoke is a new grant with a
   * new token, so a link somebody had already forwarded stays dead.
   */
  test("re-sharing after a revoke mints a new token and does not revive the old one", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    const first = await share(t, ownerId, workspaceId, "@lk");
    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    const second = await share(t, ownerId, workspaceId, "@lk");
    expect(second.token).not.toBe(first.token);

    const dead = await asUser(t, lkId).query(api.functions.shares.resolveShare, {
      token: first.token,
    });
    expect(dead).toBeNull();

    const live = await asUser(t, lkId).query(api.functions.shares.resolveShare, {
      token: second.token,
    });
    expect(live).not.toBeNull();
  });
});

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
    // this test's own name means. Asserting only the status literal would let
    // the sweep write `revoked` somewhere nothing reads and still pass.
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
