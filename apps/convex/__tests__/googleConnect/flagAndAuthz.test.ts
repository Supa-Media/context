import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  errorCode,
  seedGoogleConnection,
} from "../fixtures.helpers";
import { encryptSecret, hashToken, requireKeyset } from "../../functions/lib/crypto";
import { CALENDAR_SCOPES, CHAT_SCOPES, GMAIL_SCOPES } from "../../functions/lib/googleOAuth";
import {
  APP,
  REDIRECT,
  enableMailConnect,
  enableAllGoogleConnect,
  enableCalendarOnlyGoogleConnect,
  personalScenario,
  sharedScenario,
  seedConnectedStorage,
  COMPLETION,
  parkedAttempt,
  gmailBindingArgs,
} from "./fixtures.helpers";

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
   * granted read or write access to their workspace is a real, common shape —
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

