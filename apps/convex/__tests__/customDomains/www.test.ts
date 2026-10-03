/**
 * `www.` beside a root domain, end to end against a fake zone and resolver.
 *
 * What these prove:
 *
 *  - connecting a root domain registers its `www.` and shows one more CNAME;
 *  - the `www.` is proved by the root's own TXT for this claim, never by a
 *    record anybody could have left behind, and never asks for one of its own;
 *  - a live `www.` serves nothing: it sends visitors to the root, and only
 *    while the root is live;
 *  - a `www.` somebody else claimed is theirs; nobody can claim ours;
 *  - removing the root removes its `www.` at the provider too;
 *  - a root domain connected before this existed gets its `www.` from the sweep.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { ownershipRecordName, ownershipRecordValue } from "../../functions/lib/customDomains/dns";
import { asUser, captureError, errorCode, setupTest, type TestConvex } from "../fixtures.helpers";
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

async function rows(t: TestConvex) {
  return await t.run(async (ctx) => await ctx.db.query("customDomains").collect());
}

async function companion(t: TestConvex, hostname = "www.acme-test.com") {
  return (await rows(t)).find((row) => row.hostname === hostname) ?? null;
}

const configured = new WeakSet<TestConvex>();

async function connect(t: TestConvex, hostname = "acme-test.com", slug = "acme") {
  if (!configured.has(t)) {
    await configureDomains(t);
    configured.add(t);
  }
  const { owner, workspaceId } = await payingWorkspace(t, slug);
  const domainId = (await asUser(t, owner).mutation(api.functions.customDomains.connect, {
    workspaceId,
    hostname,
  })) as Id<"customDomains">;
  await runDue(t);
  return { owner, workspaceId, domainId };
}

/** Publish the root's TXT, point both names at us, and run every check. */
async function goLive(t: TestConvex, world: World, domainId: Id<"customDomains">) {
  const root = await t.run(async (ctx) => await ctx.db.get(domainId));
  world.txt.set(ownershipRecordName(root!.hostname), [ownershipRecordValue(root!.verifyToken)]);
  world.goLive(root!.hostname);
  world.goLive(`www.${root!.hostname}`);
  await t.action(internal.functions.customDomainsProvision.check, { domainId });
  await runDue(t);
  const www = await companion(t, `www.${root!.hostname}`);
  if (www !== null) await t.action(internal.functions.customDomainsProvision.check, { domainId: www._id });
}

const resolve = (t: TestConvex, hostname: string) => t.query(api.functions.customDomains.resolveHost, { hostname });

describe("www. beside a root domain", () => {
  test("connecting a root domain registers its www. and shows one more CNAME, proved by the root's TXT", async () => {
    const t = setupTest();
    const world = stubWorld();
    const { owner, workspaceId, domainId } = await connect(t);

    expect([...world.registrations.values()].map((row) => row.hostname).sort()).toEqual([
      "acme-test.com",
      "www.acme-test.com",
    ]);
    const settings = await asUser(t, owner).query(api.functions.customDomains.settings, { workspaceId });
    expect(settings.domain).toMatchObject({ id: domainId, hostname: "acme-test.com", www: { hostname: "www.acme-test.com", live: false } });
    const records = settings.domain!.records;
    expect(records.map((record) => [record.purpose, record.type, record.host])).toEqual([
      ["routing", "ALIAS", "@"],
      ["hostname", "TXT", "_cf-custom-hostname"],
      ["ownership", "TXT", "_context"],
      ["www", "CNAME", "www"],
    ]);
    expect(records[3]).toMatchObject({ name: "www.acme-test.com", value: TARGET, done: false });
    // Never a TXT of its own to look up, and never a second ownership record to add.
    expect(records.filter((record) => record.purpose === "ownership")).toHaveLength(1);
    expect(world.calls.some((call) => call.url.includes("_context.www."))).toBe(false);
  });

  test("a live www. sends visitors to the root, and only while the root is live", async () => {
    const t = setupTest();
    const world = stubWorld();
    const { owner, workspaceId, domainId } = await connect(t);
    await goLive(t, world, domainId);

    expect(await resolve(t, "acme-test.com")).toEqual({ handle: "acme", homeSlug: null });
    expect(await resolve(t, "WWW.acme-test.com.")).toEqual({ redirect: "acme-test.com" });
    const settings = await asUser(t, owner).query(api.functions.customDomains.settings, { workspaceId });
    expect(settings.domain?.www).toEqual({ hostname: "www.acme-test.com", live: true });

    const response = await t.fetch("/domain/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "www.acme-test.com" }),
    });
    expect(await response.json()).toEqual({ handle: null, homeSlug: null, redirect: "acme-test.com" });

    // The root goes back to pending: the www. is nothing on its own.
    await t.run(async (ctx) => await ctx.db.patch(domainId, { status: "pending" }));
    expect(await resolve(t, "www.acme-test.com")).toBeNull();
  });

  test("a stale TXT, or one for an earlier claim, proves neither name", async () => {
    const t = setupTest();
    const world = stubWorld();
    const { domainId } = await connect(t);
    world.txt.set("_context.acme-test.com", [ownershipRecordValue("an-earlier-claims-token-000000000000")]);
    world.txt.set("_context.www.acme-test.com", [ownershipRecordValue((await companion(t))!.verifyToken)]);
    world.goLive("acme-test.com");
    world.goLive("www.acme-test.com");
    await t.action(internal.functions.customDomainsProvision.check, { domainId });
    await t.action(internal.functions.customDomainsProvision.check, { domainId: (await companion(t))!._id });

    expect((await companion(t))?.ownershipVerified).toBe(false);
    expect(await resolve(t, "www.acme-test.com")).toBeNull();
    expect(await resolve(t, "acme-test.com")).toBeNull();
  });

  test("a lapse stops the www. with the root", async () => {
    const t = setupTest();
    const world = stubWorld();
    const { workspaceId, domainId } = await connect(t);
    await goLive(t, world, domainId);
    await setPlan(t, workspaceId, "canceled");
    expect(await resolve(t, "www.acme-test.com")).toBeNull();
  });

  test("a subdomain, or a name that is already www., gets no companion", async () => {
    const t = setupTest();
    const world = stubWorld();
    await connect(t, "docs.acme-test.com", "acme");
    await connect(t, "www.globex-test.com", "globex");
    expect([...world.registrations.values()].map((row) => row.hostname).sort()).toEqual([
      "docs.acme-test.com",
      "www.globex-test.com",
    ]);
  });

  test("a www. another workspace claimed stays theirs, and nobody can claim ours", async () => {
    const t = setupTest();
    stubWorld();
    await connect(t, "www.acme-test.com", "globex");
    await connect(t, "acme-test.com", "acme");
    const held = await companion(t);
    expect(held?.wwwOf).toBeUndefined();
    expect((await rows(t)).filter((row) => row.wwwOf !== undefined)).toEqual([]);

    const fresh = setupTest();
    stubWorld();
    await connect(fresh, "acme-test.com", "acme");
    const { owner, workspaceId } = await payingWorkspace(fresh, "initech");
    const error = await captureError(() =>
      asUser(fresh, owner).mutation(api.functions.customDomains.connect, { workspaceId, hostname: "www.acme-test.com" }),
    );
    expect(errorCode(error)).toBe("HOSTNAME_TAKEN");
  });

  test("the www. is not a second domain: connecting another is still refused", async () => {
    const t = setupTest();
    stubWorld();
    const { owner, workspaceId } = await connect(t);
    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.customDomains.connect, { workspaceId, hostname: "docs.acme-test.com" }),
    );
    expect(errorCode(error)).toBe("LIMIT_REACHED");
  });

  test("removing the root removes its www. at the provider, then both rows", async () => {
    const t = setupTest();
    const world = stubWorld();
    const { owner, domainId } = await connect(t);
    await goLive(t, world, domainId);
    await asUser(t, owner).mutation(api.functions.customDomains.remove, { domainId });
    await runDue(t);
    expect(world.registrations.size).toBe(0);
    expect(await rows(t)).toEqual([]);
  });

  test("removing the www. by its own id removes the root with it, since the sweep would only add it back", async () => {
    const t = setupTest();
    const world = stubWorld();
    const { owner } = await connect(t);
    await asUser(t, owner).mutation(api.functions.customDomains.remove, { domainId: (await companion(t))!._id });
    await runDue(t);
    expect(world.registrations.size).toBe(0);
    expect(await rows(t)).toEqual([]);
  });

  test("a root domain connected before companions existed gets its www. from the sweep", async () => {
    const t = setupTest();
    const world = stubWorld();
    const { domainId } = await connect(t);
    const www = (await companion(t))!;
    await t.run(async (ctx) => await ctx.db.delete(www._id));
    world.registrations.forEach((row, id) => {
      if (row.hostname === "www.acme-test.com") world.registrations.delete(id);
    });

    await t.mutation(internal.functions.customDomains.sweep, {});
    await runDue(t);
    expect((await companion(t))?.wwwOf).toBe(domainId);
    expect([...world.registrations.values()].some((row) => row.hostname === "www.acme-test.com")).toBe(true);
    // And again changes nothing.
    await t.mutation(internal.functions.customDomains.sweep, {});
    expect((await rows(t)).filter((row) => row.hostname === "www.acme-test.com")).toHaveLength(1);
  });

  test("the root's TXT being found wakes its www. at once", async () => {
    const t = setupTest();
    const world = stubWorld();
    const { domainId } = await connect(t);
    world.goLive("www.acme-test.com");
    const root = await t.run(async (ctx) => await ctx.db.get(domainId));
    world.txt.set(ownershipRecordName(root!.hostname), [ownershipRecordValue(root!.verifyToken)]);
    await t.action(internal.functions.customDomainsProvision.check, { domainId });
    await runDue(t);
    expect(await companion(t)).toMatchObject({ ownershipVerified: true, status: "active" });
  });
});
