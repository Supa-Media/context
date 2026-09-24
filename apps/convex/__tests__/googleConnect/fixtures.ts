/**
 * The Google connect flow's security controls.
 *
 * Same shape as `dropboxConnect.test.ts`, and the same reason: every control
 * here — the flag, the personal-context-only rule, the owner check, the
 * redirect pin, single-use attempt consumption, the workspace-and-actor
 * coming from the attempt rather than the caller, and revocation on
 * disconnect — could be deleted with the rest of the suite green unless a
 * test names the sabotage it catches.
 *
 * **Generalized from a Gmail-only `mailConnect.test.ts` (2026-09-07)**: the
 * row this file writes is `googleConnections`, carrying `products` and a
 * nested `gmail` settings object rather than flat Gmail fields, so a sibling
 * Calendar or Chat connect flow lands on the same row without a second
 * migration. Only Gmail has a connect flow to test; the shape's extension
 * points (`products`, `calendar`, `chat`) are exercised where the row itself
 * is asserted, not with a flow that does not exist yet.
 */

import { afterEach, vi } from "vitest";
import type { Id } from "../../_generated/dataModel";
import {
  createUser,
  createWorkspace,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import { encryptSecret, hashToken, requireKeyset } from "../../functions/lib/crypto";

export const APP = "https://app.context.invalid";
export const REDIRECT = `${APP}/mail/gmail/callback`;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The flag on, and a client id configured — the state every non-flag test needs. */
export function enableMailConnect() {
  vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
}

export function enableAllGoogleConnect() {
  enableMailConnect();
  vi.stubEnv("CALENDAR_CONNECT_ENABLED", "true");
}

export function enableCalendarOnlyGoogleConnect() {
  vi.stubEnv("CALENDAR_CONNECT_ENABLED", "true");
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

export async function seedConnectedStorage(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  boundBy: Id<"users">,
) {
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: "r2",
      endpoint: "https://storage.example.invalid",
      region: "auto",
      bucket: "context-test",
      accessKeyId: "access-key",
      encryptedSecretAccessKey: "encrypted-secret",
      capabilities: { conditionalWrite: true },
      status: "connected",
      boundBy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** An attempt row, parked as `startGmailConnect` would park it. */
/**
 * The secret a real starting browser keeps, and hands back at completion.
 */
export const COMPLETION = "completion-secret-0123456789";

export async function parkedAttempt(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  startedBy: Id<"users">,
  overrides: Record<string, unknown> = {},
) {
  const state = "google-state-token-0123456789";
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
      products: ["gmail"],
      backfillDays: 90,
      folders: ["inbox", "sent"],
      attachmentMode: "store",
      attachmentRetentionDays: 90,
      attachmentRetentionForever: false,
      expiresAt: now + 600_000,
      createdAt: now,
      ...overrides,
    }),
  );
  return state;
}


export function gmailBindingArgs(
  overrides: Partial<{
    workspaceId: Id<"workspaces">;
    boundBy: Id<"users">;
    address: string;
    mailboxSlug: string;
    googleAccountId: string;
    scopes: string[];
    backfillDays: number;
    folders: ("inbox" | "sent")[];
    attachmentMode: "metadata-only" | "store";
    attachmentRetentionDays: number | "forever";
    encryptedRefreshToken: string;
    encryptedAccessToken: string;
    accessTokenExpiresAt: number;
  }>,
) {
  return {
    address: "person@example.invalid",
    mailboxSlug: "person-at-example-invalid",
    googleAccountId: "google-1",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    backfillDays: 90,
    folders: ["inbox", "sent"] as ("inbox" | "sent")[],
    attachmentMode: "store" as const,
    attachmentRetentionDays: 90,
    accessTokenExpiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

