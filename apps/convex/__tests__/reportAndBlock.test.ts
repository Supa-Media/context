/**
 * REPORT AND BLOCK — App Store guideline 1.2, inside tenant isolation.
 *
 *  1. **A block narrows what reaches the blocker, and nothing else.** A
 *     blocked sharer's named share leaves @shared and refuses to open, the
 *     same `null` a revoked share gets; a blocked inviter's invitation leaves
 *     the list, cannot be accepted, and is not mailed. Unblocking restores
 *     both. Nothing is deleted.
 *  2. **The blocked person sees no difference.** Their share is still listed
 *     as theirs, their invitation is still pending, re-inviting still
 *     returns `null`.
 *  3. **A report is never an existence oracle.** A nonexistent target, a
 *     target in another tenant and a real one get the same receipt by the same
 *     path; whether it resolved goes to the team only.
 *  4. **A report carries ids, never content or a token.** The delivered
 *     envelope is read back and searched for the token, the path, the title.
 *  5. **Signed-in only, and you cannot block yourself.**
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   drop the `hasBlocked` line from `shareStillStands`                    2
 *   drop the `hasBlocked` line from `invitationForCaller`                 1
 *   drop the blocked-inviter filter from `listMyInvitations`              2
 *   drop the blocked-invitee check from `claimInvitationEmail`            1
 *   forward `target.path` with a workspace_note report                    1
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

const DSN = "https://0123456789abcdef0123456789abcdef@o1.ingest.example.invalid/42";
const NOTE = "1-projects/beneath-the-chaos.md";
const SECRET_TITLE = "Quarterly secret plan";

let sent: string[] = [];
let clientIds = 0;
function clientId(): string {
  clientIds += 1;
  return clientIds.toString(16).padStart(24, "0");
}

beforeEach(() => {
  sent = [];
  process.env.FEEDBACK_SENTRY_DSN = DSN;
  delete process.env.FEEDBACK_INTAKE;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init: { body: Uint8Array }) => {
    // Only the report's post is ours to catch; a module loading its own
    // `data:` URL (the card renderer's layout engine) goes through untouched.
    if (!String(url).includes("ingest.example.invalid")) return realFetch(url, init as RequestInit);
    sent.push(new TextDecoder().decode(new Uint8Array(init.body)));
    return new Response("{}", { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FEEDBACK_SENTRY_DSN;
});

async function scenario(t: TestConvex) {
  const ana = await createUser(t, "ana@example.invalid");
  const lk = await createUser(t, "lk@example.invalid");
  const bo = await createUser(t, "bo@example.invalid");
  const anaOwn = await createWorkspace(t, ana, "ana");
  const lkOwn = await createWorkspace(t, lk, "lk");
  const boOwn = await createWorkspace(t, bo, "bo");
  const atlas = await createWorkspace(t, ana, "atlas", { kind: "shared", displayName: "Atlas" });
  return { ana, lk, bo, anaOwn, lkOwn, boOwn, atlas };
}

async function shareWithLk(t: TestConvex, ana: Id<"users">, workspaceId: Id<"workspaces">) {
  const { token } = await asUser(t, ana).mutation(api.functions.shares.createShare, {
    workspaceId,
    path: NOTE,
    recipient: "@lk",
  });
  return token;
}

async function inviteLk(t: TestConvex, ana: Id<"users">, atlas: Id<"workspaces">) {
  await asUser(t, ana).mutation(api.functions.invitations.inviteMember, {
    workspaceId: atlas,
    invitee: "@lk",
    role: "member",
  });
  const mine = await asUser(t, ana).query(api.functions.invitations.listInvitations, { workspaceId: atlas });
  return mine[0]!.invitationId;
}

async function lkInvitationToken(t: TestConvex, lk: Id<"users">): Promise<string | null> {
  const mine = await asUser(t, lk).query(api.functions.invitations.listMyInvitations, {});
  return mine[0]?.token ?? null;
}

describe("signed-in only", { timeout: 30_000 }, () => {
  test("an anonymous caller can neither block, unblock, list nor report", async () => {
    const t = setupTest();
    const { ana, anaOwn } = await scenario(t);
    const token = await shareWithLk(t, ana, anaOwn);

    expect(await captureError(() => t.mutation(api.functions.blocks.blockPerson, { via: "share", token }))).toBeDefined();
    expect(await captureError(() => t.mutation(api.functions.blocks.unblockPerson, { userId: ana }))).toBeDefined();
    expect(await captureError(() => t.query(api.functions.blocks.listBlockedPeople, {}))).toBeDefined();
    const error = await captureError(() =>
      t.action(api.functions.reports.submitReport, {
        clientReportId: clientId(),
        target: { kind: "share", token },
        reason: "spam",
      }),
    );
    expect(errorCode(error)).toBe("REPORT_UNAUTHENTICATED");
    expect(sent).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("userBlocks").collect())).toHaveLength(0);
  });

  test("blocking yourself is refused", async () => {
    const t = setupTest();
    const { ana, anaOwn } = await scenario(t);
    const { token } = await asUser(t, ana).mutation(api.functions.shares.createShare, {
      workspaceId: anaOwn,
      path: NOTE,
      recipient: "@ana",
    });
    const error = await captureError(() =>
      asUser(t, ana).mutation(api.functions.blocks.blockPerson, { via: "share", token }),
    );
    expect(errorCode(error)).toBe("BLOCK_SELF");
  });
});

describe("blocking a sharer", () => {
  test("their share leaves @shared and refuses to open, like a revoked one; unblocking restores it", async () => {
    const t = setupTest();
    const { ana, lk, anaOwn } = await scenario(t);
    const token = await shareWithLk(t, ana, anaOwn);
    const lkView = asUser(t, lk);
    expect(await lkView.query(api.functions.shares.listSharedWithMe, {})).toHaveLength(1);

    await lkView.mutation(api.functions.blocks.blockPerson, { via: "share", token });

    expect(await lkView.query(api.functions.shares.listSharedWithMe, {})).toEqual([]);
    expect(await lkView.query(api.functions.shares.resolveShare, { token })).toBeNull();
    expect(
      await t.query(internal.functions.shares.authorizeShareRead, { actorUserId: lk, token }),
    ).toBeNull();
    // The blocker sees who they blocked, by handle; nothing else about them.
    expect(await lkView.query(api.functions.blocks.listBlockedPeople, {})).toEqual([
      expect.objectContaining({ userId: ana, handle: "ana" }),
    ]);

    // The sharer sees no difference: the share is still live and still theirs.
    const anaShares = await asUser(t, ana).query(api.functions.shares.listShares, { workspaceId: anaOwn });
    expect(anaShares.map((row) => row.token)).toContain(token);

    await lkView.mutation(api.functions.blocks.unblockPerson, { userId: ana });
    expect(await lkView.query(api.functions.shares.listSharedWithMe, {})).toHaveLength(1);
    expect(await lkView.query(api.functions.shares.resolveShare, { token })).not.toBeNull();
    expect(
      await t.query(internal.functions.shares.authorizeShareRead, { actorUserId: lk, token }),
    ).not.toBeNull();
  });

  test("a block is the blocker's alone: the same sharer still reaches somebody else", async () => {
    const t = setupTest();
    const { ana, lk, bo, anaOwn } = await scenario(t);
    const toLk = await shareWithLk(t, ana, anaOwn);
    const { token: toBo } = await asUser(t, ana).mutation(api.functions.shares.createShare, {
      workspaceId: anaOwn,
      path: NOTE,
      recipient: "@bo",
    });
    await asUser(t, lk).mutation(api.functions.blocks.blockPerson, { via: "share", token: toLk });

    expect(await asUser(t, bo).query(api.functions.shares.resolveShare, { token: toBo })).not.toBeNull();
    expect(await asUser(t, bo).query(api.functions.shares.listSharedWithMe, {})).toHaveLength(1);
  });

  test("a token that is not addressed to the caller blocks nobody, silently", async () => {
    const t = setupTest();
    const { ana, bo, anaOwn } = await scenario(t);
    const toLk = await shareWithLk(t, ana, anaOwn);
    expect(await asUser(t, bo).mutation(api.functions.blocks.blockPerson, { via: "share", token: toLk })).toBeNull();
    expect(
      await asUser(t, bo).mutation(api.functions.blocks.blockPerson, { via: "share", token: "no-such-token" }),
    ).toBeNull();
    expect(await asUser(t, bo).query(api.functions.blocks.listBlockedPeople, {})).toEqual([]);
  });
});

describe("blocking an inviter", () => {
  test("their invitation leaves the list and cannot be accepted; the inviter sees it pending", async () => {
    const t = setupTest();
    const { ana, lk, atlas } = await scenario(t);
    await inviteLk(t, ana, atlas);
    const token = await lkInvitationToken(t, lk);
    expect(token).not.toBeNull();
    const listed = await asUser(t, lk).query(api.functions.invitations.listMyInvitations, {});
    expect(listed[0]).toMatchObject({ invitedByHandle: "ana" });

    await asUser(t, lk).mutation(api.functions.blocks.blockPerson, { via: "invitation", token: token! });

    expect(await asUser(t, lk).query(api.functions.invitations.listMyInvitations, {})).toEqual([]);
    const error = await captureError(() =>
      asUser(t, lk).mutation(api.functions.invitations.acceptInvitation, { token: token! }),
    );
    expect(errorCode(error)).toBe("INVITATION_NOT_FOUND");

    // The inviter's view and answers are unchanged.
    const pending = await asUser(t, ana).query(api.functions.invitations.listInvitations, { workspaceId: atlas });
    expect(pending.map((row) => row.invitee)).toEqual(["@lk"]);
    expect(
      await asUser(t, ana).mutation(api.functions.invitations.inviteMember, {
        workspaceId: atlas,
        invitee: "@lk",
        role: "member",
      }),
    ).toBeNull();

    await asUser(t, lk).mutation(api.functions.blocks.unblockPerson, { userId: ana });
    const back = await lkInvitationToken(t, lk);
    expect(back).not.toBeNull();
    await asUser(t, lk).mutation(api.functions.invitations.acceptInvitation, { token: back! });
  });

  test("an invitation from somebody the invitee blocked is not mailed to them", async () => {
    const t = setupTest();
    const { ana, lk, atlas } = await scenario(t);
    const first = await inviteLk(t, ana, atlas);
    // Unblocked, the claim would mail it: the control for the assertion below.
    expect(await t.mutation(internal.functions.invitationEmail.claimInvitationEmail, { invitationId: first })).not.toBeNull();

    const token = await lkInvitationToken(t, lk);
    await asUser(t, lk).mutation(api.functions.blocks.blockPerson, { via: "invitation", token: token! });
    // Re-inviting supersedes the row and clears `emailSentAt`: a fresh right to be mailed.
    const again = await inviteLk(t, ana, atlas);
    expect(await t.mutation(internal.functions.invitationEmail.claimInvitationEmail, { invitationId: again })).toBeNull();
  });
});

describe("reporting", () => {
  async function report(t: TestConvex, as: Id<"users">, target: Record<string, unknown>, alsoBlock = false) {
    return await asUser(t, as).action(api.functions.reports.submitReport, {
      clientReportId: clientId(),
      // The validator is a union; the cast keeps each test's target readable.
      target: target as never,
      reason: "harassment",
      details: "This keeps arriving.",
      alsoBlock,
      platform: "ios",
    });
  }

  test("the receipt is the same for a real target, a nonexistent one and another tenant's", async () => {
    const t = setupTest();
    const { ana, lk, anaOwn, boOwn } = await scenario(t);
    const token = await shareWithLk(t, ana, anaOwn);

    const receipts = [
      await report(t, lk, { kind: "share", token }),
      await report(t, lk, { kind: "share", token: "a".repeat(64) }),
      await report(t, lk, { kind: "workspace_note", workspaceId: boOwn, path: NOTE }),
      await report(t, lk, { kind: "workspace_note", workspaceId: "not-an-id", path: NOTE }),
      await report(t, lk, { kind: "invitation", token: "b".repeat(64) }),
      await report(t, lk, { kind: "public_page", handle: "nobody-has-this" }),
    ];
    for (const receipt of receipts) {
      expect(Object.keys(receipt)).toEqual(["eventId"]);
      expect(receipt.eventId).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(sent).toHaveLength(receipts.length);
    // Whether it resolved goes to the team, never back to the reporter.
    expect(sent[0]).toContain('"resolved":"yes"');
    expect(sent[1]).toContain('"resolved":"no"');
    expect(sent[2]).toContain('"resolved":"no"');
    expect(sent[2]).not.toContain(boOwn);
  });

  test("the delivered report carries ids, never the token, the path or the title", async () => {
    const t = setupTest();
    const { ana, lk, anaOwn, atlas } = await scenario(t);
    const token = await shareWithLk(t, ana, anaOwn);
    await t.run(async (ctx) => {
      await ctx.db.insert("nodes", {
        kind: "file",
        observedAt: 1,
        workspaceId: atlas,
        path: NOTE,
        name: "beneath-the-chaos.md",
        noteId: "note-0001",
        props: JSON.stringify({ properties: { title: SECRET_TITLE }, heading: SECRET_TITLE }),
      });
      await ctx.db.insert("workspaceMembers", { workspaceId: atlas, userId: lk, role: "member", joinedAt: 1 });
    });

    await report(t, lk, { kind: "share", token });
    await report(t, lk, { kind: "workspace_note", workspaceId: atlas, path: NOTE });
    await report(t, lk, { kind: "public_page", token });

    expect(sent).toHaveLength(3);
    for (const envelope of sent) {
      expect(envelope).not.toContain(token);
      expect(envelope).not.toContain(NOTE);
      expect(envelope).not.toContain("beneath-the-chaos");
      expect(envelope).not.toContain(SECRET_TITLE);
      expect(envelope).toContain('"report.reason":"harassment"');
      expect(envelope).toContain("This keeps arriving.");
    }
    expect(sent[0]).toContain(`"personId":"${ana}"`);
    expect(sent[1]).toContain('"noteId":"note-0001"');
    expect(sent[1]).toContain(`"workspaceId":"${atlas}"`);
  });

  test("report and block blocks the sharer in the same call; an unresolved target blocks nobody", async () => {
    const t = setupTest();
    const { ana, lk, anaOwn } = await scenario(t);
    const token = await shareWithLk(t, ana, anaOwn);

    await report(t, lk, { kind: "share", token: "c".repeat(64) }, true);
    expect(await asUser(t, lk).query(api.functions.blocks.listBlockedPeople, {})).toEqual([]);

    await report(t, lk, { kind: "share", token }, true);
    expect(await asUser(t, lk).query(api.functions.blocks.listBlockedPeople, {})).toEqual([
      expect.objectContaining({ userId: ana }),
    ]);
    expect(await asUser(t, lk).query(api.functions.shares.listSharedWithMe, {})).toEqual([]);
  });

  test("report and block works on an invitation too", async () => {
    const t = setupTest();
    const { ana, lk, atlas } = await scenario(t);
    await inviteLk(t, ana, atlas);
    const token = await lkInvitationToken(t, lk);
    await report(t, lk, { kind: "invitation", token }, true);
    expect(await asUser(t, lk).query(api.functions.invitations.listMyInvitations, {})).toEqual([]);
  });

  test("a reason outside the closed list and over-long words are refused before anything is sent", async () => {
    const t = setupTest();
    const { lk } = await scenario(t);
    const bad = await captureError(() =>
      asUser(t, lk).action(api.functions.reports.submitReport, {
        clientReportId: clientId(),
        target: { kind: "share", token: "x" },
        reason: "rude",
      }),
    );
    expect(errorCode(bad)).toBe("REPORT_INVALID");
    const long = await captureError(() =>
      asUser(t, lk).action(api.functions.reports.submitReport, {
        clientReportId: clientId(),
        target: { kind: "share", token: "x" },
        reason: "other",
        details: "x".repeat(1001),
      }),
    );
    expect(errorCode(long)).toBe("REPORT_INVALID");
    expect(sent).toHaveLength(0);
  });

  test("the app's feedback intake refuses the `report` source", async () => {
    const t = setupTest();
    const { lk } = await scenario(t);
    const error = await captureError(() =>
      asUser(t, lk).action(api.functions.feedback.submitFeedback, {
        clientReportId: clientId(),
        message: "pretending to be a report",
        source: "report",
        screen: "/",
        app: { platform: "web" },
      }),
    );
    expect(errorCode(error)).toBe("FEEDBACK_INVALID");
  });
});
