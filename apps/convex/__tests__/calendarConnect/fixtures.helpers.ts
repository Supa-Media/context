/**
 * Attaching Calendar as a product on the shared Google connection.
 *
 * Same shape as `googleConnect.test.ts` and the same reason: every control
 * here — the flag, the personal-context-only rule, the redirect pin,
 * single-use attempt consumption — could be deleted with the rest of the
 * suite green unless a test names the sabotage it catches. This file adds
 * only what `calendarConnect.ts` adds on top: no new table, a second flag
 * with its own gate, and the scope-union fix.
 *
 * **The one thing this file exists to prove, twice, at two different
 * layers**: adding Calendar to an account that already has Gmail must not
 * silently drop Gmail's access. `describe("the scope-union fix")` proves the
 * *request* asks for both (the half this module's own code controls);
 * `describe("the row shape")`'s reconnect tests prove the *binding* never
 * writes a stale slice for a product this bind was not about, in either
 * direction — the same "two views of one fact, never two facts" rule
 * `googleConnect.test.ts` already holds `applyGmailConnectionBinding` to,
 * applied here to `applyCalendarConnectionBinding` as well.
 */

import { afterEach, vi } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  createUser,
  createWorkspace,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";

export const APP = "https://app.context.invalid";
export const REDIRECT = `${APP}/calendar/google/callback`;
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

afterEach(() => {
  vi.unstubAllEnvs();
});

export function enableCalendarConnect() {
  vi.stubEnv("CALENDAR_CONNECT_ENABLED", "true");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
}

/** Gmail's own flag, for the fixture that needs a real Gmail bind alongside Calendar's flow. */
export function enableMailConnect() {
  vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
}

export async function personalScenario() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  return { t, owner, workspaceId };
}

export async function sharedScenario() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas-team", { kind: "shared" });
  return { t, owner, workspaceId };
}

/** Standard args for `applyGmailConnectionBinding`, mirroring `googleConnect.test.ts`'s own helper. */
export function gmailBindingArgs(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    address: "person@example.invalid",
    mailboxSlug: "person-at-example-invalid",
    googleAccountId: "google-1",
    scopes: [GMAIL_SCOPE],
    backfillDays: 90,
    folders: ["inbox", "sent"] as ("inbox" | "sent")[],
    attachmentMode: "store" as const,
    attachmentRetentionDays: 90,
    accessTokenExpiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

/** Bind a Gmail connection directly — no network, exactly like `googleConnect.test.ts`'s own fixtures. */
export async function bindGmail(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  boundBy: Id<"users">,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const keyset = requireKeyset();
  const context = { workspaceId: workspaceId as string };
  await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
    workspaceId,
    boundBy,
    ...gmailBindingArgs(overrides),
    encryptedRefreshToken: await encryptSecret("refresh-gmail", keyset, context),
    encryptedAccessToken: await encryptSecret("access-gmail", keyset, context),
  });
}

export async function connectionRow(t: TestConvex, workspaceId: Id<"workspaces">, address: string) {
  return t.run((ctx) =>
    ctx.db
      .query("googleConnections")
      .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
      .unique(),
  );
}

/** Standard args for `applyCalendarConnectionBinding`. */
export function calendarBindingArgs(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    address: "person@example.invalid",
    googleAccountId: "google-1",
    scopes: [CALENDAR_SCOPE],
    accessTokenExpiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

export async function bindCalendar(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  boundBy: Id<"users">,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const keyset = requireKeyset();
  const context = { workspaceId: workspaceId as string };
  await t.mutation(internal.functions.calendarConnect.applyCalendarConnectionBinding, {
    workspaceId,
    boundBy,
    ...calendarBindingArgs(overrides),
    encryptedRefreshToken: await encryptSecret("refresh-calendar", keyset, context),
    encryptedAccessToken: await encryptSecret("access-calendar", keyset, context),
  });
}

