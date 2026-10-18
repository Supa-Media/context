/**
 * `/gateway/jobs/*` for an image upload: the ticket `write_note` hands an
 * agent so it can PUT a picture's bytes instead of pasting them as base64
 * (`apps/mcp/src/notes/imageUploads.js`).
 *
 * What has to hold: the ticket opens the bucket only for exactly the bytes it
 * was minted for, once, within ten minutes, for a grant that is still live and
 * a person who can still write there; it never selects another workspace; and
 * it is never mistaken for a move (the Settings card, the privacy authority).
 *
 * Sabotage, each confirmed to fail a case here: drop the hash comparison in
 * the claim, drop the grant re-check at claim, let a `member` mint, or drop
 * the kind check in `leasedGatewayJobWorkspace`.
 */
import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { leasedGatewayJobWorkspace } from "../../functions/lib/controlPlane/gatewayJobs";
import { hashToken } from "../../functions/lib/crypto";
import { addMember, asUser, createUser, gatewayPost, type TestConvex } from "../fixtures.helpers";
import { ACCESS_A, CLIENT_A, bodyOf, seedConnectedClient, token, twoConnectedTenants } from "./fixtures.helpers";

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

async function mint(t: TestConvex, accessToken: string, workspaceId: string, job: Record<string, unknown> = {}) {
  return await bodyOf(
    await gatewayPost(t, "/gateway/jobs/create", {
      accessToken,
      expectedWorkspaceId: workspaceId,
      job: { kind: "image_upload", sha256: SHA, bytes: 1234, ...job },
    }),
  );
}

async function open(t: TestConvex, ticket: string, contentSha256?: string) {
  return (await bodyOf(await gatewayPost(t, "/gateway/jobs/open", { ticket, ...(contentSha256 ? { contentSha256 } : {}) })))
    .job as null | { retryAfterMs?: number; job?: Record<string, unknown>; binding?: { workspaceId: string; bucket: string } };
}

describe("/gateway/jobs/* image uploads", () => {
  test("a writer mints a ticket that opens its own bucket once, for exactly the declared bytes", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const created = await mint(t, ACCESS_A, aliceWs);
    const ticket = created.ticket as string;
    expect(typeof ticket).toBe("string");

    const [row] = await t.run((ctx) => ctx.db.query("gatewayJobs").collect());
    expect(row).toMatchObject({ kind: "image_upload", imageSha256: SHA, imageBytes: 1234, status: "queued" });
    expect(row.hashedTicket).toBe(await hashToken(ticket));
    expect(row.expiresAt - row.createdAt).toBe(10 * 60 * 1000);

    expect(await open(t, ticket)).toBeNull();
    expect(await open(t, ticket, OTHER_SHA)).toBeNull();
    // Neither wrong hash spent it.
    const opened = await open(t, ticket, SHA);
    expect(opened?.job).toMatchObject({ workspaceId: aliceWs, kind: "image_upload", imageSha256: SHA, imageBytes: 1234 });
    expect(opened?.binding).toMatchObject({ workspaceId: aliceWs, bucket: "tenant-a" });

    await gatewayPost(t, "/gateway/jobs/report", { ticket, result: { status: "complete" } });
    expect(await open(t, ticket, SHA)).toBeNull();
  });

  test("a ticket never selects another workspace, and bad shapes mint nothing", async () => {
    const { t, aliceWs, bobWs } = await twoConnectedTenants();
    expect(await mint(t, ACCESS_A, bobWs)).toEqual({ ticket: null });
    expect(await mint(t, ACCESS_A, aliceWs, { sha256: "A".repeat(64) })).toEqual({ ticket: null });
    expect(await mint(t, ACCESS_A, aliceWs, { sha256: "a".repeat(63) })).toEqual({ ticket: null });
    expect(await mint(t, ACCESS_A, aliceWs, { bytes: 0 })).toEqual({ ticket: null });
    expect(await mint(t, ACCESS_A, aliceWs, { bytes: 5_000_001 })).toEqual({ ticket: null });
    expect(await mint(t, ACCESS_A, aliceWs, { bytes: 1.5 })).toEqual({ ticket: null });
    expect(await mint(t, ACCESS_A, aliceWs, { moveId: "move-aaaaaaaaaaaa" })).toEqual({ ticket: null });
    expect(await t.run((ctx) => ctx.db.query("gatewayJobs").collect())).toHaveLength(0);
  });

  test("an editor may mint; a member and a read-only grant may not", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const editor = await createUser(t, "upload-editor@example.test");
    const member = await createUser(t, "upload-member@example.test");
    await addMember(t, aliceWs, editor, "editor", alice);
    await addMember(t, aliceWs, member, "member", alice);
    const editorToken = token("upload_editor");
    const memberToken = token("upload_member");
    const readerToken = token("upload_reader");
    await seedConnectedClient(t, { workspaceId: aliceWs, userId: editor, clientId: CLIENT_A, accessToken: editorToken });
    await seedConnectedClient(t, { workspaceId: aliceWs, userId: member, clientId: CLIENT_A, accessToken: memberToken });
    await seedConnectedClient(t, {
      workspaceId: aliceWs, userId: editor, clientId: CLIENT_A, accessToken: readerToken, scopes: ["context:read"],
    });
    expect(typeof (await mint(t, editorToken, aliceWs)).ticket).toBe("string");
    expect(await mint(t, memberToken, aliceWs)).toEqual({ ticket: null });
    expect(await mint(t, readerToken, aliceWs)).toEqual({ ticket: null });
  });

  test("revoking the grant, or demoting the person, closes an unspent ticket", async () => {
    const { t, alice, aliceWs, grantA } = await twoConnectedTenants();
    const revoked = (await mint(t, ACCESS_A, aliceWs)).ticket as string;
    await t.run((ctx) => ctx.db.patch(grantA, { status: "revoked" }));
    expect(await open(t, revoked, SHA)).toBeNull();

    const editor = await createUser(t, "demoted-editor@example.test");
    await addMember(t, aliceWs, editor, "editor", alice);
    const editorToken = token("demoted_editor");
    await seedConnectedClient(t, { workspaceId: aliceWs, userId: editor, clientId: CLIENT_A, accessToken: editorToken });
    const demoted = (await mint(t, editorToken, aliceWs)).ticket as string;
    expect(typeof demoted).toBe("string");
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceMembers")
        .filter((q) => q.and(q.eq(q.field("workspaceId"), aliceWs), q.eq(q.field("userId"), editor)))
        .unique();
      await ctx.db.patch(row!._id, { role: "member" });
    });
    expect(await open(t, demoted, SHA)).toBeNull();
  });

  test("an expired ticket opens nothing, and the sweep deletes it", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const ticket = (await mint(t, ACCESS_A, aliceWs)).ticket as string;
    const [row] = await t.run((ctx) => ctx.db.query("gatewayJobs").collect());
    await t.run((ctx) => ctx.db.patch(row._id, { expiresAt: Date.now() - 1 }));
    expect(await open(t, ticket, SHA)).toBeNull();
    expect(await t.mutation(internal.functions.controlPlane.sweepImageUploads, {})).toBe(1);
    expect(await t.run((ctx) => ctx.db.query("gatewayJobs").collect())).toHaveLength(0);
  });

  test("an upload is never mistaken for a move", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const ticket = (await mint(t, ACCESS_A, aliceWs)).ticket as string;
    expect((await open(t, ticket, SHA))?.job).toBeTruthy();
    // Running, leased and owned by an owner: a move's ticket would prove its workspace here.
    const hashedTicket = await hashToken(ticket);
    expect(await t.run((ctx) => leasedGatewayJobWorkspace(ctx, hashedTicket))).toBeNull();
    const moves = await asUser(t, alice).query(api.functions.files.listDurableMoves, {
      workspaceId: aliceWs as Id<"workspaces">,
    });
    expect(moves).toEqual([]);
  });

  test("it opens while the rows judge privacy, when the held rules carry the rows' version", async () => {
    // Production since 2026-10-17: the privacy authority is on and the rows
    // judge, so `nodesPrivacy.authority` answers `accessVersion` beside the
    // rules. `openGatewayJob`'s return validator once lacked it, so every open
    // threw after the claim spent the ticket: 503, then 409 on the retry.
    const { t, aliceWs } = await twoConnectedTenants();
    await t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: false, privacyAuthority: true, accessSource: "rows", updatedAt: 1 });
      await ctx.db.insert("nodePrivacy", {
        workspaceId: aliceWs as Id<"workspaces">,
        etag: "ctx-1",
        invalid: false,
        folders: [],
        notes: [],
        observedAt: 1,
      });
    });
    const ticket = (await mint(t, ACCESS_A, aliceWs)).ticket as string;
    const opened = await open(t, ticket, SHA);
    expect(opened?.binding).toMatchObject({ workspaceId: aliceWs, bucket: "tenant-a" });
    expect((opened as { privacy?: { accessVersion?: number } }).privacy?.accessVersion).toEqual(expect.any(Number));
  });
});
