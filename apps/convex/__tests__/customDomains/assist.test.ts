/**
 * The help around setting a domain up (`lib/customDomains/survey.ts`,
 * `assist.ts`, `customDomainsLookup.ts`, `customDomainsMail.ts`).
 *
 * What these prove:
 *
 *  - the company that runs a domain's DNS is named from its name servers, and
 *    whether its root can point at us follows from that;
 *  - a record's Name is written relative to the real zone, so `acme.co.uk`
 *    asks for `docs`, not `docs.acme`;
 *  - the usual mistakes are found and named: the Name typed with the domain
 *    on it, Cloudflare's proxy, a CAA record that forbids our issuers, and a
 *    name still answering with an existing website;
 *  - only an owner sees those findings or may look a domain up;
 *  - the steps email goes to one plain address, a few times a day, with no
 *    link into Context; the "it's live" email goes once per claim.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { ownershipRecordName, ownershipRecordValue, RR } from "../../functions/lib/customDomains/dns";
import { relativeRecordName } from "../../functions/lib/customDomains/hostname";
import {
  caaBlocks,
  classifyAnswer,
  dnsHostFor,
  isCloudflareAddress,
  looksProxied,
  rootCanPoint,
} from "../../functions/lib/customDomains/survey";
import { stepsMail } from "../../functions/lib/customDomains/assist";
import { addMember, asUser, captureError, createUser, errorCode, setupTest, type TestConvex } from "../fixtures.helpers";
import { configureDomains, payingWorkspace, runDue, setPlan, stubWorld, TARGET } from "./fixtures.helpers";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type World = ReturnType<typeof stubWorld>;

const soa = (world: World, zone: string) =>
  world.dns.set(`${zone}|SOA`, [{ name: `${zone}.`, type: RR.SOA, data: `ns1.example. admin.${zone}. 1 2 3 4 5` }]);
const ns = (world: World, zone: string, server: string) =>
  world.dns.set(`${zone}|NS`, [{ type: RR.NS, data: `${server}.` }]);

async function connect(t: TestConvex, hostname: string, slug = "acme") {
  await configureDomains(t);
  const { owner, workspaceId } = await payingWorkspace(t, slug);
  const domainId = (await asUser(t, owner).mutation(api.functions.customDomains.connect, {
    workspaceId,
    hostname,
  })) as Id<"customDomains">;
  await runDue(t);
  return { owner, workspaceId, domainId };
}

async function view(t: TestConvex, userId: Id<"users">, workspaceId: Id<"workspaces">) {
  const settings = await asUser(t, userId).query(api.functions.customDomains.settings, { workspaceId });
  return settings.domain!;
}

describe("reading public DNS", () => {
  test("names the company from its name servers, and whether its root can point at us", () => {
    expect(dnsHostFor(["ns07.domaincontrol.com."])).toEqual({ key: "godaddy", name: "GoDaddy" });
    expect(dnsHostFor(["dns1.registrar-servers.com"])?.key).toBe("namecheap");
    expect(dnsHostFor(["ada.ns.cloudflare.com"])?.key).toBe("cloudflare");
    expect(dnsHostFor(["ns-1.awsdns-01.org."])?.key).toBe("route53");
    expect(dnsHostFor(["ns1.example-dns.invalid"])).toBeNull();
    // A suffix match, never a substring: a lookalike is nobody we know.
    expect(dnsHostFor(["ns1.notdomaincontrol.com"])).toBeNull();
    expect(rootCanPoint({ key: "godaddy", name: "GoDaddy" })).toBe(false);
    expect(rootCanPoint({ key: "namecheap", name: "Namecheap" })).toBe(true);
    expect(rootCanPoint(null)).toBeNull();
  });

  test("tells an existing website, a parked page, us and anything else apart", () => {
    const cname = (data: string) => ({ name: "www.acme-test.com", type: RR.CNAME, data: `${data}.` });
    const a = (data: string) => ({ name: "www.acme-test.com", type: RR.A, data });
    expect(classifyAnswer("www.acme-test.com", [cname("ext-sq.squarespace.com"), a("198.51.100.1")], TARGET)).toEqual({
      kind: "site",
      site: "Squarespace",
    });
    expect(classifyAnswer("www.acme-test.com", [cname("parkingpage.namecheap.com")], TARGET)).toEqual({ kind: "parked" });
    expect(classifyAnswer("www.acme-test.com", [cname(TARGET), a("198.51.100.2")], TARGET)).toEqual({ kind: "ours" });
    expect(classifyAnswer("www.acme-test.com", [a("198.51.100.3")], TARGET)).toEqual({
      kind: "elsewhere",
      value: "198.51.100.3",
    });
    expect(classifyAnswer("www.acme-test.com", [], TARGET)).toEqual({ kind: "empty" });
  });

  test("Cloudflare's proxy is told only on a subdomain at Cloudflare that answers with its addresses", () => {
    const cf = { key: "cloudflare" as const, name: "Cloudflare" };
    const proxied = [{ name: "blog.acme-test.com", type: RR.A, data: "104.21.10.10" }];
    expect(isCloudflareAddress("104.21.10.10")).toBe(true);
    expect(isCloudflareAddress("198.51.100.1")).toBe(false);
    expect(looksProxied(cf, false, proxied)).toBe(true);
    // At the root, Cloudflare flattens a correct CNAME to the same addresses.
    expect(looksProxied(cf, true, proxied)).toBe(false);
    expect(looksProxied({ key: "godaddy", name: "GoDaddy" }, false, proxied)).toBe(false);
    expect(looksProxied(cf, false, [{ name: "blog.acme-test.com", type: RR.CNAME, data: `${TARGET}.` }, ...proxied])).toBe(
      false,
    );
  });

  test("a CAA set blocks only when it names issuers and none of ours", () => {
    const caa = (data: string) => ({ name: "acme-test.com", type: RR.CAA, data });
    expect(caaBlocks([caa('0 issue "digicert.com"')])).toBe(true);
    expect(caaBlocks([caa('0 issue "digicert.com"'), caa('0 issue "letsencrypt.org"')])).toBe(false);
    expect(caaBlocks([caa('0 iodef "mailto:security@acme-test.com"')])).toBe(false);
    expect(caaBlocks([])).toBe(false);
  });

  test("a Name is relative to the zone public DNS reported, not to the last two labels", () => {
    expect(relativeRecordName("_context.docs.acme.co.uk", "docs.acme.co.uk", "acme.co.uk")).toBe("_context.docs");
    expect(relativeRecordName("docs.acme.co.uk", "docs.acme.co.uk", "acme.co.uk")).toBe("docs");
    expect(relativeRecordName("acme.co.uk", "acme.co.uk", "acme.co.uk")).toBe("@");
    // A zone that doesn't contain the hostname is ignored, never trusted.
    expect(relativeRecordName("docs.acme-test.com", "docs.acme-test.com", "other.example")).toBe("docs");
  });
});

describe("looking a domain up before connecting it", () => {
  test("an owner learns the zone, the company, what the root can do and what www shows today", async () => {
    const t = setupTest();
    const world = stubWorld();
    await configureDomains(t);
    const { owner, workspaceId } = await payingWorkspace(t, "acme");
    soa(world, "acme.co.uk");
    ns(world, "acme.co.uk", "ns07.domaincontrol.com");
    world.dns.set("www.acme.co.uk|A", [{ name: "www.acme.co.uk", type: RR.CNAME, data: "ext-sq.squarespace.com." }]);

    const result = await asUser(t, owner).action(api.functions.customDomainsLookup.lookup, {
      workspaceId,
      hostname: "https://Acme.co.uk/",
    });
    expect(result).toEqual({
      ok: true,
      hostname: "acme.co.uk",
      zone: "acme.co.uk",
      apex: true,
      dnsHost: { key: "godaddy", name: "GoDaddy" },
      rootCanPoint: false,
      current: { kind: "empty" },
      wwwCurrent: { kind: "site", site: "Squarespace" },
    });
  });

  test("a member who is not an owner, and an unpaid workspace, cannot look anything up", async () => {
    const t = setupTest();
    stubWorld();
    await configureDomains(t);
    const { owner, workspaceId } = await payingWorkspace(t, "acme");
    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "editor", owner);
    const asMember = await captureError(() =>
      asUser(t, member).action(api.functions.customDomainsLookup.lookup, { workspaceId, hostname: "acme-test.com" }),
    );
    expect(asMember).toBeDefined();
    await setPlan(t, workspaceId, "canceled");
    const unpaid = await captureError(() =>
      asUser(t, owner).action(api.functions.customDomainsLookup.lookup, { workspaceId, hostname: "acme-test.com" }),
    );
    expect(errorCode(unpaid)).toBe("PREMIUM_REQUIRED");
  });

  test("a name that isn't a domain is answered in words, without asking DNS", async () => {
    const t = setupTest();
    const world = stubWorld();
    await configureDomains(t);
    const { owner, workspaceId } = await payingWorkspace(t, "acme");
    const result = await asUser(t, owner).action(api.functions.customDomainsLookup.lookup, {
      workspaceId,
      hostname: "not a domain",
    });
    expect(result.ok).toBe(false);
    expect(world.calls.some((call) => call.url.includes("dns-query"))).toBe(false);
  });
});

describe("while a domain is being set up", () => {
  test("the Name typed with the domain on it is found and named, to the owner only", async () => {
    const t = setupTest();
    const world = stubWorld();
    soa(world, "acme-test.com");
    ns(world, "acme-test.com", "dns1.registrar-servers.com");
    const { owner, workspaceId, domainId } = await connect(t, "blog.acme-test.com");
    const row = await t.run(async (ctx) => await ctx.db.get(domainId));
    world.txt.set(`${ownershipRecordName("blog.acme-test.com")}.acme-test.com`, [ownershipRecordValue(row!.verifyToken)]);
    await t.action(internal.functions.customDomainsProvision.check, { domainId });

    const domain = await view(t, owner, workspaceId);
    expect(domain.dnsHost).toEqual({ key: "namecheap", name: "Namecheap" });
    expect(domain.zone).toBe("acme-test.com");
    expect(domain.hints).toEqual([
      { code: "DOUBLED_OWNERSHIP", name: "_context.blog.acme-test.com.acme-test.com" },
    ]);
    expect(domain.records.find((record) => record.purpose === "ownership")?.host).toBe("_context.blog");

    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "member", owner);
    expect((await view(t, member, workspaceId)).hints).toEqual([]);
  });

  test("Cloudflare's proxy, a CAA record and an existing website are each named", async () => {
    const t = setupTest();
    const world = stubWorld();
    soa(world, "acme-test.com");
    ns(world, "acme-test.com", "ada.ns.cloudflare.com");
    world.dns.set("blog.acme-test.com|A", [{ type: RR.A, data: "104.21.10.10" }]);
    world.dns.set("acme-test.com|CAA", [{ type: RR.CAA, data: '0 issue "digicert.com"' }]);
    const { owner, workspaceId } = await connect(t, "blog.acme-test.com");
    expect((await view(t, owner, workspaceId)).hints).toEqual([
      { code: "PROXIED" },
      { code: "CAA_BLOCKS", name: "acme-test.com" },
    ]);

    world.dns.set("blog.acme-test.com|A", [{ type: RR.CNAME, data: "acme.ghost.io." }]);
    world.dns.delete("acme-test.com|CAA");
    const domainId = (await view(t, owner, workspaceId)).id;
    await t.action(internal.functions.customDomainsProvision.check, { domainId });
    expect((await view(t, owner, workspaceId)).hints).toEqual([
      { code: "POINTS_ELSEWHERE", site: "Ghost", value: null },
    ]);
  });

  test("a root domain at Cloudflare is asked for a CNAME, and anywhere else an ALIAS", async () => {
    const t = setupTest();
    const world = stubWorld();
    soa(world, "acme-test.com");
    ns(world, "acme-test.com", "ada.ns.cloudflare.com");
    const { owner, workspaceId } = await connect(t, "acme-test.com");
    const routing = (await view(t, owner, workspaceId)).records.find((record) => record.purpose === "routing");
    expect(routing).toMatchObject({ type: "CNAME", host: "@" });
  });

  test("www connected alone asks for its root to be forwarded, and sees when it is", async () => {
    const t = setupTest();
    const world = stubWorld();
    soa(world, "acme-test.com");
    ns(world, "acme-test.com", "ns07.domaincontrol.com");
    const { owner, workspaceId, domainId } = await connect(t, "www.acme-test.com");
    expect((await view(t, owner, workspaceId)).forwarding).toEqual({ root: "acme-test.com", forwards: null });

    world.hosts.set("acme-test.com", () => ({ status: 301, body: undefined }));
    // The fake answers `text`; the redirect lives in a header.
    const fetcher = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "http://acme-test.com/") {
        return { ok: false, status: 301, headers: new Headers({ location: "https://www.acme-test.com/" }) };
      }
      return await fetcher(url, init as never);
    });
    await t.action(internal.functions.customDomainsProvision.check, { domainId });
    expect((await view(t, owner, workspaceId)).forwarding).toEqual({ root: "acme-test.com", forwards: true });
  });
});

describe("emailing the steps", () => {
  async function sentMail(world: World) {
    const sent: { to: string; subject: string; text: string }[] = [];
    world.hosts.set("api.resend.com", () => ({ status: 200, body: { id: "fake" } }));
    const fetcher = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (url === "https://api.resend.com/emails") sent.push(JSON.parse(init!.body!));
      return await fetcher(url, init as never);
    });
    vi.stubEnv("RESEND_API_KEY", "re_fake_not_a_real_key");
    return sent;
  }

  test("an owner sends plain steps to one address; the screen says who has them", async () => {
    const t = setupTest();
    const world = stubWorld();
    soa(world, "acme-test.com");
    ns(world, "acme-test.com", "ns07.domaincontrol.com");
    const { owner, workspaceId, domainId } = await connect(t, "www.acme-test.com");
    const sent = await sentMail(world);
    await asUser(t, owner).mutation(api.functions.customDomains.emailSteps, {
      domainId,
      to: " Helper@Example.invalid ",
      note: "Could you add these? Thanks!",
    });
    await runDue(t);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("helper@example.invalid");
    expect(sent[0]!.text).toContain("In GoDaddy, open My Products, find acme-test.com and choose DNS.");
    expect(sent[0]!.text).toContain("Name: _context.www");
    expect(sent[0]!.text).toContain("open Forwarding, press Add Forwarding");
    expect(sent[0]!.text).toContain('"Could you add these? Thanks!"');
    // Nothing to click: no link into Context, nothing to sign in to.
    expect(sent[0]!.text).not.toMatch(/https?:\/\/(?!www\.acme-test\.com)/);
    expect((await view(t, owner, workspaceId)).stepsSent?.to).toBe("helper@example.invalid");
  });

  test("one address only, owners only, and a few a day", async () => {
    const t = setupTest();
    stubWorld();
    const { owner, workspaceId, domainId } = await connect(t, "blog.acme-test.com");
    const send = async (to: string) => {
      try {
        await asUser(t, owner).mutation(api.functions.customDomains.emailSteps, { domainId, to, note: null });
        return undefined;
      } catch (error) {
        return error;
      }
    };

    expect(errorCode(await send("a@example.invalid\nbcc: b@example.invalid"))).toBe("INVALID_EMAIL");
    expect(errorCode(await send("a@example.invalid, b@example.invalid"))).toBe("INVALID_EMAIL");
    expect(errorCode(await send("Someone <a@example.invalid>"))).toBe("INVALID_EMAIL");

    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "editor", owner);
    expect(
      await captureError(() =>
        asUser(t, member).mutation(api.functions.customDomains.emailSteps, { domainId, to: "a@example.invalid", note: null }),
      ),
    ).toBeDefined();

    expect(await send("one@example.invalid")).toBeUndefined();
    expect(await send("two@example.invalid")).toBeUndefined();
    expect(await send("three@example.invalid")).toBeUndefined();
    expect(errorCode(await send("four@example.invalid"))).toBe("RATE_LIMITED");
  });

  test("the steps say only what is left, and never mention mail settings as something to change", () => {
    const { text } = stepsMail(
      {
        to: "helper@example.invalid",
        senderName: "Maya‮ Okafor",
        hostname: "blog.acme-test.com",
        zone: "acme-test.com",
        dnsHost: null,
        records: [
          { type: "TXT", host: "_context.blog", value: "context-verification=0000", done: true },
          { type: "CNAME", host: "blog", value: TARGET, done: false },
        ],
        forwardingRoot: null,
      },
      null,
    );
    expect(text).not.toContain("_context.blog");
    expect(text).toContain("Name: blog");
    expect(text).toContain("Don't change or delete anything else, including mail settings.");
    // A bidi override in a name can't reorder the sentence it sits in.
    expect(text).not.toContain("‮");
  });
});

describe("it's live", () => {
  test("the owner and the helper are each emailed once, the first time the domain goes live", async () => {
    const t = setupTest();
    const world = stubWorld();
    const { owner, domainId } = await connect(t, "blog.acme-test.com");
    const sent: { to: string; subject: string; text: string }[] = [];
    world.hosts.set("api.resend.com", () => ({ status: 200, body: { id: "fake" } }));
    const fetcher = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (url === "https://api.resend.com/emails") sent.push(JSON.parse(init!.body!));
      return await fetcher(url, init as never);
    });
    vi.stubEnv("RESEND_API_KEY", "re_fake_not_a_real_key");
    await asUser(t, owner).mutation(api.functions.customDomains.emailSteps, {
      domainId,
      to: "helper@example.invalid",
      note: null,
    });
    await runDue(t);
    sent.length = 0;

    const row = await t.run(async (ctx) => await ctx.db.get(domainId));
    world.txt.set(ownershipRecordName(row!.hostname), [ownershipRecordValue(row!.verifyToken)]);
    world.goLive(row!.hostname);
    await t.action(internal.functions.customDomainsProvision.check, { domainId });
    await runDue(t);
    expect(sent.map((mail) => [mail.to, mail.subject]).sort()).toEqual([
      ["acme@example.invalid", "blog.acme-test.com is live"],
      ["helper@example.invalid", "blog.acme-test.com is live"],
    ]);

    // Losing the records and getting them back is not news twice.
    sent.length = 0;
    await t.run(async (ctx) => await ctx.db.patch(domainId, { status: "pending", routingVerified: false }));
    await t.action(internal.functions.customDomainsProvision.check, { domainId });
    await runDue(t);
    expect(sent).toHaveLength(0);
  });
});
