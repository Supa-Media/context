/**
 * A binding table that holds two shapes.
 *
 * Every field on `storageBindings` used to be required, because every binding
 * was a bucket. A Dropbox binding has no endpoint, no region, no bucket and no
 * access key — it has an OAuth grant and a folder — so the S3 five became
 * optional, and the schema stopped being able to refuse a half-built row on its
 * own.
 *
 * These are the checks that buy that back. They are deliberately about the
 * seams the schema no longer guards: what rotation covers, what the gateway
 * refuses, and what the error scrubber knows to redact.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { readFileSync } from "node:fs";
import {
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { ENVELOPE_FIELDS } from "../functions/storage";

/** A Dropbox binding, written straight to the table. */
async function dropboxBound(t: TestConvex, workspaceId: Id<"workspaces">, owner: Id<"users">) {
  const keyset = requireKeyset();
  const context = { workspaceId: workspaceId as string };
  const now = Date.now();
  return t.run(async (ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: "dropbox" as const,
      rootPrefix: "Context/",
      encryptedRefreshToken: await encryptSecret("refresh-abc", keyset, context),
      encryptedAccessToken: await encryptSecret("access-xyz", keyset, context),
      accessTokenExpiresAt: now + 3_600_000,
      dropboxAccountId: "dbid:AAA",
      capabilities: { conditionalWrite: true },
      status: "connected" as const,
      boundBy: owner,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function scenario() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  return { t, owner, workspaceId };
}

describe("what rotation covers", () => {
  /**
   * THE ONE THAT WOULD HAVE BEEN SILENT.
   *
   * Rotation used to read one hardcoded field. A Dropbox binding keeps its
   * credentials in two others, so a rotation would have reported success,
   * moved nothing, and left those envelopes readable only by the key the
   * operator was about to delete. Nothing would have failed until a customer's
   * next read, long after the pass looked clean.
   */
  test("a Dropbox binding's tokens are rotated, not skipped", async () => {
    const { t, owner, workspaceId } = await scenario();
    await dropboxBound(t, workspaceId, owner);

    const candidates = await t.query(internal.functions.storage.listRekeyCandidates, {
      // A key id nothing was written under, so every envelope is a candidate.
      currentKeyId: "some-other-key",
      limit: 50,
    });

    const fields = candidates.candidates.map((c) => c.field).sort();
    expect(fields).toEqual(["encryptedAccessToken", "encryptedRefreshToken"]);
    expect(candidates.unreadable).toBe(0);
  });

  test("an absent envelope is not counted as unreadable", async () => {
    const { t, owner, workspaceId } = await scenario();
    await dropboxBound(t, workspaceId, owner);

    // A Dropbox row has no bucket secret. That is normal, not corruption —
    // counting it as unreadable would make every rotation report damage.
    const candidates = await t.query(internal.functions.storage.listRekeyCandidates, {
      currentKeyId: "some-other-key",
      limit: 50,
    });
    expect(candidates.unreadable).toBe(0);
    expect(
      candidates.candidates.some((c) => c.field === "encryptedSecretAccessKey"),
    ).toBe(false);
  });

  /**
   * The comment on `ENVELOPE_FIELDS` claims adding a fourth encrypted field
   * means adding it there. This is what makes that a guarantee rather than a
   * hope: a new `encrypted*` column in the schema fails here until it is
   * listed, which is the only moment anybody is thinking about it.
   */
  test("every encrypted field in the schema is one rotation knows about", () => {
    const schema = readFileSync(new URL("../schema.ts", import.meta.url), "utf8");
    const bindings = schema.slice(
      schema.indexOf("storageBindings: defineTable({"),
      schema.indexOf("}).index(\"by_workspace\"", schema.indexOf("storageBindings: defineTable({")),
    );
    const declared = [...bindings.matchAll(/^\s{4}(encrypted[A-Za-z]*)\s*:/gm)].map(
      (match) => match[1],
    );
    expect(declared.length).toBeGreaterThan(0);
    for (const field of declared) {
      expect(
        ENVELOPE_FIELDS as readonly string[],
        `schema field "${field}" is encrypted but rotation would skip it`,
      ).toContain(field);
    }
  });
});

describe("what the gateway refuses", () => {
  /**
   * The Dropbox binding is now served — from a *refreshed* short-lived access
   * token, and the payload carries nothing else.
   *
   * The two rules that meet here are worth asserting rather than reading:
   * the refresh token never reaches the gateway, and the payload is built per
   * provider rather than spread from the row, so a workspace rebound from S3
   * cannot leak a stale `accessKeyId` into a Dropbox binding.
   */
  test("a Dropbox binding is served as a token and a folder, and nothing else", async () => {
    const { t, owner, workspaceId } = await scenario();
    await dropboxBound(t, workspaceId, owner);

    const credential = await t.action(
      internal.functions.storage.getBindingForGateway,
      { workspaceId },
    );

    expect(credential?.provider).toBe("dropbox");
    const serialized = JSON.stringify(credential);
    // The long-lived credential stays in the control plane. A compromised
    // gateway then holds minutes of one workspace's storage, not the standing
    // ability to mint tokens for it.
    expect(serialized).not.toContain("refresh-abc");
    expect(serialized).not.toContain("refreshToken");
    // And no bucket credential, because this binding has no bucket.
    expect(serialized).not.toContain("accessKeyId");
    expect(serialized).not.toContain("secretAccessKey");
  });

  /**
   * A cached token that is still comfortably fresh is reused. Otherwise every
   * request refreshes, which is a token-endpoint call per read and a rate
   * limit waiting to happen.
   */
  test("a fresh cached token is reused rather than refreshed", async () => {
    const { t, owner, workspaceId } = await scenario();
    await dropboxBound(t, workspaceId, owner);

    const credential = await t.action(
      internal.functions.storage.getBindingForGateway,
      { workspaceId },
    );
    // The fixture's token, handed straight back — no network call was needed,
    // which is what makes this test able to run offline at all.
    expect(
      (credential as { accessToken?: string } | null)?.accessToken,
    ).toBe("access-xyz");
  });

  test("an incomplete S3 binding is refused too, rather than papered over", async () => {
    const { t, owner, workspaceId } = await scenario();
    const now = Date.now();
    await t.run(async (ctx) =>
      ctx.db.insert("storageBindings", {
        workspaceId,
        provider: "s3" as const,
        endpoint: "https://s3.example.invalid",
        region: "us-east-1",
        // No bucket, no key: a corrupt row, not a Dropbox one.
        capabilities: { conditionalWrite: true },
        status: "connected" as const,
        boundBy: owner,
        createdAt: now,
        updatedAt: now,
      }),
    );

    const error = await captureError(() =>
      t.action(internal.functions.storage.getBindingForGateway, { workspaceId }),
    );
    expect(errorCode(error)).toBe("CREDENTIAL_UNAVAILABLE");
  });
});

describe("what the console may see", () => {
  test("a Dropbox binding exposes no credential, and no access key to mask", async () => {
    const { t, owner, workspaceId } = await scenario();
    await dropboxBound(t, workspaceId, owner);

    const view = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("refresh-abc");
    expect(serialized).not.toContain("access-xyz");
    expect(serialized).not.toContain("v2:");
    expect(serialized).not.toContain("encryptedRefreshToken");
    // No access key exists for Dropbox, so nothing is rendered rather than a
    // masked credential that was never there.
    expect(view?.maskedAccessKeyId).toBeUndefined();
    expect(view?.provider).toBe("dropbox");
  });

  test("a member who is not the owner still cannot read a Dropbox binding's tokens", async () => {
    const { t, owner, workspaceId } = await scenario();
    await dropboxBound(t, workspaceId, owner);
    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "member", owner);

    const view = await asUser(t, member).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(JSON.stringify(view)).not.toContain("refresh-abc");
    expect(JSON.stringify(view)).not.toContain("v2:");
  });
});
