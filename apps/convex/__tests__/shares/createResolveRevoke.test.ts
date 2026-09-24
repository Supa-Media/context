import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import {
  asUser,
  captureError,
  errorCode,
  setupTest,
} from "../fixtures.helpers";
import {
  NOTE,
  OTHER_NOTE,
  errorShape,
  scenario,
  share,
} from "./fixtures.helpers";

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

