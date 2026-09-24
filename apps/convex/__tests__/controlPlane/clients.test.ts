import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { hashToken } from "../../functions/lib/crypto";
import {
  MAX_RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_RETENTION_MS,
} from "../../functions/lib/rateLimit";
import {
  gatewayPost,
  setupTest,
} from "../fixtures.helpers";
import {
  token,
  ACCESS_A,
  REFRESH_A,
  CLIENT_A,
  REDIRECT_URI,
  registerClient,
  twoConnectedTenants,
  bodyOf,
  startAndApprove,
} from "./fixtures.helpers";

/* 4. A database dump is inert                                                */
/* -------------------------------------------------------------------------- */

describe("a dump of the grants table plus the gateway secret is inert", () => {
  test("the stored value is a digest, not the token", async () => {
    const { t, grantA } = await twoConnectedTenants();
    const grant = await t.run((ctx) => ctx.db.get(grantA));
    expect(grant?.hashedAccessToken).toBe(await hashToken(ACCESS_A));
    expect(grant?.hashedAccessToken).not.toBe(ACCESS_A);
    expect(grant?.hashedRefreshToken).not.toBe(REFRESH_A);
  });

  test("replaying a stored hash as a token opens nothing, on any route", async () => {
    const { t, grantA, aliceWs } = await twoConnectedTenants();
    const grant = await t.run((ctx) => ctx.db.get(grantA));
    const storedAccess = grant!.hashedAccessToken as string;
    const storedRefresh = grant!.hashedRefreshToken;

    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/session", { accessToken: storedAccess }),
      ),
    ).toEqual({ session: null });

    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/binding", {
          accessToken: storedAccess,
          expectedWorkspaceId: aliceWs,
        }),
      ),
    ).toEqual({ binding: null });

    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/grants/rotate", {
          refreshToken: storedRefresh,
          clientId: CLIENT_A,
          newHashedRefreshToken: await hashToken("crt_thief_000000000000000000000"),
          newHashedAccessToken: await hashToken("cat_thief_000000000000000000000"),
          accessTokenExpiresAt: Date.now() + 3_600_000,
          scopes: null,
        }),
      ),
    ).toEqual({ grant: null });

    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/grants/revoke", {
          token: storedAccess,
          tokenType: "access",
          clientId: CLIENT_A,
        }),
      ),
    ).toEqual({ revoked: false });

    // …and the real token still works, so the grant was not collaterally killed
    // by the attempts above.
    expect(
      (await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: ACCESS_A })))
        .session,
    ).not.toBeNull();
  });

  test("an authorization code is stored as a digest too", async () => {
    const { t, alice, aliceWs } = await twoConnectedTenants();
    const { code } = await startAndApprove(t, { alice, aliceWs });
    const row = await t.run((ctx) =>
      ctx.db.query("oauthAuthorizations").first(),
    );
    expect(row?.hashedCode).toBe(await hashToken(code));
    expect(row?.hashedCode).not.toBe(code);

    // The stored digest is not spendable.
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/codes/consume", {
          code: row!.hashedCode,
          clientId: CLIENT_A,
        }),
      ),
    ).toEqual({ authorization: null });
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Client registration                                                     */
/* -------------------------------------------------------------------------- */

describe("/gateway/clients/register and /gateway/clients/get", () => {
  test("registers a client and reads it back in the documented shape", async () => {
    const t = setupTest();
    expect((await registerClient(t, "mcp_new")).status).toBe(200);
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/clients/get", { clientId: "mcp_new" }),
    );
    expect(body.client).toEqual({
      clientId: "mcp_new",
      clientName: "Client mcp_new",
      redirectUris: [REDIRECT_URI],
      hashedClientSecret: null,
      tokenEndpointAuthMethod: "none",
    });
  });

  /*
    REGISTRATION IS THE ONLY UNAUTHENTICATED WRITE IN THE CONTROL PLANE.

    RFC 7591 says the endpoint is open, and it is, deliberately. What it must
    not be is unbounded: the gateway mints a fresh `clientId` on every call, so
    the idempotency above does not bound anything reached from the public
    endpoint — a caller gets a new id and a new permanent row every time.
    `crons.ts` sweeps authorization requests, invitations, ingestion tickets,
    provisioning and stalled backfills, and never clients, so the rows are for
    ever.

    The limiter counts SUCCESSFUL mutations, which is the right unit here: the
    harm is rows that exist, not attempts that failed. Its own header says it
    is not a defence against somebody hammering an endpoint to make it fail,
    and this does not claim to be one.
  */
  test("a registrant cannot mint unbounded clients", async () => {
    const t = setupTest();
    // Restated, not imported: `grants.ts` does not export it, and a test that
    // reads the limit from the module it is testing cannot notice the limit
    // being changed. If this number and that one part company, this test says
    // so by failing.
    const OAUTH_REGISTER_LIMIT = 20;
    for (let i = 0; i < OAUTH_REGISTER_LIMIT; i += 1) {
      expect((await registerClient(t, `mcp_flood_${i}`, { registrantKey: "ip-a" })).status).toBe(200);
    }
    expect((await registerClient(t, "mcp_one_too_many", { registrantKey: "ip-a" })).status).toBe(429);
    expect(await t.run((ctx) => ctx.db.query("oauthClients").collect())).toHaveLength(
      OAUTH_REGISTER_LIMIT,
    );
  });

  test("...and the bucket is per registrant, so one flood is not a global outage", async () => {
    const OAUTH_REGISTER_LIMIT = 20;
    /*
      The positive twin, and the reason the limit is keyed rather than global.
      A single bucket for the whole internet turns "unbounded growth" into
      "anybody can switch registration off for everybody", which is a worse
      trade for a control plane: growth is permanent, an outage is not, but an
      outage somebody else chooses for you is not a fix.
    */
    const t = setupTest();
    for (let i = 0; i < OAUTH_REGISTER_LIMIT; i += 1) {
      await registerClient(t, `mcp_flood_${i}`, { registrantKey: "ip-a" });
    }
    expect((await registerClient(t, "mcp_blocked", { registrantKey: "ip-a" })).status).toBe(429);
    expect((await registerClient(t, "mcp_innocent", { registrantKey: "ip-b" })).status).toBe(200);
  });

  test("omitting the registrant key does not buy an unlimited bucket", async () => {
    const OAUTH_REGISTER_LIMIT = 20;
    /*
      `registrantKey` is optional so an older gateway keeps working, and AN
      OPTIONAL FIELD IS THE ONE A VALIDATOR CANNOT GUARD. If omitting it meant
      "unlimited", the whole limit would be one absent field away from off, and
      the caller who wants it off is exactly the one who would omit it.
      Everything with no key shares one bucket.
    */
    const t = setupTest();
    for (let i = 0; i < OAUTH_REGISTER_LIMIT; i += 1) {
      expect((await registerClient(t, `mcp_anon_${i}`)).status).toBe(200);
    }
    expect((await registerClient(t, "mcp_anon_extra")).status).toBe(429);
  });

  test("retention keeps a whole window of margin over the longest one allowed", async () => {
    /*
      THE MARGIN IS STRUCTURAL, AND IT USED TO BE ZERO.

      Retention was 24 hours against a docblock claiming the longest window
      "an hour". `invitationEmail.ts` has a 24-hour window, so retention
      EQUALLED the longest window and survived only because `consumeRateLimit`
      compares `>=` while the sweep compares `<` — the two line up exactly at
      the boundary, so the swept set stays a strict subset of the dead set.
      One comparison operator from refunding an anti-abuse budget.

      Pinned here rather than trusted to the derivation, so that somebody who
      "simplifies" `2 *` back to a literal has to come through this test.
    */
    expect(RATE_LIMIT_RETENTION_MS).toBe(2 * MAX_RATE_LIMIT_WINDOW_MS);
    expect(RATE_LIMIT_RETENTION_MS - MAX_RATE_LIMIT_WINDOW_MS).toBeGreaterThanOrEqual(
      MAX_RATE_LIMIT_WINDOW_MS,
    );
  });

  test("no caller uses a window the sweep would delete out from under it", async () => {
    /*
      The guard the retention constant cannot give itself. `consumeRateLimit`
      refuses an over-long window at the call, but a call site never exercised
      by a test would never reach that throw — so this reads the constants out
      of the source instead.

      THREE WAYS THE FIRST VERSION WAS BLIND, all measured by review:
      `readdirSync` is not recursive, so it saw 24 of 57 files and missed
      everything under `functions/lib/` and `functions/meetings/`; the value
      pattern could not match a numeric separator, so `60_000` read as "no
      constant here"; and the floor was set to 8, which is what the regex
      happened to return rather than what is there. A week-long window in
      `meetings/transcribe.ts` left it fully green.

      So: walk recursively, allow `_`, and derive the floor from the
      `consumeRateLimit(` call sites the same walk finds — a call site whose
      window this cannot resolve now breaks the floor instead of passing it.
    */
    const root = fileURLToPath(new URL("../../functions", import.meta.url));
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : entry.name.endsWith(".ts")
            ? [join(dir, entry.name)]
            : [],
      );
    const sources = walk(root).map((file) => readFileSync(file, "utf8"));

    const windows = new Map<string, number>();
    for (const source of sources) {
      for (const match of source.matchAll(/(\w*_WINDOW_MS)\s*=\s*([0-9_*\s]+);/g)) {
        windows.set(
          match[1],
          match[2]
            .split("*")
            .map((part) => Number(part.trim().replace(/_/g, "")))
            .reduce((product, part) => product * part, 1),
        );
      }
    }

    /*
      The positive twins, both of them. A walk that found nothing, or a pattern
      that matched nothing, would satisfy every assertion below while checking
      nothing — and the floor is the call sites rather than a number somebody
      wrote down, so adding a limiter with an inline literal breaks it.
    */
    /*
      EVERY CALL SITE MUST RESOLVE, rather than "at least nine of them".

      Two versions of this floor were calibrated to what the scan happened to
      return rather than to what is present, and both let through exactly the
      thing the scan exists to catch. The first asserted `>= 8` against ten
      constants. The second dropped unresolvable sites with a `.filter` and
      asserted `>= 9` — so a TENTH call site whose window the scan cannot read
      (a shorthand property, a local, a value from elsewhere) passed silently,
      measured green by review.

      So the sites are selected first and every one of them must resolve. The
      selector requires `ctx,` and so does not match `consumeRateLimit`'s own
      definition, whose signature is `ctx: MutationCtx` — no fudge factor, and
      no number anybody has to keep in step with the tree.

      Scanned forward from the call rather than matched as one expression: the
      `key` line above `windowMs` is a template literal, and `${...}` puts a
      `}` inside the object, so a `\{[^}]*windowMs` pattern stops at the key
      and finds 2 of 9. That was the first floor doing its job.
    */
    const callSites = sources.flatMap((source) =>
      [...source.matchAll(/consumeRateLimit\(\s*ctx,\s*\{/g)].map((match) => {
        /*
          BOUNDED TO THIS CALL'S OWN OBJECT LITERAL, not to a fixed distance.

          A flat 400-character window BLEEDS INTO THE NEXT CALL SITE: I proved
          it by injecting an unresolvable site immediately above a resolvable
          one, and the scan read the neighbour's `windowMs:` and passed. An
          unresolvable call site standing next to a resolvable one is exactly
          the arrangement somebody writes when they copy the call below and
          edit it, so that is not a hypothetical ordering.
        */
        const rest = source.slice(match.index);
        const end = rest.indexOf("});");
        return rest.slice(0, end === -1 ? 400 : end);
      }),
    );
    expect(sources.length).toBeGreaterThanOrEqual(50);
    expect(callSites.length).toBeGreaterThanOrEqual(9);
    for (const site of callSites) {
      const named = /windowMs:\s*([A-Za-z0-9_.]+)/.exec(site)?.[1] ?? "unresolved";
      expect([site.slice(0, 60), windows.has(named)]).toEqual([site.slice(0, 60), true]);
    }
    for (const [name, ms] of windows) {
      expect([name, ms <= MAX_RATE_LIMIT_WINDOW_MS]).toEqual([name, true]);
    }
  });

  test("a rotating registrant cannot mint unbounded limiter rows either", async () => {
    /*
      THE OTHER HALF, AND THE ONE THE FIRST VERSION OF THIS CHANGE GOT WRONG.

      `consumeRateLimit` writes a row per distinct key, and on this route the
      key belongs to the caller. Keyed on the raw address, a rotating source
      got a fresh bucket every time — so the limit did not bound growth, it
      DOUBLED it: measured on that version, 100 registrations left 100 client
      rows and 100 limiter rows, against the 100 an unlimited endpoint leaves.

      Two things fix it and this asserts the second. The gateway normalises an
      address to its /64 before hashing, so one customer's 2^64 addresses are
      one bucket (held in the gateway's own suite). And a closed window is
      swept, which bounds the table by rate instead of by keyspace.
    */
    const t = setupTest();
    /*
      Relative to the retention rather than a restated number, because the
      property is "older than retention is swept, inside it is not" — which is
      defined in terms of that constant. What must NOT drift is the constant's
      own value, and that is pinned on its own below.
    */
    const old = Date.now() - RATE_LIMIT_RETENTION_MS - 60_000;
    await t.run(async (ctx) => {
      for (let i = 0; i < 50; i += 1) {
        await ctx.db.insert("rateLimits", {
          key: `oauth.register:rotated-${i}`,
          windowStartedAt: old,
          count: 1,
        });
      }
      // A window still open, and somebody's spent budget. Sweeping this would
      // hand back a limit they have already used, which is the failure the
      // retention exists to prevent — so it is the positive twin here.
      /*
        A minute in, not on the boundary. The first version inserted this at
        exactly `Date.now()`, so the natural way to sabotage the retention —
        `cutoff = Date.now()` — made this row's survival depend on whether a
        millisecond ticked between the test's clock read and the mutation's.
        Measured: three runs gave 1 red, 0 red, 1 red. The guard written to
        protect retention was a coin flip against the likeliest way to break
        it, which is not a guard.
      */
      await ctx.db.insert("rateLimits", {
        key: "oauth.register:live",
        windowStartedAt: Date.now() - 60_000,
        count: 20,
      });
    });

    const result = await t.mutation(internal.functions.grants.purgeExpiredRateLimits, {});
    expect(result).toEqual({ deleted: 50, moreRemaining: false });

    const left = await t.run((ctx) => ctx.db.query("rateLimits").collect());
    expect(left).toHaveLength(1);
    expect(left[0].key).toBe("oauth.register:live");
    expect(left[0].count).toBe(20);
  });

  test("...and the sweep reports when a batch did not finish", async () => {
    const t = setupTest();
    const old = Date.now() - RATE_LIMIT_RETENTION_MS - 60_000;
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i += 1) {
        await ctx.db.insert("rateLimits", { key: `k-${i}`, windowStartedAt: old, count: 1 });
      }
    });
    expect(await t.mutation(internal.functions.grants.purgeExpiredRateLimits, { limit: 2 })).toEqual({
      deleted: 2,
      moreRemaining: true,
    });
  });

  test("is idempotent on clientId, so a redeploy does not orphan grants", async () => {
    const t = setupTest();
    await registerClient(t, "mcp_same");
    await registerClient(t, "mcp_same", { clientName: "Renamed" });
    const clients = await t.run((ctx) => ctx.db.query("oauthClients").collect());
    expect(clients).toHaveLength(1);
    expect(clients[0].clientName).toBe("Renamed");
  });

  test("keeps a confidential client's secret as a hash", async () => {
    const t = setupTest();
    const hashed = await hashToken("mcs_obviously_fake_client_secret");
    await registerClient(t, "mcp_confidential", {
      hashedClientSecret: hashed,
      tokenEndpointAuthMethod: "client_secret_post",
    });
    const body = await bodyOf(
      await gatewayPost(t, "/gateway/clients/get", { clientId: "mcp_confidential" }),
    );
    expect(body.client).toMatchObject({
      hashedClientSecret: hashed,
      tokenEndpointAuthMethod: "client_secret_post",
    });
  });

  test("refuses a plaintext client secret where a hash belongs", async () => {
    const t = setupTest();
    const response = await registerClient(t, "mcp_plaintext", {
      hashedClientSecret: "mcs_this_is_the_actual_secret",
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(response.status).toBe(400);
    expect(await t.run((ctx) => ctx.db.query("oauthClients").collect())).toEqual([]);
  });

  test("refuses a redirect URI that would carry a code in cleartext", async () => {
    const t = setupTest();
    for (const uri of [
      "http://evil.example/callback",
      "ftp://client.example/callback",
      "myapp://callback",
      "https://client.example/callback#fragment",
      "not a url",
    ]) {
      const response = await registerClient(t, `mcp_bad_${uri.length}`, {
        redirectUris: [uri],
      });
      expect(response.status, `${uri} was accepted`).toBe(400);
    }
    // Loopback http is the native-client case and must still work.
    expect(
      (
        await registerClient(t, "mcp_native", {
          redirectUris: ["http://127.0.0.1/callback"],
          applicationType: "native",
        })
      ).status,
    ).toBe(200);
  });

  test("an unknown client is null, not an error", async () => {
    const t = setupTest();
    expect(
      await bodyOf(
        await gatewayPost(t, "/gateway/clients/get", { clientId: "never-registered" }),
      ),
    ).toEqual({ client: null });
  });
});

/* -------------------------------------------------------------------------- */
