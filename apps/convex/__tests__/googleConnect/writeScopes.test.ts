/**
 * Every Google connect asks for the write scopes of the products it connects
 * (`WRITE_SCOPES` in `lib/googleOAuth.ts`; the owner, 2026-10-23, reversing
 * the testers-only rule after a texter's connected calendar refused Tex).
 *
 * Sabotage record (applied, run, observed failing, reverted):
 *  1. `scopesForConnect` skipping `WRITE_SCOPES` → "a person who is not staff
 *     is asked for every write scope of what they connect" fails.
 *  2. Adding `CALENDAR_WRITE_SCOPE` to `WRITE_SCOPES.gmail` → "a write scope
 *     comes only with its own product" fails.
 */

import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import { asUser } from "../fixtures.helpers";
import { CALENDAR_WRITE_SCOPE, CHAT_SEND_SCOPE, GMAIL_COMPOSE_SCOPE, GMAIL_SEND_SCOPE, scopesForConnect } from "../../functions/lib/googleOAuth";
import { REDIRECT, enableAllGoogleConnect, personalScenario } from "./fixtures.helpers";

async function askedScopes(): Promise<Set<string>> {
  enableAllGoogleConnect();
  const { t, owner, workspaceId } = await personalScenario();
  const result = await asUser(t, owner).action(api.functions.googleConnect.startGoogleConnect, {
    workspaceId,
    redirectUri: REDIRECT,
    syncServices: { gmail: true, calendar: true, chat: false },
  });
  return new Set(new URL(result.authorizeUrl).searchParams.get("scope")?.split(" ") ?? []);
}

describe("Google write scopes", () => {
  test("a person who is not staff is asked for every write scope of what they connect", async () => {
    const scopes = await askedScopes();
    expect(scopes).toContain(GMAIL_SEND_SCOPE);
    expect(scopes).toContain(GMAIL_COMPOSE_SCOPE);
    expect(scopes).toContain(CHAT_SEND_SCOPE);
    expect(scopes).toContain(CALENDAR_WRITE_SCOPE);
  });

  test("a write scope comes only with its own product", () => {
    expect(scopesForConnect(["calendar"])).toContain(CALENDAR_WRITE_SCOPE);
    expect(scopesForConnect(["calendar"])).not.toContain(GMAIL_SEND_SCOPE);
    expect(scopesForConnect(["calendar"])).not.toContain(GMAIL_COMPOSE_SCOPE);
    expect(scopesForConnect(["gmail"])).not.toContain(CALENDAR_WRITE_SCOPE);
    expect(scopesForConnect(["chat"]).some((scope) => scope === GMAIL_SEND_SCOPE || scope === CALENDAR_WRITE_SCOPE)).toBe(false);
  });
});
