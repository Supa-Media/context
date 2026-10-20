import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, createUser, createWorkspace, seedGoogleConnection, setupTest, type TestConvex } from "./fixtures.helpers";

/**
 * GMAIL FIRST, AND TEX.LC FOR SOMEBODY SIGNED IN (Dev2, 2026-10-20).
 *
 *  - The first Gmail an account with no email connects becomes its main
 *    email, proven by Google rather than a mailed code; never a second one
 *    over an email it has, never an address another account owns.
 *  - `/text` reads the person's own Tex line, last four digits and whether
 *    they have ever texted Tex ("hi" typed for a first text), and nobody
 *    else's.
 *  - The texting Worker hears that the Gmail connected, and whether it is the
 *    main email, behind its secret.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `adoptGoogleAddress` not checking the account has no email          1
 *   `attachProvenEmail` moving with `mayMove: false`                     1
 *   `hasTextedTex` ignoring `textSetups`                                 1
 *   `connectedGmailsOf` counting a disconnected connection               2
 */

const PHONE = "+15555550100";
const LINE = "+15555550177";
const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** An account a phone made, set up by text: no email yet, a personal workspace. */
async function phoneAccount(t: TestConvex, phone = PHONE, slug = "ada") {
  const userId = await t.run((ctx) => ctx.db.insert("users", { phone, phoneVerificationTime: 1 }));
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  return { userId, workspaceId };
}

async function adopt(t: TestConvex, userId: Id<"users">, email: string) {
  return await t.mutation(internal.functions.signInEmails.adoptGoogleAddress, { userId, email });
}

describe("the first Gmail becomes the main email", () => {
  test("an account with no email takes the Gmail's address, lowercased, with no code mailed", async () => {
    const t = setupTest();
    const { userId } = await phoneAccount(t);
    expect(await adopt(t, userId, "Ada.Lovelace@Gmail.com")).toBe("added");
    const user = await t.run((ctx) => ctx.db.get(userId));
    expect(user?.email).toBe("ada.lovelace@gmail.com");
    expect(user?.emailVerificationTime).toBeTypeOf("number");
    expect(await t.run((ctx) => ctx.db.query("signInEmailCodes").collect())).toEqual([]);
  });

  test("never replaces or adds to an email the account already has", async () => {
    const t = setupTest();
    const userId = await createUser(t, "ada@home.example");
    expect(await adopt(t, userId, "ada.lovelace@gmail.com")).toBe("skipped");
    expect((await t.run((ctx) => ctx.db.get(userId)))?.email).toBe("ada@home.example");
    expect(await t.run((ctx) => ctx.db.query("signInEmails").collect())).toEqual([]);

    const typed = (await phoneAccount(t, "+15555550101", "bob")).userId;
    await t.run((ctx) => ctx.db.insert("signInEmails", { userId: typed, email: "bob@home.example", addedAt: 1 }));
    expect(await adopt(t, typed, "bob@gmail.com")).toBe("skipped");
    expect((await t.run((ctx) => ctx.db.get(typed)))?.email).toBeUndefined();
  });

  test("an address another account owns stays theirs, and nothing moves", async () => {
    const t = setupTest();
    const owner = await createUser(t, "ada.lovelace@gmail.com");
    await createWorkspace(t, owner, "ada-old", { kind: "personal" });
    const { userId, workspaceId } = await phoneAccount(t);
    expect(await adopt(t, userId, "ada.lovelace@gmail.com")).toBe("has_own_workspace");
    expect((await t.run((ctx) => ctx.db.get(userId)))?.email).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.get(owner))).not.toBeNull();
    // The phone account and its workspace are untouched.
    expect((await t.run((ctx) => ctx.db.get(userId)))?.phone).toBe(PHONE);
    expect(await t.run((ctx) => ctx.db.get(workspaceId))).not.toBeNull();
  });

  test("an empty phone account is never folded into the account that has the Gmail", async () => {
    const t = setupTest();
    const owner = await createUser(t, "ada.lovelace@gmail.com");
    await createWorkspace(t, owner, "ada-old", { kind: "personal" });
    const userId = await t.run((ctx) => ctx.db.insert("users", { phone: PHONE, phoneVerificationTime: 1 }));
    expect(await adopt(t, userId, "ada.lovelace@gmail.com")).toBe("has_own_workspace");
    expect(await t.run((ctx) => ctx.db.get(userId))).not.toBeNull();
    expect((await t.run((ctx) => ctx.db.get(owner)))?.phone).toBeUndefined();
  });

  test("something that is not an address is skipped", async () => {
    const t = setupTest();
    const { userId } = await phoneAccount(t);
    expect(await adopt(t, userId, "not an address")).toBe("skipped");
    expect((await t.run((ctx) => ctx.db.get(userId)))?.email).toBeUndefined();
  });
});

describe("texHome.mine", () => {
  test("is the person's own line, last four digits, Gmails and main email", async () => {
    vi.stubEnv("TEX_LINE_NUMBERS", LINE);
    const t = setupTest();
    const { userId, workspaceId } = await phoneAccount(t);
    await seedGoogleConnection(t, { workspaceId, boundBy: userId, address: "Ada.Lovelace@gmail.com" });
    await seedGoogleConnection(t, { workspaceId, boundBy: userId, address: "old@gmail.com", googleAccountId: "g2", disconnected: true });
    await adopt(t, userId, "ada.lovelace@gmail.com");
    expect(await asUser(t, userId).query(api.functions.texHome.mine, {})).toEqual({
      ending: "0100",
      line: LINE,
      firstText: true,
      mainEmail: "ada.lovelace@gmail.com",
      workspaceId,
      gmails: ["ada.lovelace@gmail.com"],
    });
  });

  test("a phone that has texted Tex, or that Tex is setting up, is not a first text", async () => {
    vi.stubEnv("TEX_LINE_NUMBERS", LINE);
    const t = setupTest();
    const linked = await phoneAccount(t);
    await t.run((ctx) => ctx.db.insert("phoneLinks", { userId: linked.userId, phone: PHONE, linkedAt: 1 }));
    expect((await asUser(t, linked.userId).query(api.functions.texHome.mine, {}))?.firstText).toBe(false);

    const asked = await phoneAccount(t, "+15555550101", "bob");
    await t.run((ctx) => ctx.db.insert("textSetups", { stage: "asked", phone: "+15555550101", at: 1 }));
    expect((await asUser(t, asked.userId).query(api.functions.texHome.mine, {}))?.firstText).toBe(false);
  });

  test("no line is named when none is configured, and signed out is null", async () => {
    const t = setupTest();
    const { userId } = await phoneAccount(t);
    expect((await asUser(t, userId).query(api.functions.texHome.mine, {}))?.line).toBeNull();
    expect(await t.query(api.functions.texHome.mine, {})).toBeNull();
  });
});

describe("POST /agent-texts/gmail", () => {
  async function ask(t: TestConvex, phone: string, secret: string | null = AGENT_SECRET) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret !== null) headers.Authorization = `Bearer ${secret}`;
    const response = await t.fetch("/agent-texts/gmail", { method: "POST", headers, body: JSON.stringify({ phone }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  test("waits, then says which Gmail connected and whether it is the main email", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await phoneAccount(t);
    await t.run((ctx) => ctx.db.insert("phoneLinks", { userId, phone: PHONE, linkedAt: 1 }));
    expect((await ask(t, PHONE)).body).toEqual({ status: "waiting" });

    await seedGoogleConnection(t, { workspaceId, boundBy: userId, address: "ada@work.example", disconnected: true });
    expect((await ask(t, PHONE)).body).toEqual({ status: "waiting" });

    await seedGoogleConnection(t, { workspaceId, boundBy: userId, address: "ada.lovelace@gmail.com", googleAccountId: "g2" });
    expect((await ask(t, PHONE)).body).toEqual({ status: "connected", address: "ada.lovelace@gmail.com", main: false });
    await adopt(t, userId, "ada.lovelace@gmail.com");
    expect((await ask(t, PHONE)).body).toEqual({ status: "connected", address: "ada.lovelace@gmail.com", main: true });
  });

  test("a phone nobody links is gone, and the route sits behind the Worker's secret", async () => {
    const t = setupTest();
    expect((await ask(t, PHONE)).body).toEqual({ status: "gone" });
    expect((await ask(t, PHONE, null)).status).toBe(401);
    expect((await ask(t, PHONE, "wrong-secret")).status).toBe(401);
  });
});
