import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, createUser, createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";
import { FRESH_SIGNUP_WINDOW_MS } from "../functions/lib/freshSignup";

/**
 * NUMBER FIRST, THEN THE PERSONAL GMAIL (Dev, 2026-10-20).
 *
 * Somebody who signed up through a work domain connects their personal Gmail
 * right after setup makes their own workspace. Google proving the address
 * stands in for the mailed code, the way it does for an account a phone made,
 * but only inside the window a typed address needs no proof either, never for
 * an address at the domain they joined through, and never over the work
 * address: it is added beside it.
 */

afterEach(() => vi.useRealTimers());

async function domainJoiner(t: TestConvex): Promise<Id<"users">> {
  const seyi = await createUser(t, "seyi@publicworship.life");
  const team = await createWorkspace(t, seyi, "pw", { kind: "shared" });
  await asUser(t, seyi).mutation(api.functions.workspaceDomains.addWorkspaceDomain, {
    workspaceId: team,
    domain: "publicworship.life",
  });
  const tobi = await createUser(t, "tobi@publicworship.life");
  await asUser(t, tobi).mutation(api.functions.workspaceDomains.joinWithDomain, { slug: "pw" });
  return tobi;
}

const adopt = (t: TestConvex, userId: Id<"users">, email: string) =>
  t.mutation(internal.functions.signInEmails.adoptGoogleAddress, { userId, email });

const attached = (t: TestConvex, userId: Id<"users">) =>
  t.run(async (ctx) =>
    (await ctx.db.query("signInEmails").withIndex("by_user", (q) => q.eq("userId", userId)).collect()).map((row) => row.email),
  );

describe("a domain sign-up's personal Gmail", () => {
  test("is added beside the work address, which stays the main one", async () => {
    const t = setupTest();
    const tobi = await domainJoiner(t);
    expect(await adopt(t, tobi, "Tobi.Ade@Gmail.com")).toBe("added");
    expect(await attached(t, tobi)).toEqual(["tobi.ade@gmail.com"]);
    expect((await t.run((ctx) => ctx.db.get(tobi)))?.email).toBe("tobi@publicworship.life");
  });

  test("is not taken when it is an address at the domain they joined through", async () => {
    const t = setupTest();
    const tobi = await domainJoiner(t);
    expect(await adopt(t, tobi, "tobi.music@publicworship.life")).toBe("skipped");
    expect(await attached(t, tobi)).toEqual([]);
  });

  test("is not taken once a personal email is there", async () => {
    const t = setupTest();
    const tobi = await domainJoiner(t);
    await adopt(t, tobi, "tobi.ade@gmail.com");
    expect(await adopt(t, tobi, "tobi.other@gmail.com")).toBe("skipped");
    expect(await attached(t, tobi)).toEqual(["tobi.ade@gmail.com"]);
  });

  test("is not taken without proof after the sign-up window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = setupTest();
    const tobi = await domainJoiner(t);
    vi.setSystemTime(Date.now() + FRESH_SIGNUP_WINDOW_MS + 60_000);
    expect(await adopt(t, tobi, "tobi.ade@gmail.com")).toBe("skipped");
    expect(await attached(t, tobi)).toEqual([]);
  });

  test("is not taken for an account that never joined through a domain", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    expect(await adopt(t, ada, "ada.lovelace@gmail.com")).toBe("skipped");
    expect(await attached(t, ada)).toEqual([]);
  });
});
