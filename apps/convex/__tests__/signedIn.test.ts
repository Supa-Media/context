/**
 * Signing out ends the token's use at once (`functions/lib/signedIn.ts`).
 *
 * `@convex-dev/auth` trusts the JWT's subject, so before this a token issued
 * to a session that was then signed out kept reading and writing for the rest
 * of its hour. Every Convex function now takes the person from `signedIn`,
 * which checks the session row: in a query or mutation directly, in an action
 * through `liveSession.isLive` under the same identity.
 *
 * Sabotage (temporary local edits, reverted): returning `userId` straight
 * after `userIdFromToken` fails every "signed out" case below; skipping the
 * `session.userId` comparison in `liveSessionOf` fails "another person's
 * session"; importing `getAuthUserId` from "@convex-dev/auth/server" in
 * `functions/appearance.ts` fails the import guard; so does importing
 * `requireAuthId` from "@supa-media/convex/auth", whose wrapper trusts the
 * subject the same way (it is how `setMyAppearance` kept writing after
 * sign-out until it moved here). A subject with no session part, or one
 * naming a row of another table, answers null rather than throwing.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { signOutSession } from "../functions/lib/emailProof";
import { tester, user, type T } from "./noteIds/noteIds.helpers";

const HOUR = 60 * 60 * 1000;

async function session(t: T, userId: Id<"users">, expiresIn = HOUR): Promise<Id<"authSessions">> {
  return await t.run(async (ctx) => await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + expiresIn }));
}

function token(t: T, userId: Id<"users">, sessionId: Id<"authSessions">) {
  return t.withIdentity({ subject: `${userId}|${sessionId}` });
}

async function chosenAppearance(t: T, userId: Id<"users">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("appearancePreferences", { userId, appearance: "dark", updatedAt: Date.now() } as never);
  });
}

async function phoneLinkError(as: ReturnType<T["withIdentity"]>): Promise<string> {
  try {
    await as.action(api.functions.textLinks.startPhoneLink, { phone: "not a phone" });
    return "none";
  } catch (error) {
    return (error as { data?: { code?: string } }).data?.code ?? String(error);
  }
}

describe("a token whose session was signed out", () => {
  test("a query answers as if signed out", async () => {
    const t = tester();
    const person = await user(t, "a@example.test");
    await chosenAppearance(t, person);
    const sessionId = await session(t, person);
    const as = token(t, person, sessionId);
    expect(await as.query(api.functions.appearance.myAppearance, {})).toMatchObject({ appearance: "dark" });
    await t.run(async (ctx) => await signOutSession(ctx, sessionId));
    expect(await as.query(api.functions.appearance.myAppearance, {})).toBeNull();
  });

  test("a mutation refuses", async () => {
    const t = tester();
    const person = await user(t, "a@example.test");
    const sessionId = await session(t, person);
    const as = token(t, person, sessionId);
    await as.mutation(api.functions.appearance.setMyAppearance, { appearance: "light" });
    await t.run(async (ctx) => await signOutSession(ctx, sessionId));
    await expect(as.mutation(api.functions.appearance.setMyAppearance, { appearance: "dark" })).rejects.toThrow();
    const rows = await t.run((ctx) => ctx.db.query("appearancePreferences").collect());
    expect(rows.map((row) => row.appearance)).toEqual(["light"]);
  });

  test("an action refuses, through the internal session check", async () => {
    const t = tester();
    const person = await user(t, "a@example.test");
    const sessionId = await session(t, person);
    const as = token(t, person, sessionId);
    expect(await phoneLinkError(as)).toBe("INVALID_ARGUMENT");
    await t.run(async (ctx) => await signOutSession(ctx, sessionId));
    expect(await phoneLinkError(as)).toBe("NOT_AUTHENTICATED");
  });

  test("an expired session counts as signed out", async () => {
    const t = tester();
    const person = await user(t, "a@example.test");
    await chosenAppearance(t, person);
    const as = token(t, person, await session(t, person, -1));
    expect(await as.query(api.functions.appearance.myAppearance, {})).toBeNull();
    expect(await phoneLinkError(as)).toBe("NOT_AUTHENTICATED");
  });

  test("another person's session does not sign anybody in", async () => {
    const t = tester();
    const victim = await user(t, "victim@example.test");
    const other = await user(t, "other@example.test");
    await chosenAppearance(t, victim);
    const as = token(t, victim, await session(t, other));
    expect(await as.query(api.functions.appearance.myAppearance, {})).toBeNull();
    expect(await as.query(internal.functions.liveSession.isLive, {})).toBe(false);
  });

  test("a token naming something that is not a session is signed out", async () => {
    const t = tester();
    const person = await user(t, "a@example.test");
    await chosenAppearance(t, person);
    const as = t.withIdentity({ subject: `${person}|${person}` });
    expect(await as.query(api.functions.appearance.myAppearance, {})).toBeNull();
    expect(await phoneLinkError(as)).toBe("NOT_AUTHENTICATED");
  });

  test("a token naming no session is signed out", async () => {
    const t = tester();
    const person = await user(t, "a@example.test");
    await chosenAppearance(t, person);
    const as = t.withIdentity({ subject: person });
    expect(await as.query(api.functions.appearance.myAppearance, {})).toBeNull();
    expect(await phoneLinkError(as)).toBe("NOT_AUTHENTICATED");
  });
});

describe("every function takes the person from signedIn", () => {
  /** The checked helper itself, its action-side query, and the session lookup it is built on. */
  const ALLOWED = new Set(["functions/lib/signedIn.ts", "functions/liveSession.ts", "functions/lib/emailProof.ts"]);
  const root = join(__dirname, "..");
  /** The library's own, which trusts the token's subject, and the framework's wrapper around it. */
  const UNCHECKED = [
    /import[^;]*\bgetAuthUserId\b[^;]*from\s+["']@convex-dev\/auth\/server["']/s,
    /import[^;]*\b(requireAuthId|getAuthUserId|getCurrentUser)\b[^;]*from\s+["']@supa-media\/convex(\/auth)?["']/s,
  ];

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  test("no other module imports an unchecked getAuthUserId or requireAuthId", () => {
    const offenders = sources(join(root, "functions"))
      .map((path) => relative(root, path))
      .filter((path) => !ALLOWED.has(path))
      .filter((path) => UNCHECKED.some((pattern) => pattern.test(readFileSync(join(root, path), "utf8"))));
    expect(offenders).toEqual([]);
  });

  test("the guard sees an import when there is one", () => {
    expect(UNCHECKED[0].test(`import { getAuthUserId } from "@convex-dev/auth/server";`)).toBe(true);
    expect(UNCHECKED[1].test(`import {\n  MAGIC_LINK_PROVIDER_ID,\n  requireAuthId,\n} from "@supa-media/convex/auth";`)).toBe(true);
    expect(UNCHECKED[1].test(`import { MAGIC_LINK_PROVIDER_ID } from "@supa-media/convex/auth";`)).toBe(false);
    expect(sources(join(root, "functions")).length).toBeGreaterThan(100);
  });
});
