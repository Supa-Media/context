/**
 * Google's write scopes are asked for only of testers until Google has
 * reviewed them (`TESTER_WRITE_SCOPES`, `lib/googleWriteTesters.ts`).
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `connectScopes` passing `true` for everyone → "a person who is not
 *     staff is asked for read scopes only" fails.
 *  2. `isGoogleWriteTester` ignoring `emailVerificationTime` → "an unverified
 *     staff address is not a tester" fails.
 */

import { describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { asUser } from "../fixtures.helpers";
import { CALENDAR_WRITE_SCOPE, GMAIL_COMPOSE_SCOPE, GMAIL_SEND_SCOPE, scopesForConnect } from "../../functions/lib/googleOAuth";
import { isGoogleWriteTester } from "../../functions/lib/googleWriteTesters";
import { REDIRECT, enableAllGoogleConnect, personalScenario } from "./fixtures.helpers";

async function askedScopes(staff: string | null): Promise<Set<string>> {
  enableAllGoogleConnect();
  if (staff !== null) vi.stubEnv("ADMIN_EMAILS", staff);
  const { t, owner, workspaceId } = await personalScenario();
  const result = await asUser(t, owner).action(api.functions.googleConnect.startGoogleConnect, {
    workspaceId,
    redirectUri: REDIRECT,
    syncServices: { gmail: true, calendar: true, chat: false },
  });
  return new Set(new URL(result.authorizeUrl).searchParams.get("scope")?.split(" ") ?? []);
}

describe("Google write scopes", () => {
  test("a person who is not staff is asked for read scopes only", async () => {
    const scopes = await askedScopes(null);
    expect(scopes).not.toContain(GMAIL_SEND_SCOPE);
    expect(scopes).not.toContain(GMAIL_COMPOSE_SCOPE);
    expect(scopes).not.toContain(CALENDAR_WRITE_SCOPE);
  });

  test("staff are asked for Gmail send, Gmail drafts and Calendar writes with the products they chose", async () => {
    const scopes = await askedScopes("owner@example.invalid");
    expect(scopes).toContain(GMAIL_SEND_SCOPE);
    expect(scopes).toContain(GMAIL_COMPOSE_SCOPE);
    expect(scopes).toContain(CALENDAR_WRITE_SCOPE);
  });

  test("a write scope comes only with its own product", () => {
    expect(scopesForConnect(["calendar"], true)).not.toContain(GMAIL_SEND_SCOPE);
    expect(scopesForConnect(["calendar"], true)).not.toContain(GMAIL_COMPOSE_SCOPE);
    expect(scopesForConnect(["gmail"], true)).not.toContain(CALENDAR_WRITE_SCOPE);
    expect(scopesForConnect(["chat"], true).some((scope) => scope === GMAIL_SEND_SCOPE || scope === CALENDAR_WRITE_SCOPE)).toBe(false);
  });

  test("an unverified staff address is not a tester", () => {
    const env = { ADMIN_EMAILS: "staff@example.invalid" };
    expect(isGoogleWriteTester({ email: "staff@example.invalid", emailVerificationTime: 1 }, env)).toBe(true);
    expect(isGoogleWriteTester({ email: "staff@example.invalid" }, env)).toBe(false);
    expect(isGoogleWriteTester({ email: "someone@example.invalid", emailVerificationTime: 1 }, env)).toBe(false);
    expect(isGoogleWriteTester(null, env)).toBe(false);
  });
});
