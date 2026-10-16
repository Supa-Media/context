import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";

/**
 * FINISHING ACCOUNT SETUP (functions/accountSetup.ts).
 *
 * A person who joined through their domain has no workspace of their own. The
 * app asks for their name once and makes them a personal workspace from it.
 * Only the signed-in person's own setup is ever read, and the name they give
 * must not claim a reserved name or somebody else's slug.
 */

const mySetup = (t: TestConvex, userId: Id<"users">) =>
  asUser(t, userId).query(api.functions.accountSetup.mySetup, {});

const finish = (t: TestConvex, userId: Id<"users">, name: string) =>
  asUser(t, userId).mutation(api.functions.accountSetup.finishSetup, { name });

/** An owner opens a shared workspace to the domain, and `kayla` joins through it. */
async function domainJoiner(t: TestConvex) {
  const seyi = await createUser(t, "seyi@publicworship.life");
  const team = await createWorkspace(t, seyi, "pw", { kind: "shared" });
  await asUser(t, seyi).mutation(api.functions.workspaceDomains.addWorkspaceDomain, {
    workspaceId: team,
    domain: "publicworship.life",
  });
  const kayla = await createUser(t, "kayla.ortiz@publicworship.life");
  await asUser(t, kayla).mutation(api.functions.workspaceDomains.joinWithDomain, { slug: "pw" });
  return { seyi, kayla, team };
}

describe("mySetup", () => {
  test("needs setup: a domain-joined person with no personal workspace", async () => {
    const t = setupTest();
    const { kayla } = await domainJoiner(t);
    expect(await mySetup(t, kayla)).toEqual({
      needsSetup: true,
      email: "kayla.ortiz@publicworship.life",
      suggestedName: "Kayla Ortiz",
    });
  });

  test("a normal person, who never joined through a domain, does not need setup", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@home.example");
    expect(await mySetup(t, ada)).toEqual({
      needsSetup: false,
      email: "ada@home.example",
      suggestedName: "Ada",
    });
  });

  test("signed out reads as null", async () => {
    const t = setupTest();
    expect(await t.query(api.functions.accountSetup.mySetup, {})).toBeNull();
  });

  test("does not need setup after finishing it", async () => {
    const t = setupTest();
    const { kayla } = await domainJoiner(t);
    await finish(t, kayla, "Kayla Ortiz");
    expect((await mySetup(t, kayla))?.needsSetup).toBe(false);
  });

  test("reads only the caller's own setup, never another person's", async () => {
    const t = setupTest();
    const { seyi, kayla } = await domainJoiner(t);
    const seen = await mySetup(t, seyi);
    expect(seen?.email).toBe("seyi@publicworship.life");
    expect(seen?.suggestedName).toBe("Seyi");
    expect(seen?.needsSetup).toBe(false);
    expect((await mySetup(t, kayla))?.email).toBe("kayla.ortiz@publicworship.life");
  });

  test("the name the account already has is suggested first", async () => {
    const t = setupTest();
    const { kayla } = await domainJoiner(t);
    await t.run((ctx) => ctx.db.patch(kayla, { name: "K. Ortiz" }));
    expect((await mySetup(t, kayla))?.suggestedName).toBe("K. Ortiz");
  });
});

describe("finishSetup", () => {
  test("creates a personal workspace named for the person, and sets their name", async () => {
    const t = setupTest();
    const { kayla } = await domainJoiner(t);
    expect(await finish(t, kayla, "  Kayla Ortiz  ")).toEqual({ slug: "kayla-ortiz" });
    const user = await t.run((ctx) => ctx.db.get(kayla));
    expect(user?.name).toBe("Kayla Ortiz");
    const mine = await t.run(async (ctx) =>
      (await ctx.db.query("workspaces").collect()).find((w) => w.slug === "kayla-ortiz"),
    );
    expect(mine).toMatchObject({ kind: "personal", displayName: "Kayla Ortiz", createdBy: kayla });
  });

  test("twice gives the same slug, and creates nothing the second time", async () => {
    const t = setupTest();
    const { kayla } = await domainJoiner(t);
    const first = await finish(t, kayla, "Kayla Ortiz");
    const second = await finish(t, kayla, "Kayla Ortiz");
    expect(second).toEqual(first);
    const owned = await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_user", (q) => q.eq("userId", kayla))
        .collect(),
    );
    expect(owned.filter((m) => m.role === "owner")).toHaveLength(1);
  });

  test("a reserved name never claims its slug", async () => {
    const t = setupTest();
    const { kayla } = await domainJoiner(t);
    expect(await finish(t, kayla, "Admin")).toEqual({ slug: "admin-2" });
  });

  test("a brain name never claims the reserved slug", async () => {
    const t = setupTest();
    const { kayla } = await domainJoiner(t);
    const { slug } = await finish(t, kayla, "Brain");
    expect(slug).not.toBe("brain");
    expect(slug).toBe("brain-2");
  });

  test("a taken slug gets -2", async () => {
    const t = setupTest();
    const { kayla } = await domainJoiner(t);
    const other = await createUser(t, "someone@home.example");
    await createWorkspace(t, other, "kayla-ortiz", { kind: "personal" });
    expect(await finish(t, kayla, "Kayla Ortiz")).toEqual({ slug: "kayla-ortiz-2" });
  });

  test("a name with nothing usable in it still gets a valid slug", async () => {
    const t = setupTest();
    const { kayla } = await domainJoiner(t);
    expect(await finish(t, kayla, "!!!")).toEqual({ slug: "person" });
  });

  test("a name outside 1..80 characters is refused as INVALID", async () => {
    const t = setupTest();
    const { kayla } = await domainJoiner(t);
    expect(errorCode(await captureError(() => finish(t, kayla, "   ")))).toBe("INVALID");
    expect(errorCode(await captureError(() => finish(t, kayla, "k".repeat(81))))).toBe("INVALID");
    expect((await mySetup(t, kayla))?.needsSetup).toBe(true);
  });

  test("needs a signed-in person", async () => {
    const t = setupTest();
    expect(errorCode(await captureError(() => t.mutation(api.functions.accountSetup.finishSetup, { name: "X" })))).toBeDefined();
  });

  test("never touches another person's workspace", async () => {
    const t = setupTest();
    const { seyi, kayla, team } = await domainJoiner(t);
    await finish(t, kayla, "Kayla Ortiz");
    const seyisOwner = await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", team).eq("userId", seyi))
        .first(),
    );
    expect(seyisOwner?.role).toBe("owner");
  });
});
