/**
 * Attaching Google Chat as a product on the shared `googleConnections` row.
 *
 * Same shape as `googleConnect.test.ts`, restated rather than imported for the
 * same reason its own header gives: every control here — the flag, the
 * personal-context-only rule, the redirect pin, single-use attempt
 * consumption, the owner check on `setChatSpaceState`, and the row-shape
 * invariants — could be deleted with the rest of the suite green unless a
 * test names the sabotage it catches.
 *
 * The one control that is NEW here, not restated: adding Chat to an account
 * that already has Gmail must never leave Gmail's recorded scopes empty. See
 * "adding chat to a gmail-connected account" below.
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
import { encryptSecret, hashToken, requireKeyset } from "../../functions/lib/crypto";
import { CALENDAR_SCOPES, CHAT_SCOPES, GMAIL_SCOPES } from "../../functions/lib/googleOAuth";


export const APP = "https://app.context.invalid";
export const REDIRECT = `${APP}/chat/google/callback`;
export const GMAIL_SCOPE = GMAIL_SCOPES[0];
export const CHAT_MESSAGES_SCOPE = CHAT_SCOPES[0];
export const CHAT_SPACES_SCOPE = CHAT_SCOPES[1];
export const CALENDAR_SCOPE = CALENDAR_SCOPES[0];

afterEach(() => {
  vi.unstubAllEnvs();
});

export function enableMailConnect() {
  vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
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

/**
 * The secret a real starting browser keeps, and hands back at completion.
 * Any constant will do — what the tests are about is that a completion has to
 * present the one the attempt was parked with.
 */
export const COMPLETION = "chat-completion-secret-0123456789";

/** An attempt row, parked as `startChatConnect` would park it. */
export async function parkedAttempt(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  startedBy: Id<"users">,
  overrides: Record<string, unknown> = {},
) {
  const state = "chat-state-token-0123456789";
  const keyset = requireKeyset();
  const now = Date.now();
  await t.run(async (ctx) =>
    ctx.db.insert("googleConnectAttempts", {
      workspaceId,
      startedBy,
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(COMPLETION),
      encryptedVerifier: await encryptSecret("verifier-abc", keyset, {
        workspaceId: workspaceId as string,
      }),
      redirectUri: REDIRECT,
      products: ["chat"],
      expiresAt: now + 600_000,
      createdAt: now,
      ...overrides,
    }),
  );
  return state;
}

/** Standard args for `applyChatConnectionBinding`, so each test overrides only what it is about. */
export function chatBindingArgs(
  overrides: Partial<{
    workspaceId: Id<"workspaces">;
    boundBy: Id<"users">;
    address: string;
    googleAccountId: string;
    scopes: string[];
    encryptedRefreshToken: string;
    encryptedAccessToken: string;
    accessTokenExpiresAt: number;
  }>,
) {
  return {
    address: "person@example.invalid",
    googleAccountId: "google-1",
    scopes: [CHAT_MESSAGES_SCOPE, CHAT_SPACES_SCOPE],
    accessTokenExpiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

export async function gmailArgs(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  owner: Id<"users">,
  overrides: Partial<{ address: string; scopes: string[] }> = {},
) {
  const keyset = requireKeyset();
  const context = { workspaceId: workspaceId as string };
  const address = overrides.address ?? "person@example.invalid";
  await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
    workspaceId,
    boundBy: owner,
    address,
    mailboxSlug: "person-at-example-invalid",
    googleAccountId: "google-1",
    scopes: overrides.scopes ?? [GMAIL_SCOPE],
    backfillDays: 90,
    folders: ["inbox", "sent"],
    attachmentMode: "store",
    attachmentRetentionDays: 90,
    accessTokenExpiresAt: Date.now() + 3_600_000,
    encryptedRefreshToken: await encryptSecret("gmail-refresh", keyset, context),
    encryptedAccessToken: await encryptSecret("gmail-access", keyset, context),
  });
  return address;
}

