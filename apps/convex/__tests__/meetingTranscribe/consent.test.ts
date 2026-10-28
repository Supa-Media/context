import { describe, expect, test, vi } from "vitest";
import {
  CLOUD_TRANSCRIPTION_CONSENT_VERSION,
  CLOUD_TRANSCRIPTION_DISCLOSURE,
  TRANSCRIPTION_CONSENT_REQUIRED,
} from "@context/shared";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { hashToken } from "../../functions/lib/crypto";
import { TEXTS_CLIENT_ID } from "../../functions/textLinks";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  gatewayPost,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import { CHUNK, configureWorker, workerReturning } from "./fixtures.helpers";

/**
 * CLOUD TRANSCRIPTION CONSENT, AT THE CONTROL PLANE'S BOUNDARY.
 *
 * App Review, build 12, guidelines 5.1.1(i) and 5.1.2(i): a microphone
 * permission is not permission to send a recording to Cloudflare Workers AI.
 * So `transcribeChunk` forwards nothing for an account without a current yes,
 * and the gateway's `POST /gateway/transcription/consent` answers `false` for
 * it, whatever the app did or did not show.
 *
 * Every test that refuses also asserts the worker was never asked: a refusal
 * after the fetch is a refusal after the audio left.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted (counts measured):
 *
 *   the consent check removed from `transcribeChunk`                       6
 *   `isCurrentTranscriptionConsent` ignores `withdrawnAt`                  2
 *   `isCurrentTranscriptionConsent` ignores `version`                      1
 *   `allowTranscription` accepts any version                               1
 *   `gatewayConsent` skips the workspace check                             1
 *   `gatewayConsent` hears a voice message on any grant                    1
 */

vi.setConfig({ testTimeout: 20_000 });

const transcribeChunk = api.functions.meetings.transcribe.transcribeChunk;
const consent = api.functions.transcriptionConsent;

async function refusedWithoutAsking(t: TestConvex, userId: Id<"users">) {
  const requests = workerReturning([{ startMs: 0, endMs: 10, text: "should never be heard" }]);
  const error = await captureError(() => asUser(t, userId).action(transcribeChunk, CHUNK));
  expect(errorCode(error)).toBe(TRANSCRIPTION_CONSENT_REQUIRED);
  expect(requests).toHaveLength(0);
}

describe("no audio reaches Workers AI without a current yes", () => {
  test("an account that was never asked is refused, and the worker is never called", async () => {
    const t = setupTest();
    configureWorker();
    const userId = await createUser(t, "never-asked@example.invalid");
    await refusedWithoutAsking(t, userId);
  });

  test("Not now writes nothing, so the next chunk is refused too", async () => {
    const t = setupTest();
    configureWorker();
    const userId = await createUser(t, "declined@example.invalid");
    // Declining is the absence of a yes: no mutation runs.
    expect(await asUser(t, userId).query(consent.myTranscriptionConsent, {})).toMatchObject({ allowed: false });
    await refusedWithoutAsking(t, userId);
  });

  test("a yes lets audio through, and withdrawing it stops the very next chunk", async () => {
    const t = setupTest();
    configureWorker();
    const userId = await createUser(t, "withdraws@example.invalid");
    const me = asUser(t, userId);
    await me.mutation(consent.allowTranscription, { version: CLOUD_TRANSCRIPTION_CONSENT_VERSION });

    const requests = workerReturning([{ startMs: 0, endMs: 10, text: "hello" }]);
    await me.action(transcribeChunk, CHUNK);
    expect(requests).toHaveLength(1);

    await me.mutation(consent.withdrawTranscription, {});
    expect(await me.query(consent.myTranscriptionConsent, {})).toMatchObject({ allowed: false });
    await refusedWithoutAsking(t, userId);
  });

  test("a yes to an older disclosure is asked again, never carried over", async () => {
    const t = setupTest();
    configureWorker();
    const userId = await createUser(t, "older@example.invalid");
    await t.run((ctx) =>
      ctx.db.insert("transcriptionConsents", {
        userId,
        version: CLOUD_TRANSCRIPTION_CONSENT_VERSION - 1,
        provider: "Some earlier provider",
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    expect(await asUser(t, userId).query(consent.myTranscriptionConsent, {})).toMatchObject({
      allowed: false,
      outdated: true,
      currentVersion: CLOUD_TRANSCRIPTION_CONSENT_VERSION,
    });
    await refusedWithoutAsking(t, userId);
  });

  test("an app showing older words cannot record a yes to the current disclosure", async () => {
    const t = setupTest();
    const userId = await createUser(t, "old-app@example.invalid");
    const error = await captureError(() =>
      asUser(t, userId).mutation(consent.allowTranscription, { version: CLOUD_TRANSCRIPTION_CONSENT_VERSION - 1 }),
    );
    expect(errorCode(error)).toBe("DISCLOSURE_OUTDATED");
    expect(await asUser(t, userId).query(consent.myTranscriptionConsent, {})).toMatchObject({ allowed: false });
  });

  test("one account's yes is not another's", async () => {
    const t = setupTest();
    configureWorker();
    const yes = await createUser(t, "yes@example.invalid");
    const other = await createUser(t, "other@example.invalid");
    await asUser(t, yes).mutation(consent.allowTranscription, { version: CLOUD_TRANSCRIPTION_CONSENT_VERSION });
    await refusedWithoutAsking(t, other);
    // And the other account's withdraw touches only its own (absent) answer.
    await asUser(t, other).mutation(consent.withdrawTranscription, {});
    expect(await asUser(t, yes).query(consent.myTranscriptionConsent, {})).toMatchObject({ allowed: true });
  });

  test("a refused chunk spends no transcription budget", async () => {
    const t = setupTest();
    configureWorker();
    const userId = await createUser(t, "budget@example.invalid");
    await refusedWithoutAsking(t, userId);
    const rows = await t.run((ctx) => ctx.db.query("rateLimits").collect());
    expect(rows.filter((row) => row.key.startsWith("meetings.transcribeChunk:"))).toHaveLength(0);
  });

  test("the disclosure the yes is kept under names its purpose, transcripts and summaries", async () => {
    // A changed recipient or purpose requires a new affirmative answer.
    expect(CLOUD_TRANSCRIPTION_DISCLOSURE).toEqual({
      version: 3,
      provider: "Cloudflare Workers AI; Anthropic",
      purpose: "meeting transcripts and summaries",
    });
  });

  test("signed out, the answer is null and nothing can be written", async () => {
    const t = setupTest();
    expect(await t.query(consent.myTranscriptionConsent, {})).toBeNull();
    const error = await captureError(() =>
      t.mutation(consent.allowTranscription, { version: CLOUD_TRANSCRIPTION_CONSENT_VERSION }),
    );
    expect(error).toBeTruthy();
  });
});

describe("the gateway asks the same question", () => {
  async function grantFor(t: TestConvex, userId: Id<"users">, workspaceId: Id<"workspaces">, clientId = "context_desktop_test") {
    const accessToken = `cat_consent_${Math.random().toString(16).slice(2)}${"0".repeat(16)}`;
    const hashedAccessToken = await hashToken(accessToken);
    await t.run(async (ctx) => {
      const known = await ctx.db
        .query("oauthClients")
        .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
        .unique();
      if (known === null) {
        await ctx.db.insert("oauthClients", {
          clientId,
          clientName: "Consent test client",
          redirectUris: [],
          hashedClientSecret: null,
          tokenEndpointAuthMethod: "none",
          grantTypes: [],
          responseTypes: [],
          createdAt: Date.now(),
        });
      }
      await ctx.db.insert("oauthGrants", {
        workspaceId,
        userId,
        clientId,
        scopes: ["context:read", "context:write", "context:private"],
        hashedAccessToken,
        hashedRefreshToken: `refresh_${hashedAccessToken}`,
        accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
        status: "active",
        createdAt: Date.now(),
      });
    });
    return accessToken;
  }

  async function ask(t: TestConvex, accessToken: string, expectedWorkspaceId: string, kind = "meeting") {
    const response = await gatewayPost(t, "/gateway/transcription/consent", { accessToken, expectedWorkspaceId, kind });
    expect(response.status).toBe(200);
    return ((await response.json()) as { allowed: unknown }).allowed;
  }

  test("the token's own person decides; withdrawing turns it off", async () => {
    const t = setupTest();
    const userId = await createUser(t, "mac@example.invalid");
    const workspaceId = await createWorkspace(t, userId, "maccy", { kind: "personal" });
    const token = await grantFor(t, userId, workspaceId);

    expect(await ask(t, token, workspaceId)).toBe(false);
    await asUser(t, userId).mutation(consent.allowTranscription, { version: CLOUD_TRANSCRIPTION_CONSENT_VERSION });
    expect(await ask(t, token, workspaceId)).toBe(true);
    await asUser(t, userId).mutation(consent.withdrawTranscription, {});
    expect(await ask(t, token, workspaceId)).toBe(false);
  });

  test("a workspace the grant does not reach, a dead token, or no secret all answer no", async () => {
    const t = setupTest();
    const userId = await createUser(t, "mac2@example.invalid");
    const workspaceId = await createWorkspace(t, userId, "maccy2", { kind: "personal" });
    const stranger = await createUser(t, "stranger@example.invalid");
    const theirs = await createWorkspace(t, stranger, "stranger", { kind: "personal" });
    await asUser(t, userId).mutation(consent.allowTranscription, { version: CLOUD_TRANSCRIPTION_CONSENT_VERSION });
    const token = await grantFor(t, userId, workspaceId);

    expect(await ask(t, token, theirs)).toBe(false);
    expect(await ask(t, "cat_not_a_real_token_0000000000000000", workspaceId)).toBe(false);
    const unauthenticated = await gatewayPost(
      t,
      "/gateway/transcription/consent",
      { accessToken: token, expectedWorkspaceId: workspaceId },
      { secret: null },
    );
    expect(unauthenticated.status).not.toBe(200);
  });

  test("a voice message is heard only on the texter's own grant, never a group chat's", async () => {
    const t = setupTest();
    const userId = await createUser(t, "texter@example.invalid");
    const workspaceId = await createWorkspace(t, userId, "texter", { kind: "personal" });
    await t.run((ctx) => ctx.db.insert("phoneLinks", { userId, phone: "+15555550111", linkedAt: Date.now() }));
    await asUser(t, userId).mutation(consent.allowTranscription, { version: CLOUD_TRANSCRIPTION_CONSENT_VERSION });

    const own = await grantFor(t, userId, workspaceId, TEXTS_CLIENT_ID);
    expect(await ask(t, own, workspaceId, "voiceMessage")).toBe(true);
    // A desktop grant is not Tex: it may send meetings, not voice messages.
    const desktop = await grantFor(t, userId, workspaceId);
    expect(await ask(t, desktop, workspaceId, "voiceMessage")).toBe(false);
  });
});
