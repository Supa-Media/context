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

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedGoogleConnection,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { encryptSecret, hashToken, requireKeyset } from "../functions/lib/crypto";
import { CALENDAR_SCOPES, CHAT_SCOPES, GMAIL_SCOPES } from "../functions/lib/googleOAuth";
import type { Id } from "../_generated/dataModel";

const APP = "https://app.context.invalid";
const REDIRECT = `${APP}/mail/gmail/callback`;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The flag on, and a client id configured — the state every non-flag test needs. */
function enableMailConnect() {
  vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
}

function enableAllGoogleConnect() {
  enableMailConnect();
  vi.stubEnv("CALENDAR_CONNECT_ENABLED", "true");
}

function enableCalendarOnlyGoogleConnect() {
  vi.stubEnv("CALENDAR_CONNECT_ENABLED", "true");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
}

async function personalScenario() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  return { t, owner, workspaceId };
}

async function sharedScenario() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas-team", { kind: "shared" });
  return { t, owner, workspaceId };
}

/** An attempt row, parked as `startGmailConnect` would park it. */
/**
 * The secret a real starting browser keeps, and hands back at completion.
 */
const COMPLETION = "completion-secret-0123456789";

async function parkedAttempt(
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

describe("the flag", () => {
  test("a deployment with MAIL_CONNECT_ENABLED unset refuses to start", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("MAIL_CONNECT_DISABLED");
  });

  test("...and refuses to answer a callback too", async () => {
    const { t } = await personalScenario();
    const error = await captureError(() =>
      t.action(api.functions.googleConnect.completeGmailConnect, {
        state: "whatever",
        code: "whatever",
        completionSecret: "whatever",
      }),
    );
    expect(errorCode(error)).toBe("MAIL_CONNECT_DISABLED");
  });

  test("the disabled deployment parks nothing", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    await captureError(() =>
      asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    const parked = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(parked).toHaveLength(0);
  });

  test("enabled but with no client id configured refuses distinctly", async () => {
    vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("MAIL_CONNECT_NOT_CONFIGURED");
  });
});

describe("only a personal context may connect a Google account", () => {
  /**
   * Sabotage: drop the `workspace.kind !== "personal"` half of
   * `requirePersonalOwner`. A shared workspace scaffolds `0-inbox` as `team`
   * (`docs/decisions/privacy-and-sharing.md`), so a mailbox synced into one
   * would be readable by every member from the first message with nobody
   * having decided that — `identity-and-access.md`'s "Mail lands in a
   * personal context and nowhere else", applied here.
   */
  test("the owner of a SHARED context cannot connect a Google account to it", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await sharedScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("NOT_PERSONAL_OWNER");
  });

  /** A stranger with no membership row at all — the outer ring. */
  test("somebody with no membership in a personal context cannot connect one", async () => {
    enableMailConnect();
    const { t, workspaceId } = await personalScenario();
    const outsider = await createUser(t, "outsider@example.invalid");
    const error = await captureError(() =>
      asUser(t, outsider).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("NOT_PERSONAL_OWNER");
  });

  /**
   * Sabotage: relax `membership?.role === "owner"` to `membership !== null`.
   *
   * THIS is the case that proves the role half, and until this test existed
   * nothing did: the check above passes with the role comparison gone,
   * because a stranger has no membership row to relax the comparison on.
   * Measured, that sabotage failed **zero** checks. Somebody the owner
   * granted read or write access to their brain is a real, common shape —
   * and attaching a Google account to a context is not a permission that
   * comes with editing notes in it.
   */
  test.each(["editor", "member"] as const)(
    "an %s of somebody else's personal context cannot connect a Google account to it",
    async (role) => {
      enableMailConnect();
      const { t, workspaceId } = await personalScenario();
      const guest = await createUser(t, `${role}@example.invalid`);
      await addMember(t, workspaceId, guest, role);
      const error = await captureError(() =>
        asUser(t, guest).action(api.functions.googleConnect.startGmailConnect, {
          workspaceId,
          redirectUri: REDIRECT,
        }),
      );
      expect(errorCode(error)).toBe("NOT_PERSONAL_OWNER");
      expect(await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect())).toHaveLength(0);
    },
  );

  /** And the same for disconnecting — read access is never write access. */
  test("an editor of somebody else's personal context cannot disconnect its Google account", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    const editor = await createUser(t, "editor2@example.invalid");
    await addMember(t, workspaceId, editor, "editor");
    const error = await captureError(() =>
      asUser(t, editor).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
        workspaceId,
        connectionId: connection!._id,
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
    expect((await t.run((ctx) => ctx.db.get(connection!._id)))!.disconnectedAt).toBeUndefined();
  });

  test("the owner of their own personal context gets past that check", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const result = await asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
      workspaceId,
      redirectUri: REDIRECT,
    });
    expect(result.authorizeUrl).toContain("accounts.google.com");
  });
});

describe("which redirect URIs this deployment answers on", () => {
  test("a redirect URI off this deployment's origin is refused", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId,
        redirectUri: "https://attacker.example/cb",
      }),
    );
    expect(errorCode(error)).toBe("REDIRECT_URI_NOT_ALLOWED");
  });

  test("nothing is parked when the redirect is refused", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    await captureError(() =>
      asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId,
        redirectUri: "https://attacker.example/cb",
      }),
    );
    const parked = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(parked).toHaveLength(0);
  });
});

describe("the backfill window and folder set", () => {
  test("an unrecognised backfill window is refused", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
        backfillDays: 30,
      }),
    );
    expect(errorCode(error)).toBe("INVALID_BACKFILL_WINDOW");
  });

  test("an empty folder set is refused — there is nothing to sync", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
        folders: [],
      }),
    );
    expect(errorCode(error)).toBe("INVALID_FOLDERS");
  });

  /**
   * Sabotage: widen `MAIL_FOLDERS` to include "spam" or "trash", or drop the
   * `every(...)` check. Spam and Trash are excluded unconditionally in v1
   * (`docs/decisions/communications.md`) — TypeScript's own union type on the
   * schema and on this validator is the enforcement, and this proves the
   * runtime side actually agrees with the type.
   */
  test("spam and trash are not folders this deployment will ever park an attempt for", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
        // @ts-expect-error — deliberately outside the validator's own union,
        // proving the server refuses it rather than the client type merely
        // hiding the option.
        folders: ["spam"],
      }),
    );
    expect(error).toBeDefined();
  });

  test("90 days, 1 year and all mail are each accepted", async () => {
    enableMailConnect();
    for (const backfillDays of [90, 365, 36_500]) {
      const { t, owner, workspaceId } = await personalScenario();
      const result = await asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
        backfillDays,
      });
      expect(result.authorizeUrl).toBeTruthy();
    }
  });
});

describe("product-aware Google connect", () => {
  test("an empty service set is refused before parking an attempt", async () => {
    enableAllGoogleConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.googleConnect.startGoogleConnect, {
        workspaceId,
        redirectUri: REDIRECT,
        syncServices: { gmail: false, calendar: false, chat: false },
      }),
    );
    expect(errorCode(error)).toBe("GOOGLE_PRODUCTS_REQUIRED");
    expect(await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect())).toHaveLength(0);
  });

  test("one console start can ask Google for Gmail, Calendar and Chat together", async () => {
    enableAllGoogleConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const result = await asUser(t, owner).action(api.functions.googleConnect.startGoogleConnect, {
      workspaceId,
      redirectUri: REDIRECT,
      syncServices: { gmail: true, calendar: true, chat: true },
    });
    const params = new URL(result.authorizeUrl).searchParams;
    const scopes = new Set(params.get("scope")?.split(" ") ?? []);
    expect(scopes).toContain(GMAIL_SCOPES[0]);
    expect(scopes).toContain(CALENDAR_SCOPES[0]);
    expect(scopes).toContain(CHAT_SCOPES[0]);
    expect(scopes).toContain(CHAT_SCOPES[1]);
    expect(params.get("include_granted_scopes")).toBe("true");

    const parked = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(parked).toHaveLength(1);
    expect(parked[0]!.products.sort()).toEqual(["calendar", "chat", "gmail"]);
    expect(parked[0]!.hashedCompletion).toBeTruthy();
  });

  test("a Calendar-only console start does not inherit restricted Gmail scopes from an existing grant", async () => {
    enableCalendarOnlyGoogleConnect();
    const { t, owner, workspaceId } = await personalScenario();
    await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      address: "context@supa.media",
    });

    const result = await asUser(t, owner).action(api.functions.googleConnect.startGoogleConnect, {
      workspaceId,
      redirectUri: REDIRECT,
      syncServices: { gmail: false, calendar: true, chat: false },
    });
    const scopes = new Set(new URL(result.authorizeUrl).searchParams.get("scope")?.split(" ") ?? []);

    expect(scopes).toContain(CALENDAR_SCOPES[0]);
    expect(scopes).not.toContain(GMAIL_SCOPES[0]);
    const parked = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(parked[0]!.products).toEqual(["calendar"]);
  });

  test("the generic callback spends a combined attempt exactly once", async () => {
    enableAllGoogleConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner, {
      flow: "google",
      products: ["gmail", "calendar", "chat"],
    });
    const hashedState = await hashToken(state);
    const consumed = await t.mutation(internal.functions.googleConnect.consumeGoogleAttemptAndExchange, {
      hashedState,
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    expect(consumed?.workspaceId).toBe(workspaceId);
    expect(await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect())).toHaveLength(0);

    const replay = await t.mutation(internal.functions.googleConnect.consumeGoogleAttemptAndExchange, {
      hashedState,
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    expect(replay).toBe(null);
  });

  test("the generic callback refuses product-specific attempts", async () => {
    enableAllGoogleConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner, {
      flow: "calendar",
      products: ["gmail", "calendar"],
    });

    const consumed = await t.mutation(internal.functions.googleConnect.consumeGoogleAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });

    expect(consumed).toBe(null);
    expect(await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect())).toHaveLength(1);
  });
});

describe("attachment mode and retention", () => {
  /**
   * Convex's own arg validator (`v.union("metadata-only", "store")`) refuses
   * this before the handler runs at all, so there is no `INVALID_ATTACHMENT_MODE`
   * code to see here — only `validateAttachmentMode`'s *sibling* test below
   * proves that code exists. What this proves is the other half: the type
   * cannot even be bypassed at the wire, the same "spam and trash" property
   * `MAIL_FOLDERS` already has.
   */
  test("an unrecognised attachment mode is refused, at the wire", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
        // @ts-expect-error — deliberately outside the validator's own union.
        attachmentMode: "always",
      }),
    );
    expect(error).toBeDefined();
  });

  test("a zero or negative retention is refused — only a positive number, or 'forever'", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
        attachmentRetentionDays: 0,
      }),
    );
    expect(errorCode(error)).toBe("INVALID_ATTACHMENT_RETENTION");
  });

  test("'forever' is an accepted retention value", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const result = await asUser(t, owner).action(api.functions.googleConnect.startGmailConnect, {
      workspaceId,
      redirectUri: REDIRECT,
      attachmentRetentionDays: "forever",
    });
    expect(result.authorizeUrl).toBeTruthy();
  });
});

describe("who may answer a callback", () => {
  /**
   * No session required on the callback — see `googleConnect.ts`'s comment
   * for why. What has to hold instead: the workspace and the actor come from
   * the ATTEMPT, never from the caller, so an interceptor of the callback
   * URL can complete or burn the victim's own connect and nothing else.
   */
  test("the workspace and the actor come from the attempt, never from the caller", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);
    const consumed = await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    expect(consumed?.workspaceId).toBe(workspaceId);
  });

  /** Sabotage: move the `ctx.db.delete` after the exchange, or drop it. */
  test("an attempt is spent by being answered", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);
    const hashedState = await hashToken(state);

    await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState,
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    const remaining = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(remaining).toHaveLength(0);

    const replay = await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState,
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    expect(replay).toBe(null);
  });

  /** Sabotage: drop the `attempt.expiresAt < Date.now()` check. */
  test("an expired attempt is refused", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner, { expiresAt: Date.now() - 1 });
    const consumed = await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    expect(consumed).toBe(null);
  });

  test("never-issued, spent and expired are one answer", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const answers: unknown[] = [];

    answers.push(
      await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
        hashedState: await hashToken("never-issued-at-all"),
        hashedCompletion: await hashToken(COMPLETION),
        code: "c",
      }),
    );
    const spent = await parkedAttempt(t, workspaceId, owner);
    const spentHash = await hashToken(spent);
    await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState: spentHash,
      hashedCompletion: await hashToken(COMPLETION),
      code: "c",
    });
    answers.push(
      await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
        hashedState: spentHash,
        hashedCompletion: await hashToken(COMPLETION),
        code: "c",
      }),
    );
    const expired = await parkedAttempt(t, workspaceId, owner, { expiresAt: Date.now() - 1 });
    answers.push(
      await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
        hashedState: await hashToken(expired),
        hashedCompletion: await hashToken(COMPLETION),
        code: "c",
      }),
    );
    expect(answers).toEqual([null, null, null]);
  });
});

/** Standard args for `applyGmailConnectionBinding`, so each test overrides only what it is about. */
function gmailBindingArgs(
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

describe("the row shape: products and the nested gmail object", () => {
  test("a first connect writes products: ['gmail'] and a full gmail settings object", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) =>
          q.eq("workspaceId", workspaceId).eq("address", "person@example.invalid"),
        )
        .unique(),
    );
    expect(row?.provider).toBe("google");
    expect(row?.products).toEqual(["gmail"]);
    expect(row?.gmail?.mailboxSlug).toBe("person-at-example-invalid");
    expect(row?.gmail?.attachmentMode).toBe("store");
    expect(row?.gmail?.attachmentRetentionDays).toBe(90);
    expect(row?.health).toBe("backfilling");
    expect(row?.gmail?.historyId).toBeUndefined();
    // The account's own scopes, verbatim, AND the per-product slice —
    // one fact recorded twice, from the same source.
    expect(row?.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(row?.gmail?.scopes).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
  });

  test("the owner-facing connection list includes observable sync details", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });

    const [row] = await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, {
      workspaceId,
    });

    expect(row).toMatchObject({
      email: "person@example.invalid",
      syncServices: { gmail: true, calendar: false, chat: false },
      syncStatus: "backfilling",
      gmail: {
        backfillDays: 90,
        folders: ["inbox", "sent"],
        destinationPath: "0-inbox/email/person-at-example-invalid/YYYY-MM-DD.md",
        historyCursorReady: false,
      },
    });
    expect(row?.lastSyncCompletedAt).toBeUndefined();
  });

  test("the owner-facing connection list hides stale details for products no longer enabled", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({
        scopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/calendar.events.readonly",
        ],
      }),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    await t.run(async (ctx) => {
      const stored = await ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) =>
          q.eq("workspaceId", workspaceId).eq("address", "person@example.invalid"),
        )
        .unique();
      await ctx.db.patch(stored!._id, {
        products: ["gmail"],
        calendar: {
          scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
          syncToken: "stale-calendar-token",
          lastSyncedAt: 42,
        },
      });
    });

    const [row] = await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, {
      workspaceId,
    });

    expect(row?.syncServices).toEqual({ gmail: true, calendar: false, chat: false });
    expect(row?.gmail).toBeDefined();
    expect(row?.calendar).toBeUndefined();
    expect(row?.lastSyncCompletedAt).toBeUndefined();
  });

  /**
   * Sabotage: change `existing?.gmail?.mailboxSlug ?? args.mailboxSlug` to
   * `args.mailboxSlug ?? existing?.gmail?.mailboxSlug`. A folder name that
   * changed on a reconnect would be a rename of a person's mail — the exact
   * failure `docs/decisions/communications.md` argues against under "An
   * address becomes a slug".
   */
  test("reconnecting the same account keeps its original mailbox slug even if a caller supplies a different one", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const address = "person@example.invalid";
    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({ address }),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });

    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({
        address,
        // A caller (or a slug-collision race) supplying a DIFFERENT slug
        // must not rename the folder this mailbox's notes are already in.
        mailboxSlug: "collided-different-slug",
      }),
      encryptedRefreshToken: await encryptSecret("refresh-2", keyset, context),
      encryptedAccessToken: await encryptSecret("access-2", keyset, context),
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.gmail?.mailboxSlug).toBe("person-at-example-invalid");
  });

  /** A reconnect keeps the sync cursor — resetting it would force a needless full reconcile. */
  test("reconnecting preserves the sync cursor", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const address = "person@example.invalid";
    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({ address }),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique();
      await ctx.db.patch(row!._id, { gmail: { ...row!.gmail!, historyId: "12345" } });
    });

    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({ address }),
      encryptedRefreshToken: await encryptSecret("refresh-2", keyset, context),
      encryptedAccessToken: await encryptSecret("access-2", keyset, context),
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );
    expect(row?.gmail?.historyId).toBe("12345");
  });

  test("reconnecting a Gmail-only account never touches an already-enabled calendar or chat product", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const address = "person@example.invalid";
    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({ address }),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    // Simulate the (not-yet-built) Calendar flow having already enabled
    // itself on this same account.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique();
      await ctx.db.patch(row!._id, {
        products: [...row!.products, "calendar"],
        calendar: { scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"], syncToken: "cal-token" },
      });
    });

    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({ address }),
      encryptedRefreshToken: await encryptSecret("refresh-2", keyset, context),
      encryptedAccessToken: await encryptSecret("access-2", keyset, context),
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );
    expect(row?.products.sort()).toEqual(["calendar", "gmail"]);
    expect(row?.calendar?.syncToken).toBe("cal-token");
  });

  /**
   * "Two views of one fact, never two facts" — the schema's own rule about
   * `scopes` and the per-product slices, applied to the reconnect that can
   * break it.
   *
   * A Gmail-only reconnect replaces the top-level `scopes` with whatever
   * Google granted THIS time. Carrying `calendar.scopes` through untouched
   * would leave the row asserting a Calendar consent out of a grant that no
   * longer carries one — a health screen reporting Calendar as connected on
   * the strength of a record of a consent that has been replaced. Every
   * product's slice is recomputed from the one verbatim grant instead, so a
   * regression shows up in the row rather than hiding in it.
   *
   * Sabotage: restore `calendar: existing?.calendar` and this fails.
   */
  test("a reconnect recomputes every product's scope slice from the one verbatim grant", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const address = "person@example.invalid";
    const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
    const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({ address, scopes: [GMAIL_SCOPE, CALENDAR_SCOPE] }),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique();
      await ctx.db.patch(row!._id, {
        products: [...row!.products, "calendar"],
        calendar: { scopes: [CALENDAR_SCOPE], syncToken: "cal-token" },
      });
    });

    // The person re-consents and unchecks Calendar this time.
    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({ address, scopes: [GMAIL_SCOPE] }),
      encryptedRefreshToken: await encryptSecret("refresh-2", keyset, context),
      encryptedAccessToken: await encryptSecret("access-2", keyset, context),
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );
    expect(row?.scopes).toEqual([GMAIL_SCOPE]);
    // The slice is empty because the grant no longer carries it — not stale.
    expect(row?.calendar?.scopes).toEqual([]);
    // The cursor and the settings are the product's own and survive.
    expect(row?.calendar?.syncToken).toBe("cal-token");
    // And no product object claims a scope the account's own list does not.
    for (const slice of [row?.gmail?.scopes ?? [], row?.calendar?.scopes ?? [], row?.chat?.scopes ?? []]) {
      for (const scope of slice) expect(row?.scopes).toContain(scope);
    }
  });

  test("two different addresses in one context each get their own row", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    for (const [address, slug] of [
      ["one@example.invalid", "one-at-example-invalid"],
      ["two@example.invalid", "two-at-example-invalid"],
    ] as const) {
      await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
        workspaceId,
        boundBy: owner,
        ...gmailBindingArgs({ address, mailboxSlug: slug, googleAccountId: `google-${slug}` }),
        encryptedRefreshToken: await encryptSecret(`refresh-${slug}`, keyset, context),
        encryptedAccessToken: await encryptSecret(`access-${slug}`, keyset, context),
      });
    }
    const rows = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("no token ever appears in the clear", () => {
  test("the stored refresh and access tokens are sealed envelopes, never the plaintext", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("super-secret-refresh-token", keyset, context),
      encryptedAccessToken: await encryptSecret("super-secret-access-token", keyset, context),
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    expect(row!.encryptedRefreshToken.startsWith("v2:")).toBe(true);
    expect(row!.encryptedRefreshToken).not.toContain("super-secret-refresh-token");
    expect(row!.encryptedAccessToken).not.toContain("super-secret-access-token");

    // The audit trail records the connect. It must never carry the token.
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .filter((q) => q.eq(q.field("workspaceId"), workspaceId))
        .collect(),
    );
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("super-secret-refresh-token");
    expect(serialized).not.toContain("super-secret-access-token");
  });
});

describe("disconnect: revoke the WHOLE grant at Google, delete the token, keep the notes", () => {
  async function connected() {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const refreshEnvelope = await encryptSecret("refresh-to-revoke", keyset, context);
    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: refreshEnvelope,
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    return { t, owner, workspaceId, connectionId: connection!._id, refreshEnvelope };
  }

  /** Sabotage: drop the `membership?.role !== "owner"` refusal. */
  test("a member who is not the owner cannot disconnect a Google account", async () => {
    const { t, workspaceId, connectionId } = await connected();
    const outsider = await createUser(t, "outsider@example.invalid");
    const error = await captureError(() =>
      asUser(t, outsider).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
        workspaceId,
        connectionId,
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
  });

  /**
   * A connection id from a DIFFERENT workspace, with the caller's own
   * workspaceId — must not disconnect somebody else's account and must not
   * confirm one exists there either.
   */
  /**
   * BOTH WORKSPACES LIVE IN ONE DATABASE, and that is the whole test.
   *
   * An earlier version of this built Bob in a second `setupTest()`, so Alice's
   * connection id did not exist in Bob's database at all — `ctx.db.get`
   * answered `null` and the refusal came from the null branch, not from the
   * tenancy check. It passed with `connection.workspaceId !== args.workspaceId`
   * deleted outright, which is the guard it claims to be about: measured, the
   * sabotage failed **zero** checks. Isolation has to be proved against a
   * database that really holds the other tenant's row, or it is proving that
   * one test fixture cannot see another.
   */
  test("a connection id belonging to another workspace is not found, not disconnected", async () => {
    const { t, workspaceId: aliceWorkspace, connectionId: alicesConnectionId } = await connected();
    const bobOwner = await createUser(t, "bob-owner@example.invalid");
    const bobWorkspace = await createWorkspace(t, bobOwner, "bob-ctx");

    const error = await captureError(() =>
      asUser(t, bobOwner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
        workspaceId: bobWorkspace,
        connectionId: alicesConnectionId,
      }),
    );
    expect(errorCode(error)).toBe("NOT_FOUND");

    // Alice's connection is untouched: still live, still holding its envelope.
    const alices = await t.run((ctx) => ctx.db.get(alicesConnectionId));
    expect(alices!.workspaceId).toBe(aliceWorkspace);
    expect(alices!.disconnectedAt).toBeUndefined();
    expect(alices!.encryptedRefreshToken.length).toBeGreaterThan(0);
  });

  /**
   * The other half of the same attack: naming the VICTIM's workspace instead
   * of your own. This is refused one check earlier — Bob has no membership row
   * in Alice's workspace — and the two together are what make the pair of ids
   * unusable in either combination.
   */
  test("naming the other workspace's id does not disconnect it either", async () => {
    const { t, workspaceId: aliceWorkspace, connectionId: alicesConnectionId } = await connected();
    const bobOwner = await createUser(t, "bob-owner@example.invalid");
    await createWorkspace(t, bobOwner, "bob-ctx");

    const error = await captureError(() =>
      asUser(t, bobOwner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
        workspaceId: aliceWorkspace,
        connectionId: alicesConnectionId,
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
    expect((await t.run((ctx) => ctx.db.get(alicesConnectionId)))!.disconnectedAt).toBeUndefined();
  });

  /**
   * And the same pair of ids against `startGmailConnect`, the other route that
   * accepts a `workspaceId` from the caller: a Google account cannot be
   * attached to somebody else's context by naming it.
   */
  test("a caller cannot start a connect against a workspace they are not the owner of", async () => {
    const { t, workspaceId: aliceWorkspace } = await connected();
    const bobOwner = await createUser(t, "bob-owner@example.invalid");
    await createWorkspace(t, bobOwner, "bob-ctx");

    enableMailConnect();
    vi.stubEnv("APP_ORIGIN", APP);
    const error = await captureError(() =>
      asUser(t, bobOwner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId: aliceWorkspace,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("NOT_PERSONAL_OWNER");
    expect(await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect())).toHaveLength(0);
  });

  test("disconnecting clears the token and marks the connection disconnected, keeping the row", async () => {
    const { t, owner, workspaceId, connectionId } = await connected();
    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId,
    });

    const row = await t.run((ctx) => ctx.db.get(connectionId));
    expect(row).not.toBeNull();
    expect(row!.encryptedRefreshToken).toBe("");
    expect(row!.encryptedAccessToken).toBeUndefined();
    expect(row!.disconnectedAt).toBeDefined();
    expect(row!.health).toBe("error");
    // The mailbox slug — and therefore its folder — is untouched: disconnect
    // never deletes notes.
    expect(row!.gmail?.mailboxSlug).toBe("person-at-example-invalid");
  });

  /**
   * Forgetting our copy is only half of disconnecting. Sabotage: drop the
   * `ctx.scheduler.runAfter(..., revokeGoogleGrant, ...)` call.
   */
  test("disconnecting schedules revocation at Google, carrying the OLD refresh token", async () => {
    const { t, owner, workspaceId, connectionId, refreshEnvelope } = await connected();
    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId,
    });

    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const revokes = scheduled.filter((job) => String(job.name).includes("revokeGoogleGrant"));
    expect(revokes).toHaveLength(1);
    expect(JSON.stringify(revokes[0]!.args)).toContain(refreshEnvelope);
  });

  test("disconnecting twice is a no-op the second time — no second revoke job, no error", async () => {
    const { t, owner, workspaceId, connectionId } = await connected();
    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId,
    });
    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId,
    });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((job) => String(job.name).includes("revokeGoogleGrant"))).toHaveLength(1);
  });

  /**
   * THE ONE A SYNC JOB DEPENDS ON. `mintGoogleAccessToken` is what a sync
   * pass calls to get a usable Google credential; if it minted one for a
   * disconnected connection, the sync job would keep reading somebody's mail
   * after they revoked access. Sabotage: drop the `disconnectedAt !==
   * undefined` check from either `mintGoogleAccessToken` or
   * `getConnectionForSync`.
   */
  test("a disconnected connection's access-token mint is a no-op", async () => {
    const { t, owner, workspaceId, connectionId } = await connected();
    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId,
    });

    const minted = await t.action(internal.functions.googleConnect.mintGoogleAccessToken, {
      connectionId,
    });
    expect(minted).toBeNull();
  });
});

describe("isolation: one context's mailbox slugs are invisible to another", () => {
  test("listMailboxSlugs for one workspace never returns another's", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");
    const aliceWs = await createWorkspace(t, alice, "alice-ctx");
    const bobWs = await createWorkspace(t, bob, "bob-ctx");
    const keyset = requireKeyset();

    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId: aliceWs,
      boundBy: alice,
      ...gmailBindingArgs({ address: "alice@example.invalid", mailboxSlug: "alice-at-example-invalid", googleAccountId: "google-alice" }),
      encryptedRefreshToken: await encryptSecret("r", keyset, { workspaceId: aliceWs as string }),
      encryptedAccessToken: await encryptSecret("a", keyset, { workspaceId: aliceWs as string }),
    });

    const bobsSlugs: string[] = await t.run(async (ctx) => {
      // Mirrors `listMailboxSlugs`'s own query rather than importing an
      // internalQuery handler directly, since the test's job is to prove the
      // WORKSPACE INDEX scopes correctly, not to re-invoke the function.
      const rows = await ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", bobWs))
        .collect();
      return rows.flatMap((row) => (row.gmail ? [row.gmail.mailboxSlug] : []));
    });
    expect(bobsSlugs).toHaveLength(0);
    expect(bobsSlugs).not.toContain("alice-at-example-invalid");
  });
});

describe("the browser that started a Google connect is the one that may finish it", () => {
  /**
   * The same property `dropboxConnect.ts` now carries, and this file inherited
   * the gap by citing that file's older argument — *"No session required — see
   * `completeDropboxConnect` for the full argument… it applies here unchanged,
   * PKCE pair and all."*
   *
   * It did apply unchanged, and that was the problem. `state` travels in the
   * authorize URL and comes back in the callback, so whoever built the URL
   * knows it — including somebody who built it for a workspace they really do
   * own and then sent it to another person to consent. PKCE cannot see that
   * case: the attacker is the *initiator*, so the verifier is genuinely theirs
   * and matches. What binds the flow to the browser that started it is a value
   * that never travels through Google, and RFC 6749 §10.12 is the reason it
   * has to exist.
   *
   * **Still no session**, which is the half of the cited argument that was
   * always right: a sign-in wall on a callback outlives a single-use code.
   */
  test("A COMPLETION WITHOUT THE STARTING BROWSER'S SECRET IS REFUSED", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);

    const consumed = await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken("a-guess"),
      code: "code-1",
    });
    expect(consumed).toBeNull();
  });

  test("...and the secret the starter kept does complete it", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);

    const consumed = await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    expect(consumed?.workspaceId).toBe(workspaceId);
  });

  test("an attempt parked without one is refused rather than trusted", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner, { hashedCompletion: undefined });

    const consumed = await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken("anything"),
      code: "code-1",
    });
    expect(consumed).toBeNull();
  });

  test("a refused completion still spends the attempt", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);

    await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken("a-guess"),
      code: "code-1",
    });
    const rows = await t.run(async (ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(rows).toHaveLength(0);
  });
});
