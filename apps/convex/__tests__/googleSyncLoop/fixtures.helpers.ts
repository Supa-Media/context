/**
 * THE FORWARD SYNC LOOP: who it polls, how often, and what it refuses.
 *
 * Every control in `functions/googleSync.ts` could be deleted with the rest of
 * this suite green unless a test names the sabotage it catches, so each
 * describe block below is one such name:
 *
 *  - the sweep starts a pass only for connections that are **due**, and never
 *    for a disconnected one, one with nothing this engine can sync, or one
 *    whose pass is still running;
 *  - the five-minute floor is refused **server-side**, not merely absent from
 *    a picker;
 *  - only the owner of a personal context may change the interval, and an
 *    owner of a *different* context cannot tell "not yours" from "no such
 *    connection" — proved with attacker and victim in ONE database, because
 *    two databases would make the refusal come from the row not existing;
 *  - the cursor advances over mail that was written and **not** over mail that
 *    was not;
 *  - a connection that has never synced does not look like one syncing fine.
 *
 * The end-to-end block drives the real `runFileOperation` — the credential
 * barrier — against a fixture Gmail and an in-memory S3, so the pass under
 * test is the pass that ships, including `gmailSync.js`'s own rendering.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { afterEach, vi } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  createUser,
  createWorkspace,
  seedGoogleConnection,
  setupTest,
  FAKE_STORAGE,
  type TestConvex,
} from "../fixtures.helpers";
import { memoryS3, type MemoryS3 } from "../storeStub.helpers";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { S3Store } from "../../../mcp/src/store/s3.js";

export const MINUTE = 60_000;

export function enableMailSync() {
  vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
  vi.stubEnv("CALENDAR_CONNECT_ENABLED", "true");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

export interface Scenario {
  t: TestConvex;
  owner: Id<"users">;
  workspaceId: Id<"workspaces">;
  connectionId: Id<"googleConnections">;
}

export async function scenario(): Promise<Scenario> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  const connectionId = await seedGoogleConnection(t, { workspaceId, boundBy: owner });
  return { t, owner, workspaceId, connectionId };
}

/** Patch the connection row directly — the states a sweep meets, without a pass to reach them. */
export async function patchConnection(
  t: TestConvex,
  connectionId: Id<"googleConnections">,
  patch: Record<string, unknown>,
): Promise<void> {
  await t.run((ctx) => ctx.db.patch(connectionId, patch));
}

export async function readConnection(t: TestConvex, connectionId: Id<"googleConnections">) {
  const row = await t.run((ctx) => ctx.db.get(connectionId));
  if (row === null) throw new Error("connection vanished");
  return row;
}

export async function sweep(t: TestConvex): Promise<{ started: number; examined: number }> {
  return await t.mutation(internal.functions.googleSync.sweepDueGoogleSyncs, {});
}

/* -------------------------------------------------------------------------- */


/* -------------------------------------------------------------------------- */
/*                   end to end, through the credential barrier               */
/* -------------------------------------------------------------------------- */

/**
 * A Gmail that answers the three calls a forward pass makes, and an S3 that
 * holds what it writes.
 *
 * Routed by host, so the pass exercises the real `S3Store` (real SigV4, real
 * XML) and the real `gmailSync.js` at the same time. Nothing here reaches the
 * network: `edge-runtime` has no DNS and a request to anything unrouted throws.
 */
export function googleAndBucket(options: {
  backend: MemoryS3;
  profileHistoryId?: string;
  history?:
    | { messageIds: string[]; historyId: string }
    | { expired: true }
    /**
     * A paged history, one entry per page, each carrying a record id — the
     * shape that exposes whether the walk's page limit is handled. Without
     * this the fixture could never return a `nextPageToken`, and paging was
     * the part of the real client nothing exercised.
     */
    | { pages: { recordId?: string; messageIds?: string[] }[]; historyId: string };
  messages?: { id: string; date: string; subject: string; text: string }[];
}) {
  const calls: string[] = [];
  const messages = options.messages ?? [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const base64Url = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    if (url.hostname !== "gmail.googleapis.com") {
      return await options.backend.fetchImpl(input, init);
    }
    calls.push(url.pathname);

    if (url.pathname === "/gmail/v1/users/me/profile") {
      return json({ historyId: options.profileHistoryId ?? "5000" });
    }
    if (url.pathname === "/gmail/v1/users/me/history") {
      if (options.history && "expired" in options.history) return json({ error: { code: 404 } }, 404);
      if (options.history && "pages" in options.history) {
        const index = Number(url.searchParams.get("pageToken") ?? "0");
        const page = options.history.pages[index];
        if (!page) return json({ history: [], historyId: options.history.historyId });
        const body: Record<string, unknown> = {
          history:
            page.recordId === undefined
              ? []
              : [
                  {
                    id: page.recordId,
                    messagesAdded: (page.messageIds ?? []).map((id) => ({ message: { id } })),
                  },
                ],
          // Every page carries the MAILBOX head, which is the whole trap.
          historyId: options.history.historyId,
        };
        if (index + 1 < options.history.pages.length) body.nextPageToken = String(index + 1);
        return json(body);
      }
      const history = options.history ?? { messageIds: [], historyId: "1000" };
      return json({
        history: history.messageIds.map((id) => ({ messagesAdded: [{ message: { id } }] })),
        historyId: history.historyId,
      });
    }
    const single = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
    if (single) {
      const message = messages.find((candidate) => candidate.id === single[1]);
      if (!message) return json({ error: { code: 404 } }, 404);
      return json({
        id: message.id,
        threadId: `thread-${message.id}`,
        internalDate: String(Date.parse(message.date)),
        payload: {
          mimeType: "multipart/mixed",
          headers: [
            { name: "From", value: "Sender Example <sender@example.invalid>" },
            { name: "To", value: "person@example.invalid" },
            { name: "Subject", value: message.subject },
          ],
          parts: [
            { mimeType: "text/plain", body: { size: message.text.length, data: base64Url(message.text) } },
          ],
        },
      });
    }
    if (url.pathname === "/gmail/v1/users/me/messages") {
      const query = url.searchParams.get("q") ?? "";
      const after = /after:(\d+)/.exec(query);
      const before = /before:(\d+)/.exec(query);
      const from = after ? Number(after[1]) * 1000 : -Infinity;
      const to = before ? Number(before[1]) * 1000 : Infinity;
      const matching = messages.filter((message) => {
        const at = Date.parse(message.date);
        return at >= from && at < to;
      });
      return json({
        messages: matching.map((message) => ({ id: message.id, threadId: `thread-${message.id}` })),
        resultSizeEstimate: matching.length,
      });
    }
    return json({ error: { code: 404 } }, 404);
  };

  return { fetchImpl, calls };
}

export function chatAndBucket(options: { backend: MemoryS3 }) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    if (url.hostname !== "chat.googleapis.com") {
      return await options.backend.fetchImpl(input, init);
    }
    calls.push(url.pathname);
    if (url.pathname === "/v1/spaces") {
      return json({
        spaces: [
          {
            name: "spaces/alpha",
            displayName: "Engineering",
            spaceType: "SPACE",
            spaceHistoryState: "HISTORY_ON",
          },
        ],
      });
    }
    if (url.pathname === "/v1/spaces/alpha/messages") {
      return json({
        messages: [
          {
            name: "spaces/alpha/messages/msg-1",
            createTime: "2026-09-12T10:00:00.000Z",
            text: "Ship the live Chat bridge",
            thread: { name: "spaces/alpha/threads/thread-1" },
            sender: { name: "users/adam", displayName: "Adam Okonkwo" },
          },
        ],
      });
    }
    return json({ error: { code: 404 } }, 404);
  };
  return { fetchImpl, calls };
}

export function calendarAndBucket(options: { backend: MemoryS3; items?: Record<string, unknown>[] }) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    if (url.hostname !== "www.googleapis.com") {
      return await options.backend.fetchImpl(input, init);
    }
    calls.push(url.pathname);
    if (url.pathname === "/calendar/v3/calendars/primary/events") {
      return json({
        timeZone: "America/New_York",
        nextSyncToken: "calendar-token-2",
        items: options.items ?? [
          {
            id: "event-1",
            status: "confirmed",
            summary: "Design review",
            start: { dateTime: "2026-09-13T14:00:00.000Z" },
            end: { dateTime: "2026-09-13T14:30:00.000Z" },
          },
        ],
      });
    }
    return json({ error: { code: 404 } }, 404);
  };
  return { fetchImpl, calls };
}

export async function endToEnd(options: {
  historyId?: string;
  quotaBytes?: number;
  storage?: "connected" | "missing";
} = {}) {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  const connectionId = await seedGoogleConnection(t, { workspaceId, boundBy: owner });
  const keyset = requireKeyset();

  await t.run(async (ctx) => {
    const row = (await ctx.db.get(connectionId))!;
    await ctx.db.patch(connectionId, {
      gmail: {
        ...row.gmail!,
        historyId: options.historyId,
        quotaBytes: options.quotaBytes ?? 1_000_000_000,
      },
      // A cached access token, so the pass never calls Google's token
      // endpoint: what is under test here is the sync, not the refresh.
      encryptedAccessToken: await encryptSecret("example-access-token-not-real", keyset, {
        workspaceId,
      }),
      accessTokenExpiresAt: Date.now() + 30 * MINUTE,
      syncStartedAt: Date.now(),
    });
    if (options.storage !== "missing") {
      await ctx.db.insert("storageBindings", {
        workspaceId,
        provider: FAKE_STORAGE.provider,
        endpoint: FAKE_STORAGE.endpoint,
        region: FAKE_STORAGE.region,
        bucket: FAKE_STORAGE.bucket,
        accessKeyId: FAKE_STORAGE.accessKeyId,
        encryptedSecretAccessKey: await encryptSecret(FAKE_STORAGE.secretAccessKey, keyset, {
          workspaceId,
        }),
        capabilities: { conditionalWrite: true },
        status: "connected" as const,
        lastVerifiedAt: Date.now(),
        boundBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  });

  const backend = memoryS3(FAKE_STORAGE.bucket);
  return { t, owner, workspaceId, connectionId, backend };
}

export async function runPass(t: TestConvex, workspaceId: Id<"workspaces">, connectionId: Id<"googleConnections">) {
  return await t.action(internal.functions.files.runFileOperation, {
    workspaceId,
    scope: "private" as const,
    operation: { kind: "googleForwardSync" as const, connectionId },
  });
}

