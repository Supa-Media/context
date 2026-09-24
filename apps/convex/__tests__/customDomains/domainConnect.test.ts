/**
 * One-click DNS setup through Domain Connect.
 *
 * What these prove:
 *
 *  - the link is signed with our key, over exactly the query the provider
 *    applies, so a forged or edited link fails at the provider;
 *  - the button appears only when the provider has our template, only for the
 *    owner, and only while records are missing;
 *  - every failure — no key, a self-hosted target, a root domain, a provider
 *    that is down or answers nonsense — leaves the manual records and nothing
 *    else;
 *  - a `_domainconnect` value is never a way to make us fetch an arbitrary URL.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  CUSTOM_DOMAINS_TARGET_ENV_VAR,
} from "../../functions/lib/customDomains/config";
import { ownershipRecordName, ownershipRecordValue } from "../../functions/lib/customDomains/dns";
import {
  applyQuery,
  candidateZones,
  DOMAIN_CONNECT_SIGNING_KEY_SECRET,
  DOMAIN_CONNECT_TARGET,
  hostWithinZone,
  safeHttpsUrl,
  signQuery,
} from "../../functions/lib/customDomains/domainConnect";
import { addMember, asUser, createUser, seedAppSecret, setupTest, type TestConvex } from "../fixtures.helpers";
import { configureDomains, payingWorkspace, runDue, stubWorld } from "./fixtures.helpers";

const PROVIDER_API = "dc-api.provider.example";
const PROVIDER_UX = "dc-ux.provider.example";

let keys: CryptoKeyPair;
let privatePem: string;

beforeEach(async () => {
  vi.useFakeTimers();
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  privatePem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function verify(query: string, sig: string): Promise<boolean> {
  const bytes = Uint8Array.from(atob(sig), (char) => char.charCodeAt(0));
  return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, bytes, new TextEncoder().encode(query));
}

/** A provider hosting acme-test.com that has (or lacks) our template. */
function provider(world: ReturnType<typeof stubWorld>, options: { template: boolean; zone?: string }) {
  const zone = options.zone ?? "acme-test.com";
  world.txt.set(`_domainconnect.${zone}`, [`${PROVIDER_API}/dc`]);
  world.hosts.set(PROVIDER_API, (url) => {
    if (url.pathname === `/dc/v2/${zone}/settings`) {
      return {
        status: 200,
        body: {
          providerId: "provider.example",
          providerName: "ExampleDNS",
          providerDisplayName: "Example DNS",
          urlSyncUX: `https://${PROVIDER_UX}`,
          urlAPI: `https://${PROVIDER_API}/dc`,
        },
      };
    }
    if (url.pathname === "/dc/v2/domainTemplates/providers/context.lc/services/website") {
      return { status: options.template ? 200 : 404, body: undefined };
    }
    return { status: 404, body: undefined };
  });
}

async function readyDeployment(t: TestConvex, withKey = true) {
  await configureDomains(t);
  vi.stubEnv(CUSTOM_DOMAINS_TARGET_ENV_VAR, DOMAIN_CONNECT_TARGET);
  if (withKey) await seedAppSecret(t, DOMAIN_CONNECT_SIGNING_KEY_SECRET, privatePem);
}

async function connect(t: TestConvex, hostname: string) {
  const { owner, workspaceId } = await payingWorkspace(t, "acme");
  const domainId = (await asUser(t, owner).mutation(api.functions.customDomains.connect, {
    workspaceId,
    hostname,
  })) as Id<"customDomains">;
  await runDue(t);
  return { owner, workspaceId, domainId };
}

async function oneClickFor(t: TestConvex, user: Id<"users">, workspaceId: Id<"workspaces">) {
  const settings = await asUser(t, user).query(api.functions.customDomains.settings, { workspaceId });
  return settings.domain?.oneClick ?? null;
}

describe("the pure parts", () => {
  test("candidate zones run longest first and never reach a bare TLD", () => {
    expect(candidateZones("docs.acme-test.com")).toEqual(["docs.acme-test.com", "acme-test.com"]);
    expect(candidateZones("acme-test.com")).toEqual(["acme-test.com"]);
    expect(candidateZones("a.b.c.d.acme-test.com")).toHaveLength(4);
  });

  test("the host is what sits in front of the zone", () => {
    expect(hostWithinZone("docs.acme-test.com", "acme-test.com")).toBe("docs");
    expect(hostWithinZone("a.b.acme-test.com", "acme-test.com")).toBe("a.b");
    expect(hostWithinZone("acme-test.com", "acme-test.com")).toBe("");
  });

  test("only plain https on a named host is somewhere we send a request", () => {
    expect(safeHttpsUrl("https://dc.provider.example/api/")).toBe("https://dc.provider.example/api");
    for (const bad of [
      "http://dc.provider.example",
      "https://dc.provider.example:8443",
      "https://user:pass@dc.provider.example",
      "https://127.0.0.1",
      "https://[::1]",
      "https://localhost",
      "https://dc.provider.example/?next=x",
      "javascript:alert(1)",
      42,
    ]) {
      expect([bad, safeHttpsUrl(bad)]).toEqual([bad, null]);
    }
  });

  test("the signature covers exactly the query the provider applies", async () => {
    const query = applyQuery({ zone: "acme-test.com", host: "docs", token: "abc123" });
    expect(query).toBe("domain=acme-test.com&host=docs&token=abc123");
    const sig = await signQuery(query, privatePem);
    expect(await verify(query, sig)).toBe(true);
    // Sabotage: point the same signature at somebody else's domain.
    expect(await verify(query.replace("acme-test.com", "victim-test.com"), sig)).toBe(false);
  });
});

describe("detecting the provider", () => {
  test("a supported provider gets a signed link, shown to the owner", async () => {
    const t = setupTest();
    const world = stubWorld();
    await readyDeployment(t);
    provider(world, { template: true });
    const { owner, workspaceId, domainId } = await connect(t, "docs.acme-test.com");

    const oneClick = await oneClickFor(t, owner, workspaceId);
    expect(oneClick?.provider).toBe("Example DNS");
    const url = new URL(oneClick!.url);
    expect(url.origin).toBe(`https://${PROVIDER_UX}`);
    expect(url.pathname).toBe("/v2/domainTemplates/providers/context.lc/services/website/apply");
    expect(url.searchParams.get("key")).toBe("_dcpubkeyv1");

    const row = await t.run(async (ctx) => await ctx.db.get(domainId));
    const signed = applyQuery({ zone: "acme-test.com", host: "docs", token: row!.verifyToken });
    expect(url.search.slice(1).startsWith(`${signed}&sig=`)).toBe(true);
    expect(await verify(signed, url.searchParams.get("sig")!)).toBe(true);
  });

  test("a member sees no link, and the owner stops seeing it once both records are found", async () => {
    const t = setupTest();
    const world = stubWorld();
    await readyDeployment(t);
    provider(world, { template: true });
    const { owner, workspaceId, domainId } = await connect(t, "docs.acme-test.com");
    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "member");
    expect(await oneClickFor(t, member, workspaceId)).toBeNull();

    const row = await t.run(async (ctx) => await ctx.db.get(domainId));
    world.txt.set(ownershipRecordName(row!.hostname), [ownershipRecordValue(row!.verifyToken)]);
    world.goLive(row!.hostname);
    await t.action(internal.functions.customDomainsProvision.check, { domainId });
    expect(await oneClickFor(t, owner, workspaceId)).toBeNull();
  });

  for (const [name, arrange, hostname] of [
    ["the provider lacks our template", (world: ReturnType<typeof stubWorld>) => provider(world, { template: false }), "docs.acme-test.com"],
    ["the domain is not at a Domain Connect provider", () => undefined, "docs.acme-test.com"],
    ["it is a root domain", (world: ReturnType<typeof stubWorld>) => provider(world, { template: true }), "acme-test.com"],
    [
      "the discovery record names somewhere we would not fetch",
      (world: ReturnType<typeof stubWorld>) => world.txt.set("_domainconnect.acme-test.com", ["http://127.0.0.1:8080/x"]),
      "docs.acme-test.com",
    ],
  ] as const) {
    test(`no link when ${name}`, async () => {
      const t = setupTest();
      const world = stubWorld();
      await readyDeployment(t);
      arrange(world);
      const { owner, workspaceId } = await connect(t, hostname);
      expect(await oneClickFor(t, owner, workspaceId)).toBeNull();
      expect(world.calls.some((call) => call.url.includes("127.0.0.1"))).toBe(false);
    });
  }

  test("no link without the signing key, and none for a target the template does not name", async () => {
    const t = setupTest();
    const world = stubWorld();
    await readyDeployment(t, false);
    provider(world, { template: true });
    const first = await connect(t, "docs.acme-test.com");
    expect(await oneClickFor(t, first.owner, first.workspaceId)).toBeNull();

    const t2 = setupTest();
    const world2 = stubWorld();
    await configureDomains(t2);
    await seedAppSecret(t2, DOMAIN_CONNECT_SIGNING_KEY_SECRET, privatePem);
    provider(world2, { template: true });
    const second = await connect(t2, "docs.acme-test.com");
    expect(await oneClickFor(t2, second.owner, second.workspaceId)).toBeNull();
    // Nothing was even asked of the provider for a target it cannot apply.
    expect(world2.calls.some((call) => call.url.includes(PROVIDER_API))).toBe(false);
  });
});
