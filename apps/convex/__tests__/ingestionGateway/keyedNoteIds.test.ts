/// <reference types="vite/client" />

/**
 * The email worker's id-layer routes (`lib/noteIds/ingestHttp.ts`): how a
 * capture reads, writes and adopts a note in a keyed workspace.
 *
 * What is proved here, route by route:
 *  - every route is behind the email worker's secret, and a ticket is needed;
 *  - a ticket qualifies only once its credential has been issued (binding spent);
 *  - a ticket opens its own workspace and no other, so no body field selects one;
 *  - only paths under the inbox folder the ticket recorded are answered or written;
 *  - adopt gives a new capture a keyed row at its own id key, and lookup reports it;
 *  - there is no `removed` route for mail.
 *
 * Sabotage: drop the `isInboxPath` check in `ingestHttp.ts` and the outside-inbox
 * cases fail; drop the `bindingIssuedAt` check in `ticketInbox` and the unbound
 * case fails.
 *
 * Every value here is obviously fake.
 */

import { describe, expect, test } from "vitest";
import { isInboxPath } from "../../functions/lib/noteIds/ingestHttp";
import type { Id } from "../../_generated/dataModel";
import {
  type TestConvex,
  createUser,
  createWorkspace,
  ingestPost,
  seedStorageBinding,
} from "../fixtures.helpers";
import { BINDING, ready, resolvedTicket } from "./fixtures.helpers";

const LOOKUP = "/gateway/ingest/note-ids/lookup";
const WROTE = "/gateway/ingest/note-ids/wrote";
const ADOPT = "/gateway/ingest/note-ids/adopt";

const PATH = "0-inbox/email/0123456789abcdef01234567.md";
const NOTE = "0190c0de-0000-7000-8000-00000000b001";
const NOTE_KEY = `notes/${NOTE}.md`;
const OTHER_NOTE = "0190c0de-0000-7000-8000-00000000b002";

// The first route call in a file pays the cold start of the whole function bundle.
const COLD = 30_000;

/** The keyed layout: the switch at `keys` and the flip begun (`lib/noteIds/keyedState.ts`). */
async function keyOn(t: TestConvex, workspaceId: Id<"workspaces">) {
  await t.run(async (ctx) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    const fields = { mode: "keys" as const, updatedAt: 1 };
    if (layout === null) await ctx.db.insert("noteIdLayout", { paused: false, ...fields });
    else await ctx.db.patch(layout._id, fields);
    await ctx.db.insert("noteIdCopies", {
      workspaceId,
      status: "done",
      runId: 1,
      files: 0,
      copied: 0,
      failed: 0,
      failures: [],
      updatedAt: 1,
      keyedAt: 1,
    });
  });
}

/** A ticket minted by resolve and spent on the credential route, as the worker does before any id call. */
async function boundTicket(t: TestConvex, name: string): Promise<string> {
  const ticket = await resolvedTicket(t, name);
  await ingestPost(t, BINDING, { ticket });
  return ticket;
}

function lookup(t: TestConvex, ticket: string, paths: string[]) {
  return ingestPost(t, LOOKUP, { ticket, paths });
}

function adoptBody(ticket: string, overrides: Record<string, unknown> = {}) {
  return { ticket, path: PATH, noteId: NOTE, key: NOTE_KEY, etag: "e1", size: 10, at: 1_000, ...overrides };
}

describe("the id-layer routes for a capture", () => {
  test("a keyed workspace adopts a capture at its id key, and lookup reports the row", async () => {
    const { t, workspaceId } = await ready();
    await keyOn(t, workspaceId);
    const ticket = await boundTicket(t, "seyi");

    const adopted = await (await ingestPost(t, ADOPT, adoptBody(ticket))).json();
    expect(adopted).toEqual({ ok: true, adopted: true, taken: null });

    const body = await (await lookup(t, ticket, [PATH])).json();
    expect(Object.keys(body).sort()).toEqual(["copies", "keyed", "notes"]);
    expect(body.keyed).toBe(true);
    expect(body.notes[PATH]).toMatchObject({ state: "keyed", key: NOTE_KEY, etag: "e1", noteId: NOTE });
  }, COLD);

  test("lookup answers the same shape in a workspace that is not keyed", async () => {
    const { t } = await ready();
    const ticket = await boundTicket(t, "seyi");
    const body = await (await lookup(t, ticket, [PATH])).json();
    expect(body).toEqual({ copies: {}, keyed: false, notes: {} });
  });

  test("wrote records the key's new version on the row", async () => {
    const { t, workspaceId } = await ready();
    await keyOn(t, workspaceId);
    const ticket = await boundTicket(t, "seyi");
    await ingestPost(t, ADOPT, adoptBody(ticket));

    const recorded = await (
      await ingestPost(t, WROTE, { ticket, path: PATH, key: NOTE_KEY, etag: "e2", keyed: true, at: 2_000, size: 12 })
    ).json();
    expect(recorded).toEqual({ ok: true, recorded: true });
    const body = await (await lookup(t, ticket, [PATH])).json();
    expect(body.notes[PATH].etag).toBe("e2");
  });

  test("wrote with the wrong key, or without keyed, records nothing", async () => {
    const { t, workspaceId } = await ready();
    await keyOn(t, workspaceId);
    const ticket = await boundTicket(t, "seyi");
    await ingestPost(t, ADOPT, adoptBody(ticket));

    const wrongKey = await (
      await ingestPost(t, WROTE, { ticket, path: PATH, key: `notes/${OTHER_NOTE}.md`, etag: "e9", keyed: true, at: 2_000 })
    ).json();
    expect(wrongKey).toEqual({ ok: true, recorded: false });

    const unkeyed = await (await ingestPost(t, WROTE, { ticket, path: PATH, key: NOTE_KEY, etag: "e9", at: 2_000 })).json();
    expect(unkeyed).toEqual({ ok: true, recorded: false });

    const body = await (await lookup(t, ticket, [PATH])).json();
    expect(body.notes[PATH].etag).toBe("e1");
  });

  test("adopt names the holder when the name is taken by another note", async () => {
    const { t, workspaceId } = await ready();
    await keyOn(t, workspaceId);
    const ticket = await boundTicket(t, "seyi");
    await ingestPost(t, ADOPT, adoptBody(ticket));

    const second = await (await ingestPost(t, ADOPT, adoptBody(ticket, { noteId: OTHER_NOTE, key: `notes/${OTHER_NOTE}.md` }))).json();
    expect(second.ok).toBe(true);
    expect(second.adopted).toBe(false);
    expect(second.taken).toMatchObject({ state: "keyed", noteId: NOTE });
  });
});

describe("what a ticket may reach", () => {
  test("a ticket whose credential was never issued is refused", async () => {
    const { t, workspaceId } = await ready();
    await keyOn(t, workspaceId);
    const ticket = await resolvedTicket(t, "seyi");
    expect(await (await lookup(t, ticket, [PATH])).json()).toEqual({ served: false });
    expect(await (await ingestPost(t, ADOPT, adoptBody(ticket))).json()).toEqual({ served: false });
  });

  test("an unknown ticket is refused, the same bytes as any other refusal", async () => {
    const { t } = await ready();
    expect(await (await lookup(t, "not-a-ticket-at-all", [PATH])).json()).toEqual({ served: false });
  });

  test("the worker's secret is required", async () => {
    const { t } = await ready();
    const ticket = await boundTicket(t, "seyi");
    const response = await ingestPost(t, LOOKUP, { ticket, paths: [PATH] }, { secret: null });
    expect(response.status).toBe(401);
  });

  test("an expired ticket is refused", async () => {
    const { t, workspaceId } = await ready();
    await keyOn(t, workspaceId);
    const ticket = await boundTicket(t, "seyi");
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("ingestionTickets").collect()) await ctx.db.patch(row._id, { expiresAt: 1 });
    });
    expect(await (await ingestPost(t, ADOPT, adoptBody(ticket))).json()).toEqual({ served: false });
  });

  test("a ticket opens its own workspace, and never another one's rows", async () => {
    const { t, workspaceId } = await ready();
    await keyOn(t, workspaceId);
    const seyi = await boundTicket(t, "seyi");
    await ingestPost(t, ADOPT, adoptBody(seyi));

    const beaId = await createUser(t, "bea@example.test");
    const bea = await createWorkspace(t, beaId, "bea", { kind: "personal" });
    await seedStorageBinding(t, { workspaceId: bea, boundBy: beaId, status: "connected" });
    await keyOn(t, bea);
    const beaTicket = await boundTicket(t, "bea");

    const seen = await (await lookup(t, beaTicket, [PATH])).json();
    expect(seen.notes).toEqual({});
    expect(await (await ingestPost(t, WROTE, { ticket: beaTicket, path: PATH, key: NOTE_KEY, etag: "e7", keyed: true, at: 3_000 })).json()).toEqual({
      ok: true,
      recorded: false,
    });
  });
});

describe("the inbox bound", () => {
  test.each([
    ["a path outside the inbox", "1-projects/plan.md"],
    ["a plumbing path inside the inbox", "0-inbox/.history/x.md"],
    ["a dot segment escaping the inbox", "0-inbox/../x.md"],
    ["the inbox folder itself", "0-inbox/"],
  ])("adopt refuses %s", async (_label, path) => {
    const { t, workspaceId } = await ready();
    await keyOn(t, workspaceId);
    const ticket = await boundTicket(t, "seyi");
    expect(await (await ingestPost(t, ADOPT, adoptBody(ticket, { path }))).json()).toEqual({ served: false });
  });

  test("lookup refuses the whole request if one path is outside the inbox", async () => {
    const { t, workspaceId } = await ready();
    await keyOn(t, workspaceId);
    const ticket = await boundTicket(t, "seyi");
    expect(await (await lookup(t, ticket, [PATH, "1-projects/plan.md"])).json()).toEqual({ served: false });
  });

  test("the bound accepts the inbox and rejects its neighbours (pure)", () => {
    expect(isInboxPath("0-inbox/", PATH)).toBe(true);
    expect(isInboxPath("0-inbox/", "0-inbox/a/b/c.md")).toBe(true);
    expect(isInboxPath("0-inbox/", "0-inboxes/a.md")).toBe(false);
    expect(isInboxPath("0-inbox/", "0-inbox/.audit/a.json")).toBe(false);
    expect(isInboxPath("0-inbox/", "0-inbox/a//b.md")).toBe(false);
    expect(isInboxPath("0-inbox", "0-inbox/a.md")).toBe(false);
  });
});

describe("no removal for mail", () => {
  const SOURCES = import.meta.glob("../../http.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

  test("the route table has no removed route for the email worker", () => {
    const source = Object.values(SOURCES)[0];
    expect(source).toContain("/gateway/ingest/note-ids/lookup");
    expect(source).not.toContain("/gateway/ingest/note-ids/removed");
  });
});
