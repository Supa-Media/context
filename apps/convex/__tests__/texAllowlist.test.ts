/**
 * Who may text Tex: the Linq shared line's contact list, read and changed from
 * the staff console (`lib/adminFns/texAllowlist.ts`).
 *
 * Linq is stubbed at `fetch`. What these hold: the twenty-first number is
 * refused before Linq is asked, a duplicate is not sent twice, the key only
 * ever travels in the Authorization header, and a Linq failure is reported in
 * our words rather than with Linq's body.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../_generated/api";
import schema from "../schema";
import { modules } from "../test.setup";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import {
  LINQ_ZERO_SERVICE,
  SHARED_LINE_CAP,
  addToLinqLine,
  dedicatedTexLines,
  readLinqLine,
  texLineFor,
  removeFromLinqLine,
} from "../functions/lib/adminFns/texAllowlist";
import { withSession } from "./session.helpers";

const KEY = "fixture-linq-key-not-real";
const ENV = { LINQ_API_KEY: KEY };
const ORG = "org_fixture";

interface Call {
  url: string;
  init: RequestInit;
}

function phones(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `+1555010${String(i).padStart(4, "0")}`);
}

/** A fake Linq holding `listed`, answering the four calls the CLI makes. */
function linq(listed: string[], options: { label?: string; failAdd?: number; body?: string } = {}) {
  const calls: Call[] = [];
  const contacts = [...listed];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url === `${LINQ_ZERO_SERVICE}/cli/account-info`) {
      return json({
        orgId: ORG,
        accountInfo: { accountLabel: options.label ?? "Shared", phones: [{ phoneNumber: "+15550009999" }] },
      });
    }
    if (url === `${LINQ_ZERO_SERVICE}/cli/contacts?orgId=${ORG}`) {
      return json({
        contacts: contacts.map((contactPhone, i) => ({ contactPhone, createdAt: `2026-10-${String(1 + i).padStart(2, "0")}T00:00:00Z` })),
      });
    }
    if (url === `${LINQ_ZERO_SERVICE}/cli/contacts/add`) {
      if (options.failAdd) return new Response(options.body ?? "nope", { status: options.failAdd });
      const sent = JSON.parse(String(init.body));
      contacts.push(sent.contactPhone);
      return json({ contactPhone: sent.contactPhone });
    }
    if (url === `${LINQ_ZERO_SERVICE}/cli/contacts/remove`) {
      const sent = JSON.parse(String(init.body));
      contacts.splice(contacts.indexOf(sent.contactPhone), 1);
      return json({});
    }
    return new Response("unexpected", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, contacts, fetchImpl };
}

describe("Tex's allowlist on the Linq shared line", () => {
  test("no key is not connected, and nothing is fetched", async () => {
    const { calls, fetchImpl } = linq([]);
    expect(await readLinqLine({}, fetchImpl)).toEqual({ state: "not_connected" });
    expect(await readLinqLine({ LINQ_API_KEY: "  " }, fetchImpl)).toEqual({ state: "not_connected" });
    expect(calls).toHaveLength(0);
  });

  test("reads the list newest first, with the line's own number", async () => {
    const { calls, fetchImpl } = linq(phones(3));
    const line = await readLinqLine(ENV, fetchImpl);
    if (line.state !== "shared") throw new Error(`expected shared, got ${line.state}`);
    expect(line.line).toBe("+15550009999");
    expect(line.contacts.map((c) => c.phone)).toEqual(phones(3).reverse());
    expect(line.contacts[0]!.addedAt).toBe(Date.parse("2026-10-03T00:00:00Z"));
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
      expect(call.url).not.toContain(KEY);
    }
  });

  test("a paid line has no list to manage", async () => {
    const { fetchImpl } = linq(phones(2), { label: "Paid" });
    expect(await readLinqLine(ENV, fetchImpl)).toEqual({ state: "unlimited", line: "+15550009999" });
    expect(await addToLinqLine(ENV, "+15550100099", fetchImpl)).toMatchObject({ status: "error" });
  });

  test("adds a typed number as E.164, and records nothing else in the body", async () => {
    const { calls, contacts, fetchImpl } = linq(phones(2));
    expect(await addToLinqLine(ENV, "+1 (555) 010-0077", fetchImpl)).toEqual({ status: "added", phone: "+15550100077" });
    expect(contacts).toContain("+15550100077");
    const add = calls.find((c) => c.url.endsWith("/cli/contacts/add"))!;
    expect(add.init.method).toBe("POST");
    expect(JSON.parse(String(add.init.body))).toEqual({ orgId: ORG, contactPhone: "+15550100077" });
  });

  test("the twentieth fits and the twenty-first is refused before Linq is asked", async () => {
    const nineteen = linq(phones(SHARED_LINE_CAP - 1));
    expect(await addToLinqLine(ENV, "+15559990001", nineteen.fetchImpl)).toMatchObject({ status: "added" });

    const full = linq(phones(SHARED_LINE_CAP));
    expect(await addToLinqLine(ENV, "+15559990002", full.fetchImpl)).toEqual({ status: "full", cap: SHARED_LINE_CAP });
    expect(full.calls.some((c) => c.url.endsWith("/cli/contacts/add"))).toBe(false);
  });

  test("a number already listed is not sent again, and a missing one is not removed", async () => {
    const { calls, fetchImpl } = linq(phones(2));
    expect(await addToLinqLine(ENV, phones(2)[0]!, fetchImpl)).toEqual({ status: "already", phone: phones(2)[0] });
    expect(await removeFromLinqLine(ENV, "+15559990003", fetchImpl)).toEqual({ status: "absent", phone: "+15559990003" });
    expect(calls.some((c) => c.url.endsWith("/add") || c.url.endsWith("/remove"))).toBe(false);
  });

  test("removing frees the slot", async () => {
    const { contacts, fetchImpl } = linq(phones(SHARED_LINE_CAP));
    expect(await removeFromLinqLine(ENV, phones(1)[0]!, fetchImpl)).toEqual({ status: "removed", phone: phones(1)[0] });
    expect(contacts).toHaveLength(SHARED_LINE_CAP - 1);
    expect(await addToLinqLine(ENV, "+15559990004", fetchImpl)).toMatchObject({ status: "added" });
  });

  test("something that is not a phone never reaches Linq", async () => {
    const { calls, fetchImpl } = linq([]);
    for (const typed of ["", "hello", "5550100", "+0123"]) {
      expect(await addToLinqLine(ENV, typed, fetchImpl)).toEqual({ status: "invalid" });
      expect(await removeFromLinqLine(ENV, typed, fetchImpl)).toEqual({ status: "invalid" });
    }
    expect(calls).toHaveLength(0);
  });

  test("Linq's refusals are reported in our words, never with its body or the key", async () => {
    const leak = "linq-body-that-must-not-show";
    const refused = linq([], { failAdd: 400, body: leak });
    const result = await addToLinqLine(ENV, "+15559990005", refused.fetchImpl);
    expect(result).toEqual({ status: "error", error: "Linq answered 400. Try again, or check the line in Linq." });

    const badKey = (async () => new Response(leak, { status: 401 })) as unknown as typeof fetch;
    const line = await readLinqLine(ENV, badKey);
    expect(line.state).toBe("error");
    expect(JSON.stringify(line)).not.toContain(leak);

    const down = (async () => {
      throw new Error(`Bearer ${KEY} refused`);
    }) as unknown as typeof fetch;
    const unreachable = await readLinqLine(ENV, down);
    expect(unreachable).toEqual({ state: "error", error: "Linq could not be reached. Try again in a minute." });
    expect(JSON.stringify(unreachable)).not.toContain(KEY);
  });

  test("odd rows in Linq's list are dropped, duplicates counted once", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.endsWith("/account-info")
        ? { orgId: ORG, accountInfo: { accountLabel: "Shared", phones: [] } }
        : { contacts: [{ contactPhone: "+15550100001" }, { contactPhone: "+15550100001" }, { contactPhone: "<b>" }, null] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const line = await readLinqLine(ENV, fetchImpl);
    expect(line).toEqual({ state: "shared", orgId: ORG, line: null, contacts: [{ phone: "+15550100001", addedAt: null }] });
  });
});

describe("the console's Tex list, through the admin functions", () => {
  const ADMIN = "staff@supa.media";
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LINQ_API_KEY;
  });

  async function setup(listed: string[]) {
    const t = convexTest(schema, modules);
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    process.env.LINQ_API_KEY = KEY;
    const fake = linq(listed);
    vi.stubGlobal("fetch", fake.fetchImpl);
    const ids = await t.run(async (ctx) => {
      const staff = await ctx.db.insert("users", { email: ADMIN, emailVerificationTime: 1 } as never);
      const stranger = await ctx.db.insert("users", { email: "someone@example.com", emailVerificationTime: 1 } as never);
      const ada = await ctx.db.insert("users", { name: "Ada", email: "ada@example.com" } as never);
      await ctx.db.insert("phoneLinks", { userId: ada, phone: listed[0]!, linkedAt: 1 });
      const ben = await ctx.db.insert("users", { name: "Ben", phone: listed[1]!, phoneVerificationTime: 1 } as never);
      return { staff, stranger, ada, ben };
    });
    return { t, fake, ids, as: withSession(t, ids.staff) };
  }

  test("a stranger can neither read nor change the list, and Linq is never asked", async () => {
    const { t, fake, ids } = await setup(phones(3));
    const asStranger = withSession(t, ids.stranger);
    await expect(asStranger.action(api.functions.admin.texAllowlist, {})).rejects.toThrow();
    await expect(
      asStranger.action(api.functions.admin.changeTexAllowlist, { phone: "+15559990010", change: "add" }),
    ).rejects.toThrow();
    await expect(t.action(api.functions.admin.texAllowlist, {})).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });

  test("staff see whose each number is, and the cap", async () => {
    const { as } = await setup(phones(3));
    const result = await as.action(api.functions.admin.texAllowlist, {});
    if (result.state !== "shared") throw new Error(`expected shared, got ${result.state}`);
    expect(result.cap).toBe(SHARED_LINE_CAP);
    expect(JSON.stringify(result)).not.toContain(ORG);
    const byPhone = new Map(result.contacts.map((c) => [c.phone, c.person]));
    expect(byPhone.get(phones(3)[0]!)).toMatchObject({ name: "Ada", email: "ada@example.com", linked: true });
    expect(byPhone.get(phones(3)[1]!)).toMatchObject({ name: "Ben", linked: false });
    expect(byPhone.get(phones(3)[2]!)).toBeNull();
  });

  test("with a dedicated line set, staff see an open line and Linq is not asked", async () => {
    const { as, fake } = await setup(phones(3));
    vi.stubEnv("TEX_LINE_NUMBERS", "+15555550177, +15555550178");
    const before = fake.calls.length;
    expect(await as.action(api.functions.admin.texAllowlist, {})).toEqual({ state: "unlimited", line: "+15555550177" });
    expect(fake.calls).toHaveLength(before);
    vi.unstubAllEnvs();
  });

  test("a change is on the admin trail with the last four digits only", async () => {
    const { t, as } = await setup(phones(3));
    expect(await as.action(api.functions.admin.changeTexAllowlist, { phone: "+15559990011", change: "add" })).toEqual({
      status: "added",
      phone: "+15559990011",
    });
    expect(await as.action(api.functions.admin.changeTexAllowlist, { phone: phones(3)[2]!, change: "remove" })).toMatchObject({
      status: "removed",
    });
    expect(await as.action(api.functions.admin.changeTexAllowlist, { phone: "nope", change: "add" })).toEqual({ status: "invalid" });
    const trail = await t.run((ctx) => ctx.db.query("adminAuditEvents").collect());
    expect(trail.map((row) => [row.action, row.details?.phone])).toEqual([
      ["tex.allowlist_added", "0011"],
      ["tex.allowlist_removed", phones(3)[2]!.slice(-4)],
    ]);
    expect(JSON.stringify(trail)).not.toContain("+1555999");
  });
});

describe("Tex's dedicated lines", () => {
  test("reads well-formed numbers only, once each", () => {
    expect(dedicatedTexLines(undefined)).toEqual([]);
    expect(dedicatedTexLines(" +15555550177 , nope, +15555550177,+15555550178")).toEqual(["+15555550177", "+15555550178"]);
  });

  test("always tells one person the same line, and spreads people over several", () => {
    const lines = ["+15555550177", "+15555550178"];
    expect(texLineFor(lines, "+15555550100")).toBe(texLineFor(lines, "+15555550100"));
    const told = new Set(phones(20).map((phone) => texLineFor(lines, phone)));
    expect(told).toEqual(new Set(lines));
    expect(texLineFor(["+15555550177"], "+15555550100")).toBe("+15555550177");
  });
});
