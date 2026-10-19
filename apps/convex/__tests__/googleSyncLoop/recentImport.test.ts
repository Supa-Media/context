/**
 * THE FIRST-CONNECT GMAIL IMPORT, through the credential barrier.
 *
 * Owner decision, 2026-10-17: on a first Gmail connect Tex reads the last
 * fifty emails. `apps/mcp/test/gmailSync/recentImport.test.mjs` proves what the
 * import reads and writes; this suite proves who gets one, how often, and that
 * it changes nothing about forward-only sync:
 *
 *  - only a row Gmail has never been on is marked — never a reconnect, a
 *    revived row, or a row older than the import;
 *  - it runs once, through `runFileOperation`, and the next pass is the
 *    ordinary forward pass from the cursor the connect stored;
 *  - a failure spends an attempt and, after the last, Gmail syncs without it;
 *  - the historical backfill stays refused.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import { asUser, createUser, createWorkspace, errorCode, setupTest } from "../fixtures.helpers";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { RECENT_IMPORT_MAX_ATTEMPTS } from "../../functions/lib/googleConnect/recentImport";
import { gmailBindingArgs } from "../googleConnect/fixtures.helpers";
import {
  enableMailSync,
  endToEnd,
  googleAndBucket,
  patchConnection,
  readConnection,
  runPass,
} from "./fixtures.helpers";

/** A forward pass: history, then today's and yesterday's day lists (`reconcileDays`); no message is fetched. */
const FORWARD_PASS = ["/gmail/v1/users/me/history", "/gmail/v1/users/me/messages", "/gmail/v1/users/me/messages"];

const PENDING = { status: "pending" as const, attempts: 0 };

/** Sixty messages over three days, the newest on 2026-10-16. */
const MAILBOX = ["2026-10-16", "2026-10-15", "2026-10-14"].flatMap((date, dayIndex) =>
  Array.from({ length: 20 }, (_, index) => ({
    id: `m${dayIndex}-${index}`,
    date: new Date(Date.parse(`${date}T20:00:00.000Z`) - index * 60_000).toISOString(),
    subject: `Subject ${dayIndex}-${index}`,
    text: "Body text.",
  })),
);

function dayNotes(snapshot: Record<string, string>) {
  return Object.keys(snapshot).filter((key) => /\/\d{4}-\d{2}-\d{2}\.md$/.test(key)).sort();
}

describe("who is owed an import", () => {
  beforeEach(() => enableMailSync());

  async function bind(t: ReturnType<typeof setupTest>, workspaceId: any, owner: any) {
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    return await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
      historyId: "4000",
    });
  }

  test("a first Gmail connect marks the import, and a reconnect does not re-arm it", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");
    const connectionId = await bind(t, workspaceId, owner);
    expect((await readConnection(t, connectionId)).gmail?.recentImport).toEqual(PENDING);

    const finished = { status: "done" as const, attempts: 0, completedAt: 1, messages: 50 };
    const row = await readConnection(t, connectionId);
    await patchConnection(t, connectionId, { gmail: { ...row.gmail!, recentImport: finished } });
    expect(await bind(t, workspaceId, owner)).toBe(connectionId);
    expect((await readConnection(t, connectionId)).gmail?.recentImport).toEqual(finished);
  });

  test("a row revived after a disconnect is not a first connect", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");
    const connectionId = await bind(t, workspaceId, owner);
    const row = await readConnection(t, connectionId);
    await patchConnection(t, connectionId, {
      gmail: { ...row.gmail!, recentImport: { status: "done", attempts: 0, completedAt: 1, messages: 3 } },
      disconnectedAt: Date.now(),
      encryptedRefreshToken: "",
    });
    await bind(t, workspaceId, owner);
    expect((await readConnection(t, connectionId)).gmail?.recentImport?.status).toBe("done");
  });

  test("a row connected before the import existed never gets one", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");
    const connectionId = await bind(t, workspaceId, owner);
    const row = await readConnection(t, connectionId);
    await patchConnection(t, connectionId, { gmail: { ...row.gmail!, recentImport: undefined } });
    await bind(t, workspaceId, owner);
    expect((await readConnection(t, connectionId)).gmail?.recentImport).toBeUndefined();
  });

  test("the historical backfill is still refused", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "atlas");
    const connectionId = await bind(t, workspaceId, owner);
    let error: unknown;
    try {
      await asUser(t, owner).mutation(api.functions.googleConnect.startGoogleSyncRun, {
        workspaceId,
        connectionId,
        services: { gmail: true, calendar: false, chat: false },
      });
    } catch (caught) {
      error = caught;
    }
    expect(errorCode(error)).toBe("GOOGLE_SYNC_FORWARD_ONLY");
  });
});

describe("the import, end to end", { timeout: 30_000 }, () => {
  beforeEach(() => enableMailSync());

  async function pendingConnection(historyId?: string) {
    const setup = await endToEnd({ historyId });
    const row = await readConnection(setup.t, setup.connectionId);
    await patchConnection(setup.t, setup.connectionId, { gmail: { ...row.gmail!, recentImport: PENDING } });
    return setup;
  }

  test("a first connect reads the fifty most recent messages and writes the days they land on", async () => {
    const { t, owner, workspaceId, connectionId, backend } = await pendingConnection("4000");
    const google = googleAndBucket({ backend, messages: MAILBOX });
    vi.stubGlobal("fetch", google.fetchImpl);

    const result = await runPass(t, workspaceId, connectionId);

    expect(result).toMatchObject({ kind: "googleForwardSync", status: "synced", daysTouched: 3 });
    // One list of fifty with no date in it, then each day's own list.
    const lists = google.listQueries.filter((query) => query !== "");
    expect(new URLSearchParams(lists[0]).get("maxResults")).toBe("50");
    expect(new URLSearchParams(lists[0]).get("q")).not.toMatch(/after:|before:/);
    // No history and no profile: the cursor the connect stored is untouched.
    expect(google.calls).not.toContain("/gmail/v1/users/me/history");
    expect(google.calls).not.toContain("/gmail/v1/users/me/profile");

    const written = backend.snapshot();
    expect(dayNotes(written)).toHaveLength(3);
    const row = await readConnection(t, connectionId);
    expect(row.gmail?.historyId).toBe("4000");
    expect(row.gmail?.recentImport).toMatchObject({ status: "done", messages: 60 });
    expect(row.gmail?.lastSyncedAt).toBeTypeOf("number");

    // Audited against the person whose grant it used, with counts only.
    const events = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .filter((q) => q.eq(q.field("action"), "google_sync_wrote"))
        .collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).toBe(owner);
    expect(JSON.stringify(events[0])).not.toContain("Subject");
  });

  test("the next pass is the ordinary forward pass, and the import is not repeated", async () => {
    const { t, workspaceId, connectionId, backend } = await pendingConnection("4000");
    vi.stubGlobal("fetch", googleAndBucket({ backend, messages: MAILBOX }).fetchImpl);
    await runPass(t, workspaceId, connectionId);
    const before = backend.snapshot();

    await patchConnection(t, connectionId, { syncStartedAt: Date.now() });
    const next = googleAndBucket({ backend, messages: MAILBOX, history: { messageIds: [], historyId: "4100" } });
    vi.stubGlobal("fetch", next.fetchImpl);
    await runPass(t, workspaceId, connectionId);

    expect(next.calls).toEqual(FORWARD_PASS);
    expect((await readConnection(t, connectionId)).gmail?.historyId).toBe("4100");
    expect(backend.snapshot()).toEqual(before);
  });

  test("a connection with no import owed syncs forward and reads no history it was not given", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "4000" });
    const google = googleAndBucket({ backend, messages: MAILBOX, history: { messageIds: [], historyId: "4100" } });
    vi.stubGlobal("fetch", google.fetchImpl);

    await runPass(t, workspaceId, connectionId);

    expect(google.calls).toEqual(FORWARD_PASS);
    expect(dayNotes(backend.snapshot())).toEqual([]);
  });

  test("a row with no cursor takes its baseline before it reads", async () => {
    const { t, workspaceId, connectionId, backend } = await pendingConnection(undefined);
    const google = googleAndBucket({ backend, messages: MAILBOX, profileHistoryId: "7000" });
    vi.stubGlobal("fetch", google.fetchImpl);

    await runPass(t, workspaceId, connectionId);

    expect(google.calls[0]).toBe("/gmail/v1/users/me/profile");
    const row = await readConnection(t, connectionId);
    expect(row.gmail?.historyId).toBe("7000");
    expect(row.gmail?.recentImport?.status).toBe("done");
  });

  test("a retry after a failure writes nothing twice", async () => {
    const { t, workspaceId, connectionId, backend } = await pendingConnection("4000");
    vi.stubGlobal("fetch", googleAndBucket({ backend, messages: MAILBOX }).fetchImpl);
    await runPass(t, workspaceId, connectionId);
    const first = backend.snapshot();
    // As if the record of that pass had been lost: the import is owed again.
    const row = await readConnection(t, connectionId);
    await patchConnection(t, connectionId, { gmail: { ...row.gmail!, recentImport: PENDING }, syncStartedAt: Date.now() });

    vi.stubGlobal("fetch", googleAndBucket({ backend, messages: MAILBOX }).fetchImpl);
    const again = await runPass(t, workspaceId, connectionId);

    expect(again).toMatchObject({ status: "synced", bytesWritten: 0 });
    expect(backend.snapshot()).toEqual(first);
  });

  test("a failing import spends its attempts, then Gmail syncs forward without it", async () => {
    const { t, workspaceId, connectionId, backend } = await pendingConnection("4000");
    // Each attempt as if Gmail's own backoff had run out (`retryAt`).
    const backoffOver = async () => {
      const row = await readConnection(t, connectionId);
      await patchConnection(t, connectionId, { gmail: { ...row.gmail!, retryAt: undefined }, syncStartedAt: Date.now() });
    };
    for (let attempt = 1; attempt <= RECENT_IMPORT_MAX_ATTEMPTS; attempt += 1) {
      await backoffOver();
      vi.stubGlobal("fetch", googleAndBucket({ backend, messages: MAILBOX, listStatus: 500 }).fetchImpl);
      const result = await runPass(t, workspaceId, connectionId);
      expect(result).toMatchObject({ status: "failed" });
      expect((await readConnection(t, connectionId)).gmail?.recentImport?.attempts).toBe(attempt);
    }
    expect((await readConnection(t, connectionId)).gmail?.recentImport?.status).toBe("abandoned");

    await backoffOver();
    const forward = googleAndBucket({ backend, messages: MAILBOX, history: { messageIds: [], historyId: "4100" } });
    vi.stubGlobal("fetch", forward.fetchImpl);
    await runPass(t, workspaceId, connectionId);
    expect(forward.calls).toEqual(FORWARD_PASS);
    expect((await readConnection(t, connectionId)).gmail?.historyId).toBe("4100");
  });

  test("a disconnected account is never imported", async () => {
    const { t, workspaceId, connectionId, backend } = await pendingConnection("4000");
    await patchConnection(t, connectionId, { disconnectedAt: Date.now() });
    const google = googleAndBucket({ backend, messages: MAILBOX });
    vi.stubGlobal("fetch", google.fetchImpl);

    await runPass(t, workspaceId, connectionId);

    expect(google.calls).toEqual([]);
    expect(dayNotes(backend.snapshot())).toEqual([]);
  });
});
