import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  asPhoneOnly,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedStorageBinding,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";
import { EMAIL_PROOF_WINDOW_MS } from "../functions/lib/emailProof";
import { MAX_WRONG_TRIES } from "../functions/emailProof";

/**
 * YOUR PHONE OPENS CONTEXT; YOUR EMAIL GUARDS IT (Dev2, 2026-10-12, boards k1-k2).
 *
 * A texted code is a full sign-in, so a SIM swap must not be enough to take an
 * account. What must hold: a code goes only to an email already confirmed on
 * the account; typing it back proves only the session that asked, for fifteen
 * minutes; and every big change refuses a session that has not proven itself.
 * The refusals below each start from a device signed in with only a texted
 * code (`asPhoneOnly`); `asUser` is a person who has proven their email.
 */

const CODE = "135790";
const PROOF = "EMAIL_PROOF_REQUIRED";

afterEach(() => vi.useRealTimers());

type View = Awaited<ReturnType<typeof asPhoneOnly>>["view"];

/** Ask for a code from `view`'s session, then plant a known one in its place. */
async function askForCode(t: TestConvex, view: View, sessionId: Id<"authSessions">, to?: number) {
  const started = await view.action(api.functions.emailProof.startEmailProof, to === undefined ? {} : { to });
  if (started.status === "sent") {
    const hashed = await hashToken(CODE);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("emailProofCodes")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .first();
      await ctx.db.patch(row!._id, { hashedCode: hashed });
    });
  }
  return started;
}

async function prove(t: TestConvex, userId: Id<"users">) {
  const phone = await asPhoneOnly(t, userId);
  expect((await askForCode(t, phone.view, phone.sessionId)).status).toBe("sent");
  expect(await phone.view.action(api.functions.emailProof.confirmEmailProof, { code: CODE })).toEqual({ status: "confirmed" });
  return phone;
}

describe("the code", () => {
  test("goes to an email already on the account, masked in the answer, and proves the session", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const phone = await asPhoneOnly(t, ada);
    expect(await phone.view.query(api.functions.emailProof.myEmailProof, {})).toEqual({
      proven: false,
      emails: ["a•••@home.example"],
    });
    expect(await askForCode(t, phone.view, phone.sessionId)).toEqual({ status: "sent", sentTo: "a•••@home.example" });
    const row = await t.run((ctx) => ctx.db.query("emailProofCodes").first());
    expect(row!.email).toBe("ada@home.example");
    expect(row!.hashedCode).not.toContain(CODE);
    expect(await phone.view.action(api.functions.emailProof.confirmEmailProof, { code: CODE })).toEqual({ status: "confirmed" });
    expect((await phone.view.query(api.functions.emailProof.myEmailProof, {})).proven).toBe(true);
  });

  test("an account with no email has nowhere to send one", async () => {
    const t = setupTest();
    const phoneMade = await t.run((ctx) =>
      ctx.db.insert("users", { phone: "+15555550111", phoneVerificationTime: Date.now(), createdAt: Date.now() }),
    );
    const phone = await asPhoneOnly(t, phoneMade);
    expect(await phone.view.action(api.functions.emailProof.startEmailProof, {})).toEqual({ status: "no_email" });
  });

  test("only to the account's own addresses: an index past the list sends nothing", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const phone = await asPhoneOnly(t, ada);
    expect(await phone.view.action(api.functions.emailProof.startEmailProof, { to: 1 })).toEqual({ status: "no_email" });
    expect(await t.run((ctx) => ctx.db.query("emailProofCodes").collect())).toEqual([]);
  });

  test("proves only the session that asked: another phone-only device gets nothing from it", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    await prove(t, ada);
    const thief = await asPhoneOnly(t, ada);
    expect((await thief.view.query(api.functions.emailProof.myEmailProof, {})).proven).toBe(false);
    expect(errorCode(await captureError(() => thief.view.mutation(api.functions.account.deleteAccount, {})))).toBe(PROOF);
  });

  test("a code typed into another session proves nothing", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const mine = await asPhoneOnly(t, ada);
    await askForCode(t, mine.view, mine.sessionId);
    const thief = await asPhoneOnly(t, ada);
    expect(await thief.view.action(api.functions.emailProof.confirmEmailProof, { code: CODE })).toEqual({ status: "expired" });
    expect((await thief.view.query(api.functions.emailProof.myEmailProof, {})).proven).toBe(false);
  });

  test("lasts fifteen minutes", async () => {
    vi.useFakeTimers();
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const phone = await prove(t, ada);
    vi.advanceTimersByTime(EMAIL_PROOF_WINDOW_MS - 1000);
    expect((await phone.view.query(api.functions.emailProof.myEmailProof, {})).proven).toBe(true);
    vi.advanceTimersByTime(2000);
    expect((await phone.view.query(api.functions.emailProof.myEmailProof, {})).proven).toBe(false);
  });

  test("wrong codes count, and enough of them kill the code", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const phone = await asPhoneOnly(t, ada);
    await askForCode(t, phone.view, phone.sessionId);
    for (let i = 0; i < MAX_WRONG_TRIES; i++) {
      expect(await phone.view.action(api.functions.emailProof.confirmEmailProof, { code: "000000" })).toEqual({ status: "wrong" });
    }
    expect(await phone.view.action(api.functions.emailProof.confirmEmailProof, { code: CODE })).toEqual({ status: "expired" });
  });

  test("a signed-out session's proof is worthless, even with its token still unexpired", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const phone = await prove(t, ada);
    await t.run((ctx) => ctx.db.delete(phone.sessionId));
    expect((await phone.view.query(api.functions.emailProof.myEmailProof, {})).proven).toBe(false);
  });

  test("is rate limited per person", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const phone = await asPhoneOnly(t, ada);
    for (let i = 0; i < 5; i++) expect((await askForCode(t, phone.view, phone.sessionId)).status).toBe("sent");
    expect((await askForCode(t, phone.view, phone.sessionId)).status).toBe("too_many");
  });
});

describe("a device signed in with only a texted code cannot", () => {
  test("delete the account", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const { view } = await asPhoneOnly(t, ada);
    expect(errorCode(await captureError(() => view.mutation(api.functions.account.deleteAccount, {})))).toBe(PROOF);
    expect(await t.run((ctx) => ctx.db.get(ada))).not.toBeNull();
  });

  test("delete a workspace", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const ws = await createWorkspace(t, ada, "ada-team", { kind: "shared" });
    const { view } = await asPhoneOnly(t, ada);
    expect(
      errorCode(await captureError(() => view.mutation(api.functions.account.deleteWorkspace, { workspaceId: ws, confirmSlug: "ada-team" }))),
    ).toBe(PROOF);
    expect(await t.run((ctx) => ctx.db.get(ws))).not.toBeNull();
  });

  test("remove an email, or switch which one gets mail", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    await t.run((ctx) => ctx.db.insert("signInEmails", { userId: ada, email: "ada@work.example", addedAt: Date.now() }));
    const { view } = await asPhoneOnly(t, ada);
    expect(errorCode(await captureError(() => view.mutation(api.functions.signInEmails.removeEmail, { email: "ada@work.example" })))).toBe(PROOF);
    expect(errorCode(await captureError(() => view.mutation(api.functions.signInEmails.setMailEmail, { email: "ada@work.example" })))).toBe(PROOF);
  });

  test("add an email once the account has one", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const { view } = await asPhoneOnly(t, ada);
    expect(errorCode(await captureError(() => view.action(api.functions.signInEmails.startAddEmail, { email: "thief@evil.example" })))).toBe(PROOF);
    expect(await t.run((ctx) => ctx.db.query("signInEmailCodes").collect())).toEqual([]);
  });

  test("move notes to other storage, rebind it, or disconnect it", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const ws = await createWorkspace(t, ada, "ada");
    await seedStorageBinding(t, { workspaceId: ws, boundBy: ada });
    const { view } = await asPhoneOnly(t, ada);
    const target = {
      workspaceId: ws,
      provider: "r2" as const,
      endpoint: "https://fake-account.r2.cloudflarestorage.com",
      region: "auto",
      bucket: "thief-bucket",
      accessKeyId: "AKIAFAKE",
      secretAccessKey: "fake-secret",
    };
    expect(errorCode(await captureError(() => view.action(api.functions.storage.bindStorage, target)))).toBe(PROOF);
    expect(errorCode(await captureError(() => view.action(api.functions.storage.startStorageMove, target as never)))).toBe(PROOF);
    expect(errorCode(await captureError(() => view.action(api.functions.storage.startManagedStorageHandoff, target as never)))).toBe(PROOF);
    expect(errorCode(await captureError(() => view.mutation(api.functions.storage.disconnectStorage, { workspaceId: ws })))).toBe(PROOF);
    expect(
      errorCode(await captureError(() => view.action(api.functions.encryptionKeys.exportEncryptionKeys, { workspaceId: ws }))),
    ).toBe(PROOF);
    const binding = await t.run((ctx) => ctx.db.query("storageBindings").first());
    expect(binding!.bucket).not.toBe("thief-bucket");
  });

  test("connect a new AI app, a desktop machine, or a plugin", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const ws = await createWorkspace(t, ada, "ada");
    const { view } = await asPhoneOnly(t, ada);
    expect(errorCode(await captureError(() => view.action(api.functions.authorizations.approveAuthorization, { requestId: "any" })))).toBe(PROOF);
    expect(errorCode(await captureError(() => view.action(api.functions.authorizations.approveOwnMachineGrant, { requestId: "any" })))).toBe(PROOF);
    expect(
      errorCode(
        await captureError(() =>
          view.action(api.functions.obsidianPlugins.approvePlugin, {
            workspaceId: ws,
            pluginId: "any",
            bundleFingerprint: "any",
            capabilities: [],
            networkHosts: [],
          }),
        ),
      ),
    ).toBe(PROOF);
  });

  test("link a different phone for texting, which would then sign in too", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    await createWorkspace(t, ada, "ada");
    await t.run((ctx) => ctx.db.patch(ada, { phone: "+15555550100", phoneVerificationTime: Date.now() }));
    const { view } = await asPhoneOnly(t, ada);
    expect(errorCode(await captureError(() => view.action(api.functions.textLinks.startPhoneLink, { phone: "+15555550199" })))).toBe(PROOF);
    // Its own phone needs nothing more: the texted code already proved it.
    expect((await view.action(api.functions.textLinks.startPhoneLink, { phone: "+15555550100" })).code).toMatch(/\S/);
  });

  test("sign other devices out", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const mine = await prove(t, ada);
    const { view } = await asPhoneOnly(t, ada);
    expect(errorCode(await captureError(() => view.mutation(api.functions.emailProof.signOutOthers, {})))).toBe(PROOF);
    expect(await t.run((ctx) => ctx.db.get(mine.sessionId))).not.toBeNull();
  });
});

describe("what a phone alone still does", () => {
  test("adds the very first email, the one an account made by a phone is asked for", async () => {
    const t = setupTest();
    const phoneMade = await t.run((ctx) =>
      ctx.db.insert("users", { phone: "+15555550111", phoneVerificationTime: Date.now(), createdAt: Date.now() }),
    );
    const { view } = await asPhoneOnly(t, phoneMade);
    expect((await view.action(api.functions.signInEmails.startAddEmail, { email: "new@home.example" })).status).toBe("sent");
  });

  test("binds storage to a workspace that has none yet", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const ws = await createWorkspace(t, ada, "ada");
    const { view } = await asPhoneOnly(t, ada);
    const error = await view
      .action(api.functions.storage.bindStorage, {
        workspaceId: ws,
        provider: "r2",
        endpoint: "https://fake-account.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "ada-notes",
        accessKeyId: "AKIAFAKE",
        secretAccessKey: "fake-secret",
      })
      .then(() => null, (e: unknown) => e);
    expect(errorCode(error)).not.toBe(PROOF);
  });
});

describe("after the code", () => {
  test("the same device may make the change", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const { view } = await prove(t, ada);
    expect(await view.mutation(api.functions.account.deleteAccount, {})).toEqual({ deleted: true });
  });

  test("signing out every other device keeps this one and drops the rest", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const thief = await asPhoneOnly(t, ada);
    const mine = await prove(t, ada);
    expect(await mine.view.mutation(api.functions.emailProof.signOutOthers, {})).toEqual({ signedOut: 1 });
    expect(await t.run((ctx) => ctx.db.get(thief.sessionId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(mine.sessionId))).not.toBeNull();
    const sessions = await mine.view.query(api.functions.emailProof.mySessions, {});
    expect(sessions.map((s) => s.current)).toEqual([true]);
  });

  test("signing out one device leaves the others, and never someone else's", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    const bob = await createUser(t, "bob@home.example");
    const bobs = await asPhoneOnly(t, bob);
    const other = await asPhoneOnly(t, ada);
    const mine = await prove(t, ada);
    expect(await mine.view.mutation(api.functions.emailProof.signOutOthers, { session: bobs.sessionId })).toEqual({ signedOut: 0 });
    expect(await mine.view.mutation(api.functions.emailProof.signOutOthers, { session: other.sessionId })).toEqual({ signedOut: 1 });
    expect(await t.run((ctx) => ctx.db.get(bobs.sessionId))).not.toBeNull();
  });

  test("an email removed after the code was mailed proves nothing", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    await t.run((ctx) => ctx.db.insert("signInEmails", { userId: ada, email: "ada@work.example", addedAt: Date.now() }));
    const phone = await asPhoneOnly(t, ada);
    expect((await askForCode(t, phone.view, phone.sessionId, 1)).sentTo).toBe("a•••@work.example");
    await asUser(t, ada).mutation(api.functions.signInEmails.removeEmail, { email: "ada@work.example" });
    expect(await phone.view.action(api.functions.emailProof.confirmEmailProof, { code: CODE })).toEqual({ status: "expired" });
  });
});
