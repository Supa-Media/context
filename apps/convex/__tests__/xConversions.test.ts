/**
 * X SIGN-UP CONVERSIONS — `functions/xConversions.ts`, `lib/xConversion.ts`,
 * and their two callers (`waitlist.enter` and `auth.ts`'s `onUserCreated`).
 *
 * Dev2 asked (2026-10-05) for X ads to count sign-ups. What matters: one call
 * per new waitlist row and per brand-new account, carrying a hash of the
 * address and never the address; nothing at all on a deployment without the
 * token or an event id; and a click id a stranger typed is forwarded only when
 * it looks like one.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are failures in this file.
 *
 *   `scheduleXConversion` removed from `waitlist.enter`                3
 *   `scheduleXConversion` removed from `auth.ts`                       1
 *   `hashed_email` altered in `conversionBody`                         3
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { OPEN_SIGNUP_ENV_VAR } from "../functions/lib/waitlist";
import {
  conversionBody,
  hashEmail,
  normalizeTwclid,
  validEventId,
  X_CONVERSIONS_URL,
  X_EVENT_IDS,
} from "../functions/lib/xConversion";
import { asUser, drainScheduled, setupTest } from "./fixtures.helpers";

const STAFF = "staff@context.invalid";
const ORIGIN = "https://context.invalid";
const TOKEN = "fake-x-pixel-token";
const WAITLIST_EVENT = "tw-rgib5-waitl";
const ACCOUNT_EVENT = "tw-rgib5-accnt";
const ENV_KEYS = [
  ADMIN_EMAILS_ENV_VAR,
  OPEN_SIGNUP_ENV_VAR,
  "X_PIXEL_TOKEN",
  "RESEND_API_KEY",
  "APP_ORIGIN",
  "SITE_URL",
  "CONVEX_SITE_URL",
  "JWT_PRIVATE_KEY",
] as const;

interface Sent {
  token: string | null;
  body: {
    conversions: Array<{
      conversion_time: string;
      event_id: string;
      event_source_url?: string;
      conversion_id: string;
      identifiers: Array<Record<string, string>>;
    }>;
  };
  raw: string;
}

let previous: Map<string, string | undefined>;
let previousEvents: typeof X_EVENT_IDS;
let realFetch: typeof globalThis.fetch;
let sent: Sent[];
let codes: Map<string, string>;

beforeEach(async () => {
  previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  previousEvents = { ...X_EVENT_IDS };
  X_EVENT_IDS.waitlist = WAITLIST_EVENT;
  X_EVENT_IDS.account = ACCOUNT_EVENT;
  process.env[ADMIN_EMAILS_ENV_VAR] = STAFF;
  delete process.env[OPEN_SIGNUP_ENV_VAR];
  process.env.X_PIXEL_TOKEN = TOKEN;
  process.env.RESEND_API_KEY = "re_fake_key_for_tests";
  process.env.APP_ORIGIN = ORIGIN;
  process.env.SITE_URL = ORIGIN;
  process.env.CONVEX_SITE_URL = ORIGIN;
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.JWT_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  sent = [];
  codes = new Map();
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const raw = String(init?.body ?? "{}");
    if (url === X_CONVERSIONS_URL) {
      const headers = new Headers(init?.headers);
      sent.push({ token: headers.get("X-Pixel-Token"), body: JSON.parse(raw), raw });
      return new Response("{}", { status: 200 });
    }
    if (url === "https://api.resend.com/emails") {
      const mail = JSON.parse(raw) as { to: string | string[]; subject?: string };
      const code = /^(\d{6}) is your Context code$/.exec(mail.subject ?? "")?.[1];
      if (code !== undefined) codes.set(Array.isArray(mail.to) ? mail.to[0]! : mail.to, code);
      return new Response(JSON.stringify({ id: "fake-message-id" }), { status: 200 });
    }
    throw new Error(`network access attempted: ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(X_EVENT_IDS, previousEvents);
  for (const key of ENV_KEYS) {
    const was = previous.get(key);
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

describe("the request body", () => {
  test("follows X's format, with the hash and the click id as one identifier", async () => {
    const body = JSON.parse(
      conversionBody({
        eventId: WAITLIST_EVENT,
        at: Date.UTC(2026, 9, 5, 12, 34, 56),
        conversionId: "waitlist-abc",
        hashedEmail: await hashEmail("  Jon@Studio.TEST "),
        twclid: "abc123",
        sourceUrl: `${ORIGIN}/`,
      }),
    );
    expect(body).toEqual({
      conversions: [
        {
          conversion_time: "2026-10-05T12:34:56.000Z",
          event_id: WAITLIST_EVENT,
          event_source_url: `${ORIGIN}/`,
          conversion_id: "waitlist-abc",
          identifiers: [
            {
              // sha256("jon@studio.test")
              hashed_email: await hashEmail("jon@studio.test"),
              twclid: "abc123",
            },
          ],
        },
      ],
    });
    expect(body.conversions[0].identifiers[0].hashed_email).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the hash is SHA-256 hex of the trimmed, lower-cased address", async () => {
    // A known vector, so a swapped algorithm or encoding fails here.
    expect(await hashEmail("test@example.com")).toBe(
      "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b",
    );
    expect(await hashEmail(" TEST@Example.com\n")).toBe(await hashEmail("test@example.com"));
  });

  test("only plausible click ids and event ids pass", () => {
    expect(normalizeTwclid(" 1ab_C-9 ")).toBe("1ab_C-9");
    expect(normalizeTwclid("")).toBeNull();
    expect(normalizeTwclid('a"b')).toBeNull();
    expect(normalizeTwclid("a".repeat(257))).toBeNull();
    expect(normalizeTwclid(undefined)).toBeNull();
    expect(validEventId("tw-rgib5-qt9xy")).toBe(true);
    expect(validEventId("tw-other-qt9xy")).toBe(false);
    expect(validEventId(null)).toBe(false);
  });
});

describe("a new waitlist signup", () => {
  test("sends one conversion with the hashed address and the ad's click id", async () => {
    const t = setupTest();
    await t.mutation(api.functions.waitlist.enter, { email: "Jon@Studio.test", twclid: "clk_42" });
    await drainScheduled(t);

    expect(sent).toHaveLength(1);
    const [only] = sent;
    expect(only!.token).toBe(TOKEN);
    const conversion = only!.body.conversions[0]!;
    expect(conversion.event_id).toBe(WAITLIST_EVENT);
    expect(conversion.conversion_id).toMatch(/^waitlist-/);
    expect(conversion.event_source_url).toBe(`${ORIGIN}/`);
    expect(conversion.identifiers).toEqual([{ hashed_email: await hashEmail("jon@studio.test"), twclid: "clk_42" }]);
    expect(only!.raw.toLowerCase()).not.toContain("jon@studio.test");
  });

  test("typing the address again is not another conversion", async () => {
    const t = setupTest();
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    await drainScheduled(t);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.conversions[0]!.identifiers[0]).not.toHaveProperty("twclid");
  });

  test("a click id that is not one is dropped, and the sign-up still counts", async () => {
    const t = setupTest();
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test", twclid: "<script>" });
    await drainScheduled(t);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.conversions[0]!.identifiers[0]).not.toHaveProperty("twclid");
  });

  test("without a token nothing is scheduled or sent", async () => {
    delete process.env.X_PIXEL_TOKEN;
    const t = setupTest();
    expect(await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" })).toEqual({ status: "joined" });
    await drainScheduled(t);
    expect(sent).toHaveLength(0);
  });

  test("without an event id for it nothing is sent", async () => {
    X_EVENT_IDS.waitlist = null;
    const t = setupTest();
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    await drainScheduled(t);
    expect(sent).toHaveLength(0);
  });
});

describe("a new account", () => {
  async function signIn(t: ReturnType<typeof setupTest>, email: string) {
    await t.action(api.auth.signIn, { provider: "email", params: { email } });
    const code = codes.get(email);
    expect(code).toBeDefined();
    await t.action(api.auth.signIn, { provider: "email", params: { email, code: code! } });
    await drainScheduled(t);
  }

  test("sends one account conversion, on the first sign-in only", async () => {
    const t = setupTest();
    const staffId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: STAFF, emailVerificationTime: Date.now() } as never),
    );
    await asUser(t, staffId).mutation(api.functions.admin.addToWaitlist, { emails: "maya@acme.test" });
    await drainScheduled(t);
    sent = [];

    await signIn(t, "maya@acme.test");
    expect(sent.map((s) => s.body.conversions[0]!.event_id)).toEqual([ACCOUNT_EVENT]);
    const conversion = sent[0]!.body.conversions[0]!;
    expect(conversion.conversion_id).toMatch(/^account-/);
    expect(conversion.identifiers).toEqual([{ hashed_email: await hashEmail("maya@acme.test") }]);

    sent = [];
    await signIn(t, "maya@acme.test");
    expect(sent).toHaveLength(0);
  });
});
