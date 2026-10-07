/**
 * META SIGN-UP CONVERSIONS — `functions/metaConversions.ts`,
 * `lib/metaConversion.ts`, and their callers (`waitlist.enter`, `auth.ts`).
 *
 * The Meta twin of `xConversions.test.ts` (Dev2, 2026-10-05): one Conversions
 * API call per new waitlist row (`Lead`) and per brand-new account
 * (`CompleteRegistration`), carrying a hash of the address and never the
 * address; the token in the body, never the URL; nothing without a token and
 * a pixel id; browser ids forwarded only when shaped like Meta's.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are failures in this file.
 *
 *   `scheduleMetaConversion` removed from `waitlist.enter`             3
 *   `scheduleMetaConversion` removed from `auth.ts`                    1
 *   token moved into the URL as `?access_token=`                       1
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { OPEN_SIGNUP_ENV_VAR } from "../functions/lib/waitlist";
import { hashEmail, META_PIXEL, metaEventsUrl, normalizeFbc, normalizeFbp } from "../functions/lib/metaConversion";
import { asUser, drainScheduled, setupTest } from "./fixtures.helpers";

const STAFF = "staff@context.invalid";
const ORIGIN = "https://context.invalid";
const TOKEN = "fake-meta-capi-token";
const PIXEL = "123456789012345";
const FBC = "fb.1.1759700000000.IwAR0abc_DEF-123";
const FBP = "fb.1.1759700000000.1234567890";
const ENV_KEYS = [
  ADMIN_EMAILS_ENV_VAR,
  OPEN_SIGNUP_ENV_VAR,
  "META_CAPI_TOKEN",
  "X_PIXEL_TOKEN",
  "RESEND_API_KEY",
  "APP_ORIGIN",
  "SITE_URL",
  "CONVEX_SITE_URL",
  "JWT_PRIVATE_KEY",
] as const;

interface Sent {
  url: string;
  raw: string;
  body: {
    access_token: string;
    data: Array<{
      event_name: string;
      event_time: number;
      event_id: string;
      action_source: string;
      event_source_url?: string;
      user_data: { em: string[]; fbc?: string; fbp?: string };
    }>;
  };
}

let previous: Map<string, string | undefined>;
let previousPixel: string | null;
let realFetch: typeof globalThis.fetch;
let sent: Sent[];
let codes: Map<string, string>;

beforeEach(async () => {
  previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  previousPixel = META_PIXEL.id;
  META_PIXEL.id = PIXEL;
  process.env[ADMIN_EMAILS_ENV_VAR] = STAFF;
  delete process.env[OPEN_SIGNUP_ENV_VAR];
  delete process.env.X_PIXEL_TOKEN;
  process.env.META_CAPI_TOKEN = TOKEN;
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
    if (url.startsWith("https://graph.facebook.com/")) {
      sent.push({ url, raw, body: JSON.parse(raw) });
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
  META_PIXEL.id = previousPixel;
  for (const key of ENV_KEYS) {
    const was = previous.get(key);
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

describe("the browser ids", () => {
  test("only Meta-shaped ones pass", () => {
    expect(normalizeFbc(` ${FBC} `)).toBe(FBC);
    expect(normalizeFbc("fb.1.123.<script>")).toBeNull();
    expect(normalizeFbc(undefined)).toBeNull();
    expect(normalizeFbp(FBP)).toBe(FBP);
    expect(normalizeFbp("fb.1.1759700000000.abc")).toBeNull();
  });
});

describe("a new waitlist signup", () => {
  test("sends one Lead with the hashed address, the browser ids, and the page's event id", async () => {
    const t = setupTest();
    const joined = await t.mutation(api.functions.waitlist.enter, { email: "Jon@Studio.test", fbc: FBC, fbp: FBP });
    await drainScheduled(t);

    expect(sent).toHaveLength(1);
    const [only] = sent;
    expect(only!.url).toBe(metaEventsUrl(PIXEL));
    expect(only!.url).not.toContain(TOKEN);
    expect(only!.body.access_token).toBe(TOKEN);
    const event = only!.body.data[0]!;
    expect(event.event_name).toBe("Lead");
    expect(event.action_source).toBe("website");
    expect(event.event_source_url).toBe(`${ORIGIN}/`);
    expect(Number.isInteger(event.event_time)).toBe(true);
    // The page's `fbq` Lead carries this as its eventID, so Meta counts it once.
    expect(event.event_id).toBe(joined.conversionId);
    expect(event.user_data).toEqual({ em: [await hashEmail("jon@studio.test")], fbc: FBC, fbp: FBP });
    expect(only!.raw.toLowerCase()).not.toContain("jon@studio.test");
  });

  test("ids that are not Meta's are dropped, and the sign-up still counts", async () => {
    const t = setupTest();
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test", fbc: "nope", fbp: "<x>" });
    await drainScheduled(t);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.data[0]!.user_data).toEqual({ em: [await hashEmail("jon@studio.test")] });
  });

  test("typing the address again is not another conversion", async () => {
    const t = setupTest();
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    await drainScheduled(t);
    expect(sent).toHaveLength(1);
  });

  test("without a token or a pixel id nothing is sent", async () => {
    delete process.env.META_CAPI_TOKEN;
    const t = setupTest();
    await t.mutation(api.functions.waitlist.enter, { email: "a@studio.test" });
    process.env.META_CAPI_TOKEN = TOKEN;
    META_PIXEL.id = null;
    await t.mutation(api.functions.waitlist.enter, { email: "b@studio.test" });
    await drainScheduled(t);
    expect(sent).toHaveLength(0);
  });
});

describe("a new account", () => {
  test("sends one CompleteRegistration, on the first sign-in only", async () => {
    const t = setupTest();
    const staffId = await t.run(async (ctx) =>
      ctx.db.insert("users", { email: STAFF, emailVerificationTime: Date.now() } as never),
    );
    await asUser(t, staffId).mutation(api.functions.admin.addToWaitlist, { emails: "maya@acme.test" });
    await drainScheduled(t);
    sent = [];

    const signIn = async () => {
      await t.action(api.auth.signIn, { provider: "email", params: { email: "maya@acme.test" } });
      const code = codes.get("maya@acme.test");
      await t.action(api.auth.signIn, { provider: "email", params: { email: "maya@acme.test", code: code! } });
      await drainScheduled(t);
    };
    await signIn();
    expect(sent.map((s) => s.body.data[0]!.event_name)).toEqual(["CompleteRegistration"]);
    expect(sent[0]!.body.data[0]!.event_id).toMatch(/^account-/);
    expect(sent[0]!.body.data[0]!.user_data).toEqual({ em: [await hashEmail("maya@acme.test")] });

    sent = [];
    await signIn();
    expect(sent).toHaveLength(0);
  });
});
