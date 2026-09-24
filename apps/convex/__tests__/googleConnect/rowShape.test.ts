import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  asUser,
  captureError,
  errorCode,
} from "../fixtures.helpers";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { defaultGoogleDestinationFolder } from "../../functions/googleConnect";
// eslint-disable-next-line import/extensions
import { channelDayNotePath } from "../../../../packages/communications/src/paths.js";
// eslint-disable-next-line import/extensions
import { calendarDayNotePath } from "../../../../packages/communications/src/calendar/paths.js";
import {
  REDIRECT,
  enableMailConnect,
  personalScenario,
  sharedScenario,
  seedConnectedStorage,
  gmailBindingArgs,
} from "./fixtures.helpers";

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
      syncStatus: "connected",
      gmail: {
        backfillDays: 90,
        folders: ["inbox", "sent"],
        destinationPath: "0-inbox/email/person-at-example-invalid/YYYY/MM/YYYY-MM-DD.md",
        historyCursorReady: false,
      },
    });
    expect(row?.lastSyncCompletedAt).toBeUndefined();
  });

  test("a personal owner can choose a Gmail destination folder, but a shared workspace cannot", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const connectionId = await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });

    await asUser(t, owner).mutation(api.functions.googleConnect.updateGoogleSyncDestination, {
      workspaceId,
      connectionId,
      service: "gmail",
      destinationPath: "2-areas/communications/mail/YYYY/MM/YYYY-MM-DD.md",
    });

    const [row] = await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, {
      workspaceId,
    });
    expect(row?.gmail?.destinationFolder).toBe("2-areas/communications/mail");
    expect(row?.gmail?.destinationPath).toBe("2-areas/communications/mail/YYYY/MM/YYYY-MM-DD.md");

    const secondConnectionId = await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({
        address: "other@example.invalid",
        mailboxSlug: "other-at-example-invalid",
        googleAccountId: "google-2",
      }),
      encryptedRefreshToken: await encryptSecret("refresh-3", keyset, context),
      encryptedAccessToken: await encryptSecret("access-3", keyset, context),
    });
    const conflict = await captureError(() =>
      asUser(t, owner).mutation(api.functions.googleConnect.updateGoogleSyncDestination, {
        workspaceId,
        connectionId: secondConnectionId,
        service: "gmail",
        destinationPath: "2-areas/communications/mail/YYYY/MM/YYYY-MM-DD.md",
      }),
    );
    expect(errorCode(conflict)).toBe("GOOGLE_SYNC_DESTINATION_CONFLICT");

    const shared = await sharedScenario();
    const sharedContext = { workspaceId: shared.workspaceId as string };
    const sharedConnectionId = await shared.t.mutation(
      internal.functions.googleConnect.applyGmailConnectionBinding,
      {
        workspaceId: shared.workspaceId,
        boundBy: shared.owner,
        ...gmailBindingArgs({}),
        encryptedRefreshToken: await encryptSecret("refresh-2", keyset, sharedContext),
        encryptedAccessToken: await encryptSecret("access-2", keyset, sharedContext),
      },
    );

    const error = await captureError(() =>
      asUser(shared.t, shared.owner).mutation(api.functions.googleConnect.updateGoogleSyncDestination, {
        workspaceId: shared.workspaceId,
        connectionId: sharedConnectionId,
        service: "gmail",
        destinationPath: "2-areas/communications/team-mail/YYYY/MM/YYYY-MM-DD.md",
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
  });

  /*
    The refusals, through the mutation rather than through the module.

    `normalizeDestinationFolder` moved to `@context/communications/destination`
    so the console could render the same refusal before the round trip. The
    package has its own checks; what this one holds is the *wiring* — that this
    mutation still refuses, and still refuses with the codes its callers switch
    on. Swap the import for a pass-through and the package suite stays green
    while a dot-folder lands in somebody's bucket.
  */
  test("a destination the package refuses is refused here, with the code callers switch on", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const connectionId = await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });

    const folderNow = async () => {
      const [row] = await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, {
        workspaceId,
      });
      return row?.gmail?.destinationFolder;
    };
    // The folder the binding was created with. A refusal must leave it exactly
    // here — "still the default" is the assertion, not "absent", because a
    // connection is never without one.
    const seeded = await folderNow();
    expect(seeded).toBe("0-inbox/email/person-at-example-invalid");

    const refuse = async (destinationPath: string) =>
      errorCode(
        await captureError(() =>
          asUser(t, owner).mutation(api.functions.googleConnect.updateGoogleSyncDestination, {
            workspaceId,
            connectionId,
            service: "gmail",
            destinationPath,
          }),
        ),
      );

    // Plumbing: a day note filed under a dot-folder is invisible to the person
    // whose mail it is, and still on their storage bill.
    expect(await refuse(".audit/mail")).toBe("GOOGLE_DESTINATION_RESERVED");
    expect(await refuse("0-inbox/.hidden/mail")).toBe("GOOGLE_DESTINATION_RESERVED");
    // Traversal, refused rather than resolved.
    expect(await refuse("2-areas/../../etc")).toBe("GOOGLE_DESTINATION_INVALID");
    expect(await refuse("2-areas\\mail")).toBe("GOOGLE_DESTINATION_INVALID");
    // A note is not a folder to file inside.
    expect(await refuse("1-projects/board-update.md")).toBe("GOOGLE_DESTINATION_INVALID");
    // The bucket root would put mail beside index.md and privacy.md.
    expect(await refuse("")).toBe("GOOGLE_DESTINATION_INVALID");
    expect(await refuse("/")).toBe("GOOGLE_DESTINATION_INVALID");

    // And none of that wrote anything — not even partially.
    expect(await folderNow()).toBe(seeded);
  });

  test("the owner cannot start a historical Gmail backfill run", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    await seedConnectedStorage(t, workspaceId, owner);
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const connectionId = await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });

    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.googleConnect.startGoogleSyncRun, {
        workspaceId,
        connectionId,
        services: { gmail: true, calendar: false, chat: false },
      }),
    );

    expect(errorCode(error)).toBe("GOOGLE_SYNC_FORWARD_ONLY");
    expect(await t.run((ctx) => ctx.db.query("googleSyncRuns").collect())).toHaveLength(0);
  });

  test("a deployment with Gmail disabled refuses to start an existing Gmail backfill", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    await seedConnectedStorage(t, workspaceId, owner);
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const connectionId = await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });

    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.googleConnect.startGoogleSyncRun, {
        workspaceId,
        connectionId,
        services: { gmail: true, calendar: false, chat: false },
      }),
    );

    expect(errorCode(error)).toBe("MAIL_CONNECT_DISABLED");
    expect(await t.run((ctx) => ctx.db.query("googleSyncRuns").collect())).toHaveLength(0);
  });

  test("a Gmail backfill start refuses before checking storage", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const connectionId = await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });

    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.googleConnect.startGoogleSyncRun, {
        workspaceId,
        connectionId,
        services: { gmail: true, calendar: false, chat: false },
      }),
    );

    expect(errorCode(error)).toBe("GOOGLE_SYNC_FORWARD_ONLY");
    expect(await t.run((ctx) => ctx.db.query("googleSyncRuns").collect())).toHaveLength(0);
  });

  test("a stale Gmail worker refuses shared workspaces", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await sharedScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const connectionId = await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    const now = Date.now();
    const runId = await t.run((ctx) =>
      ctx.db.insert("googleSyncRuns", {
        workspaceId,
        connectionId,
        requestedBy: owner,
        mode: "backfill",
        services: ["gmail"],
        status: "queued",
        requestedBackfillDays: 90,
        totalUnits: 90,
        completedUnits: 0,
        destinationFolder: "0-inbox/email/person-at-example-invalid",
        createdAt: now,
        updatedAt: now,
      }),
    );

    await expect(
      t.query(internal.functions.googleConnect.googleGmailBackfillForRun, {
        workspaceId,
        runId,
      }),
    ).resolves.toBeNull();
  });

  test("a stale failed Gmail worker cannot overwrite a newer completed pass", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    await seedConnectedStorage(t, workspaceId, owner);
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const connectionId = await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    const now = Date.now();
    const runId = await t.run((ctx) =>
      ctx.db.insert("googleSyncRuns", {
        workspaceId,
        connectionId,
        requestedBy: owner,
        mode: "backfill",
        services: ["gmail"],
        status: "queued",
        requestedBackfillDays: 90,
        totalUnits: 90,
        completedUnits: 0,
        destinationFolder: "0-inbox/email/person-at-example-invalid",
        createdAt: now,
        updatedAt: now,
      }),
    );
    await t.mutation(internal.functions.googleConnect.recordGoogleGmailBackfillPass, {
      runId,
      connectionId,
      fromUnit: 0,
      toUnit: 90,
      totalUnits: 90,
      itemsFound: 42,
      daysWithMail: 10,
      bytesWritten: 4096,
      status: "complete",
      historyId: "history-1",
    });

    const stale = await t.mutation(internal.functions.googleConnect.recordGoogleGmailBackfillPass, {
      runId,
      connectionId,
      fromUnit: 0,
      toUnit: 0,
      totalUnits: 90,
      itemsFound: 0,
      daysWithMail: 0,
      bytesWritten: 0,
      status: "failed",
      errorCode: "GOOGLE_SYNC_FAILED",
      error: "A stale worker failed late.",
    });

    expect(stale.accepted).toBe(false);
    const [row] = await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, {
      workspaceId,
    });
    expect(row?.syncRun).toMatchObject({
      status: "complete",
      itemsFound: 42,
      completedUnits: 90,
    });
    expect(row?.errorCode).toBeUndefined();
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

  test("a new Gmail bind with a current history id is ready for forward sync immediately", async () => {
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
      historyId: "baseline-12345",
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );
    expect(row?.gmail?.historyId).toBe("baseline-12345");
    expect(row?.health).toBe("active");
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

describe("the default destination folder is the package's answer, not a second one", () => {
  /*
    The bug this block exists for: Chat's default read
    "2-areas/communications/daily" while the package wrote `0-inbox/google-chat`
    whenever a caller passed no folder. Both were reachable — the control plane
    hands the sync a resolved folder — so which one a customer got depended on
    whether they had ever opened the destination field, and a Chat connection
    nobody had configured filed its days outside the Inbox altogether.

    Each assertion below compares this file's answer to the key the package
    writes with no folder chosen. That is deliberately not a comparison against
    a constant: two constants agreeing proves they were typed the same day, and
    what has to hold is that the control plane's default and the sync's own
    fallback name one folder.
  */
  const DAY = "2026-09-07";

  /** `2026/09` — the folders the package files a day under, since 2026-09-18. */
  const DATED = `${DAY.slice(0, 4)}/${DAY.slice(5, 7)}`;

  test("gmail defaults to the mailbox folder the package writes into", () => {
    const folder = defaultGoogleDestinationFolder("gmail", "person-at-example-invalid");
    expect(`${folder}/${DATED}/${DAY}.md`).toBe(
      channelDayNotePath({ channel: "email", account: "person-at-example-invalid", date: DAY }, {}),
    );
    expect(folder).toBe("0-inbox/email/person-at-example-invalid");
  });

  test("a connection with no slug yet still lands under the mail folder", () => {
    // `SLUG_FALLBACK`. Not a real mailbox, but it is inside `0-inbox/email/`,
    // which is the property that matters: unnamed mail is still mail.
    expect(defaultGoogleDestinationFolder("gmail", undefined)).toBe("0-inbox/email/mailbox");
  });

  /*
    Calendar and Chat take the account level too, since 2026-09-18 — two
    Google accounts were writing one file between them, which no folder rule
    in `privacy.md` could tell apart. The slug is only ever recorded, so an
    absent one still answers the folder these products have always used: that
    is what keeps an existing connection writing exactly where it was.
  */
  test("calendar defaults to this account's own folder under the calendar folder", () => {
    const folder = defaultGoogleDestinationFolder("calendar", "person-at-example-invalid");
    expect(`${folder}/${DATED}/${DAY}.md`).toBe(
      calendarDayNotePath({ date: DAY }, { folder }),
    );
    expect(folder).toBe("0-inbox/calendar/person-at-example-invalid");
  });

  test("...and a connection with no recorded slug keeps the folder it has always written to", () => {
    const folder = defaultGoogleDestinationFolder("calendar", undefined);
    expect(`${folder}/${DATED}/${DAY}.md`).toBe(calendarDayNotePath({ date: DAY }, {}));
    expect(folder).toBe("0-inbox/calendar");
  });

  test("chat defaults to this account's own folder under the Chat folder", () => {
    const folder = defaultGoogleDestinationFolder("chat", "person-at-example-invalid");
    expect(`${folder}/${DATED}/${DAY}.md`).toBe(
      channelDayNotePath(
        { channel: "google-chat", account: "person-at-example-invalid", date: DAY },
        {},
      ),
    );
    expect(folder).toBe("0-inbox/google-chat/person-at-example-invalid");
  });

  test("...and Chat too keeps the flat folder when no slug was ever recorded", () => {
    const folder = defaultGoogleDestinationFolder("chat", undefined);
    expect(`${folder}/${DATED}/${DAY}.md`).toBe(
      channelDayNotePath({ channel: "google-chat", date: DAY }, {}),
    );
    expect(folder).toBe("0-inbox/google-chat");
  });

  test("every default is inside the one inbox root", () => {
    // `docs/decisions/communications.md`, "A channel lands in `0-inbox`, and
    // there is no second inbox root" — that decision's own check, applied to
    // the one function that could file a sync anywhere else.
    for (const folder of [
      defaultGoogleDestinationFolder("gmail", "person-at-example-invalid"),
      defaultGoogleDestinationFolder("calendar", undefined),
      defaultGoogleDestinationFolder("chat", undefined),
    ]) {
      expect(folder.startsWith("0-inbox/")).toBe(true);
    }
  });
});
