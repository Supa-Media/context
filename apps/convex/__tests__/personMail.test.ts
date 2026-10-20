/**
 * A person's mail, read live from their own Gmail for what their synced notes
 * do not hold (`functions/lib/gatewayRoutes/personMail.ts`,
 * `docs/decisions/communications/reading-mail.md`).
 *
 * ## Sabotage record
 *
 * Dropping the `context:private` check let a read-and-write grant search the
 * mail, failing "a grant without private access reads no mail". Dropping the
 * owner check let an editor of Alice's workspace search her mail, failing "an
 * editor of the person's workspace never reaches their mail". Sending the
 * query without `outsideSyncQuery` failed "Gmail is asked only about mail the
 * notes do not hold". The old loop, which stopped once the first mailbox
 * filled the limit (2026-10-20), fails "every connected Gmail is searched…".
 * Folding `reconnect_required` mailboxes back into "no mailbox" fails "with
 * every mailbox needing reconnecting, the search says so…".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { addMember, createWorkspace, gatewayPost, seedGoogleConnection, seedStorageBinding } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { ACCESS_A, ACCESS_B, bodyOf, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { outsideSyncQuery } from "../functions/lib/gatewayRoutes/personMail";
import { PERSON_MAIL_READS_PER_HOUR } from "../functions/personMail";

const realFetch = globalThis.fetch;
const HOUR = 60 * 60 * 1000;

afterEach(() => {
  vi.unstubAllGlobals();
});

const b64 = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Gmail holding one message; every request's query string is recorded. */
function gmail() {
  const queries: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://gmail.googleapis.com/")) return await realFetch(input, init);
    const parsed = new URL(url);
    queries.push(parsed.searchParams.get("q") ?? `${parsed.pathname}?${parsed.searchParams.get("format")}`);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (parsed.pathname === "/gmail/v1/users/me/messages") return json({ messages: [{ id: "m1", threadId: "t1" }] });
    if (parsed.pathname === "/gmail/v1/users/me/messages/m1/attachments/att1") return json({ data: b64("%PDF-1.7 lease"), size: 14 });
    const headers = [
      { name: "From", value: "Jo <jo@example.invalid>" },
      { name: "To", value: "alice@gmail.example" },
      { name: "Subject", value: "The lease" },
    ];
    return json({
      id: "m1",
      threadId: "t1",
      internalDate: String(Date.parse("2024-03-02T10:00:00Z")),
      snippet: "Attached is the signed lease &amp; keys",
      payload: {
        mimeType: "multipart/mixed",
        headers,
        parts: [
          { mimeType: "text/plain", body: { data: b64("The signed lease is attached."), size: 29 } },
          { mimeType: "application/pdf", filename: "lease.pdf", body: { attachmentId: "att1", size: 14 } },
          { mimeType: "application/pdf", filename: "huge.pdf", body: { attachmentId: "att2", size: 30 * 1024 * 1024 } },
        ],
      },
    });
  });
  return queries;
}

type Tenants = Awaited<ReturnType<typeof twoConnectedTenants>>;

/** Alice's Gmail, connected a week ago and last synced an hour ago, and her grant with private access. */
async function connected() {
  const tenants = await twoConnectedTenants();
  const { t, alice, aliceWs, grantA } = tenants;
  const id = await seedGoogleConnection(t, { workspaceId: aliceWs, boundBy: alice, address: "alice@gmail.example" });
  const encryptedAccessToken = await encryptSecret("ya29.fake-access-token", requireKeyset(), { workspaceId: aliceWs });
  const row = await t.run((ctx) => ctx.db.get(id));
  await t.run((ctx) =>
    ctx.db.patch(id, {
      encryptedAccessToken,
      accessTokenExpiresAt: Date.now() + HOUR,
      createdAt: Date.now() - 7 * 24 * HOUR,
      gmail: { ...row!.gmail!, lastSyncedAt: Date.now() - HOUR },
    }),
  );
  await t.run((ctx) => ctx.db.patch(grantA, { scopes: ["context:read", "context:write", "context:private"] }));
  return { ...tenants, connectionId: id };
}

async function search(t: Tenants["t"], accessToken: string, workspaceId: string, extra: Record<string, unknown> = {}) {
  return await bodyOf(
    await gatewayPost(t, "/gateway/email/search", { accessToken, expectedWorkspaceId: workspaceId, query: "lease", outsideSync: true, ...extra }),
  );
}

describe("the query Gmail is asked", () => {
  test("only before the mailbox was connected and after its last pass", () => {
    expect(outsideSyncQuery("from:jo lease", { syncedFrom: 1_000_000, syncedThrough: 9_000_000 })).toBe(
      "(from:jo lease) {before:1000 after:5400}",
    );
  });
  test("a mailbox no pass has read is searched whole", () => {
    expect(outsideSyncQuery("lease", { syncedFrom: 1_000_000 })).toBe("lease");
  });
});

describe("reading a person's own mail live", () => {
  test("a search answers headers and a snippet, and each mailbox's folder for the synced half", async () => {
    const queries = gmail();
    const { t, aliceWs } = await connected();
    const answer = await search(t, ACCESS_A, aliceWs);
    expect(answer.ok).toBe(true);
    expect(answer.mailboxes).toEqual([{ address: "alice@gmail.example", folder: expect.any(String) }]);
    expect(answer.results).toEqual([
      expect.objectContaining({ address: "alice@gmail.example", id: "m1", subject: "The lease", snippet: "Attached is the signed lease & keys" }),
    ]);
    // Headers only for a search: no body was downloaded.
    expect(queries).toContain("/gmail/v1/users/me/messages/m1?metadata");
    expect(queries).not.toContain("/gmail/v1/users/me/messages/m1?full");
  });

  test("Gmail is asked only about mail the notes do not hold", async () => {
    const queries = gmail();
    const { t, aliceWs } = await connected();
    await search(t, ACCESS_A, aliceWs);
    expect(queries[0]).toMatch(/^\(lease\) \{before:\d+ after:\d+\}$/);
  });

  test("a read returns one message's words, and nothing of it is kept", async () => {
    gmail();
    const { t, aliceWs } = await connected();
    const answer = await bodyOf(
      await gatewayPost(t, "/gateway/email/read", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, address: "Alice@Gmail.example", id: "m1" }),
    );
    expect(answer).toMatchObject({ ok: true, message: { id: "m1", subject: "The lease", body: "The signed lease is attached." } });
    const stored = JSON.stringify(await t.run(async (ctx) => ({ limits: await ctx.db.query("rateLimits").collect(), audit: await ctx.db.query("auditEvents").collect() })));
    expect(stored).not.toContain("lease");
  });

  test("a read naming an attachment carries its bytes back from Gmail, and keeps none of them", async () => {
    const queries = gmail();
    const { t, aliceWs } = await connected();
    const read = (attachment: unknown) =>
      gatewayPost(t, "/gateway/email/read", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, address: "alice@gmail.example", id: "m1", attachment });
    const answer = await bodyOf(await read(1));
    expect(answer).toMatchObject({ ok: true, attachment: { filename: "lease.pdf", contentType: "application/pdf", data: btoa("%PDF-1.7 lease") } });
    expect(queries.some((query) => query.startsWith("/gmail/v1/users/me/messages/m1/attachments/att1"))).toBe(true);
    expect(await bodyOf(await read(2))).toEqual({ ok: false, refused: "too_large" });
    expect(await bodyOf(await read(3))).toEqual({ ok: false, refused: "not_found" });
    expect(await bodyOf(await read(0))).toEqual({ ok: false, refused: "invalid" });
    expect(await bodyOf(await read("1"))).toEqual({ ok: false, refused: "invalid" });
    const stored = JSON.stringify(await t.run(async (ctx) => ({ limits: await ctx.db.query("rateLimits").collect(), audit: await ctx.db.query("auditEvents").collect() })));
    expect(stored).not.toContain("lease");
  });

  test("a read must name a mailbox the person connected", async () => {
    gmail();
    const { t, aliceWs } = await connected();
    const answer = await bodyOf(
      await gatewayPost(t, "/gateway/email/read", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, address: "ceo@bank.example", id: "m1" }),
    );
    expect(answer).toEqual({ ok: false, refused: "no_mailbox" });
  });

  test("a grant without private access reads no mail", async () => {
    const queries = gmail();
    const { t, aliceWs, grantA } = await connected();
    await t.run((ctx) => ctx.db.patch(grantA, { scopes: ["context:read", "context:write"] }));
    expect(await search(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "not_allowed" });
    expect(queries).toHaveLength(0);
  });

  test("another tenant's token never reaches the person's mail", async () => {
    const queries = gmail();
    const { t, aliceWs } = await connected();
    expect(await search(t, ACCESS_B, aliceWs)).toEqual({ ok: false, refused: "not_allowed" });
    expect(queries).toHaveLength(0);
  });

  test("an editor of the person's workspace never reaches their mail", async () => {
    const queries = gmail();
    const { t, aliceWs, bob, grantB } = await connected();
    await addMember(t, aliceWs, bob, "editor");
    await t.run((ctx) => ctx.db.patch(grantB, { scopes: ["context:read", "context:write", "context:private"] }));
    expect(await search(t, ACCESS_B, aliceWs)).toEqual({ ok: false, refused: "not_allowed" });
    expect(queries).toHaveLength(0);
  });

  test("a grant on a shared workspace never reaches its person's own mail", async () => {
    const queries = gmail();
    const { t, alice } = await connected();
    const shared = await createWorkspace(t, alice, "alfa-team", { kind: "shared" });
    await seedStorageBinding(t, { workspaceId: shared, boundBy: alice, bucket: "tenant-a-team" });
    expect(await search(t, ACCESS_A, shared)).toEqual({ ok: false, refused: "not_allowed" });
    expect(queries).toHaveLength(0);
  });

  test("a disconnected mailbox is not read", async () => {
    const queries = gmail();
    const { t, aliceWs, connectionId } = await connected();
    await t.run((ctx) => ctx.db.patch(connectionId, { disconnectedAt: Date.now() }));
    expect(await search(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "no_mailbox" });
    expect(queries).toHaveLength(0);
  });

  test("every connected Gmail is searched, and the results are shared between them", async () => {
    const { t, aliceWs, alice } = await connected();
    // Two more of Alice's Gmails, each with its own token.
    for (const address of ["alice.work@gmail.example", "alice.church@gmail.example"]) {
      const id = await seedGoogleConnection(t, { workspaceId: aliceWs, boundBy: alice, address, googleAccountId: address });
      const encryptedAccessToken = await encryptSecret(`ya29.fake-${address}`, requireKeyset(), { workspaceId: aliceWs });
      const row = await t.run((ctx) => ctx.db.get(id));
      await t.run((ctx) =>
        ctx.db.patch(id, { encryptedAccessToken, accessTokenExpiresAt: Date.now() + HOUR, gmail: { ...row!.gmail!, mailboxSlug: address } }),
      );
    }
    // Each Gmail holds twenty matches, more than the whole limit.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://gmail.googleapis.com/")) return await realFetch(input, init);
      const parsed = new URL(url);
      const who = String(new Headers(init?.headers).get("authorization")).replace(/^Bearer ya29\.fake-?/, "") || "first";
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      if (parsed.pathname === "/gmail/v1/users/me/messages") {
        const wanted = Number(parsed.searchParams.get("maxResults") ?? 20);
        return json({ messages: Array.from({ length: Math.min(20, wanted) }, (_, i) => ({ id: `${who.length}x${i}` })) });
      }
      const id = parsed.pathname.split("/").at(-1);
      return json({ id, threadId: id, internalDate: "0", snippet: who, payload: { headers: [{ name: "Subject", value: who }] } });
    });
    const answer = await search(t, ACCESS_A, aliceWs, { outsideSync: false, limit: 9 });
    const results = answer.results as Array<{ address: string }>;
    const by = (address: string) => results.filter((result) => result.address === address).length;
    expect(results).toHaveLength(9);
    expect([by("alice@gmail.example"), by("alice.work@gmail.example"), by("alice.church@gmail.example")]).toEqual([3, 3, 3]);
  });

  test("an hour holds a bounded number of reads", async () => {
    gmail();
    const { t, aliceWs } = await connected();
    const owner = await t.run(async (ctx) => (await ctx.db.get(aliceWs))!.createdBy);
    await t.run((ctx) =>
      ctx.db.insert("rateLimits", { key: `person.mail.read:${owner}`, windowStartedAt: Date.now(), count: PERSON_MAIL_READS_PER_HOUR }),
    );
    // ...naming the mailboxes, so their synced notes can answer instead.
    expect(await search(t, ACCESS_A, aliceWs)).toEqual({
      ok: false,
      refused: "rate_limited",
      mailboxes: [{ address: "alice@gmail.example", folder: expect.any(String) }],
      reconnect: [],
    });
  });

  test("a mailbox whose sign-in stopped working is named for reconnecting, and the rest are searched", async () => {
    const queries = gmail();
    const { t, aliceWs, alice } = await connected();
    const broken = await seedGoogleConnection(t, { workspaceId: aliceWs, boundBy: alice, address: "old@gmail.example", googleAccountId: "old" });
    await t.run((ctx) => ctx.db.patch(broken, { health: "reconnect_required" }));
    const answer = await search(t, ACCESS_A, aliceWs);
    expect(answer.ok).toBe(true);
    expect(answer.reconnect).toEqual([{ address: "old@gmail.example", folder: expect.any(String) }]);
    expect(answer.mailboxes).toEqual([{ address: "alice@gmail.example", folder: expect.any(String) }]);
    expect(queries.length).toBeGreaterThan(0);
  });

  test("with every mailbox needing reconnecting, the search says so rather than that none is connected", async () => {
    const queries = gmail();
    const { t, aliceWs, connectionId } = await connected();
    await t.run((ctx) => ctx.db.patch(connectionId, { health: "reconnect_required" }));
    expect(await search(t, ACCESS_A, aliceWs)).toEqual({
      ok: false,
      refused: "reconnect_required",
      reconnect: [{ address: "alice@gmail.example", folder: expect.any(String) }],
    });
    expect(queries).toHaveLength(0);
  });

  test("a mailbox Gmail did not answer for is named", async () => {
    const { t, aliceWs } = await connected();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith("https://gmail.googleapis.com/")) return await realFetch(input, init);
      return new Response("{}", { status: 503 });
    });
    const answer = await search(t, ACCESS_A, aliceWs);
    expect(answer).toMatchObject({ ok: true, results: [], incomplete: true, unanswered: ["alice@gmail.example"] });
  });
});
