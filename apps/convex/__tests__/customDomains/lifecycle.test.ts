/**
 * Custom domains, end to end against a fake zone and a fake resolver.
 *
 * What these prove, because each is a way a hosting platform gets owned:
 *
 *  - one workspace's domain never resolves to another workspace;
 *  - a CNAME left behind by a previous owner does not verify a new claim;
 *  - removal deletes at the provider before the hostname is freed;
 *  - a lapse stops serving at once, and nothing is deleted by it;
 *  - only an owner of a paying workspace can claim, and a claim is unique.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { ownershipRecordName, ownershipRecordValue } from "../../functions/lib/customDomains/dns";
import { UNVERIFIED_CLAIM_TTL_MS } from "../../functions/lib/customDomains/lifecycle";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import {
  configureDomains,
  OPERATOR_TOKEN,
  payingWorkspace,
  runDue,
  setPlan,
  shortLink,
  stubWorld,
  TARGET,
} from "./fixtures.helpers";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function rowFor(t: TestConvex, domainId: Id<"customDomains">) {
  return await t.run(async (ctx) => await ctx.db.get(domainId));
}

async function publishTxt(
  t: TestConvex,
  world: ReturnType<typeof stubWorld>,
  domainId: Id<"customDomains">,
) {
  const row = await rowFor(t, domainId);
  if (row === null) throw new Error("no row");
  world.txt.set(ownershipRecordName(row.hostname), [ownershipRecordValue(row.verifyToken)]);
}

async function connectLive(
  t: TestConvex,
  world: ReturnType<typeof stubWorld>,
  owner: Id<"users">,
  workspaceId: Id<"workspaces">,
  hostname: string,
): Promise<Id<"customDomains">> {
  const domainId = await asUser(t, owner).mutation(api.functions.customDomains.connect, {
    workspaceId,
    hostname,
  });
  await runDue(t);
  await publishTxt(t, world, domainId);
  world.goLive((await rowFor(t, domainId))!.hostname);
  await t.action(internal.functions.customDomainsProvision.check, { domainId });
  return domainId;
}

describe("claiming a domain", () => {
  test("an owner of a paying workspace connects, and the records to add are shown", async () => {
    const t = setupTest();
    const world = stubWorld();
    await configureDomains(t);
    const { owner, workspaceId } = await payingWorkspace(t, "acme");

    const domainId = await asUser(t, owner).mutation(api.functions.customDomains.connect, {
      workspaceId,
      hostname: " https://Docs.Acme-Test.com/intake ",
    });
    await runDue(t);

    const row = await rowFor(t, domainId);
    expect(row?.hostname).toBe("docs.acme-test.com");
    expect(row?.status).toBe("pending");
    expect(row?.providerId).toBe("ch_1");
    expect(world.calls.filter((call) => call.method === "POST")).toHaveLength(1);

    const settings = await asUser(t, owner).query(api.functions.customDomains.settings, { workspaceId });
    expect(settings.available).toBe(true);
    expect(settings.domain?.stage).toBe("ownership");
    const records = settings.domain?.records ?? [];
    expect(records.find((r) => r.purpose === "routing")).toMatchObject({
      type: "CNAME",
      host: "docs",
      value: TARGET,
      done: false,
    });
    expect(records.find((r) => r.purpose === "ownership")).toMatchObject({
      type: "TXT",
      host: "_context.docs",
      value: ownershipRecordValue(row!.verifyToken),
    });
    // The operator token is in no row and no response.
    expect(JSON.stringify(settings)).not.toContain(OPERATOR_TOKEN);
    expect(JSON.stringify(row)).not.toContain(OPERATOR_TOKEN);
  });

  test("goes live only when ownership, routing and HTTPS have all been seen", async () => {
    const t = setupTest();
    const world = stubWorld();
    await configureDomains(t);
    const { owner, workspaceId } = await payingWorkspace(t, "acme");
    const domainId = await asUser(t, owner).mutation(api.functions.customDomains.connect, {
      workspaceId,
      hostname: "docs.acme-test.com",
    });
    await runDue(t);

    // Routing and HTTPS without the TXT record: not live.
    world.goLive("docs.acme-test.com");
    await t.action(internal.functions.customDomainsProvision.check, { domainId });
    expect((await rowFor(t, domainId))?.status).toBe("pending");
    expect(await t.query(api.functions.customDomains.resolveHost, { hostname: "docs.acme-test.com" })).toBeNull();

    await publishTxt(t, world, domainId);
    await t.action(internal.functions.customDomainsProvision.check, { domainId });
    expect((await rowFor(t, domainId))?.status).toBe("active");
    expect(await t.query(api.functions.customDomains.resolveHost, { hostname: "DOCS.acme-test.com." })).toEqual({
      handle: "acme",
      homeSlug: null,
    });
  });

  test("refuses anybody who is not an owner, and a workspace that is not paying", async () => {
    const t = setupTest();
    stubWorld();
    await configureDomains(t);
    const { owner, workspaceId } = await payingWorkspace(t, "acme");
    const editor = await createUser(t, "editor@example.invalid");
    await addMember(t, workspaceId, editor, "editor");
    const stranger = await createUser(t, "stranger@example.invalid");

    const asEditor = await captureError(() =>
      asUser(t, editor).mutation(api.functions.customDomains.connect, { workspaceId, hostname: "a.acme-test.com" }),
    );
    expect(errorCode(asEditor)).toBe("INSUFFICIENT_ROLE");
    const asStranger = await captureError(() =>
      asUser(t, stranger).mutation(api.functions.customDomains.connect, { workspaceId, hostname: "a.acme-test.com" }),
    );
    expect(errorCode(asStranger)).toBe("WORKSPACE_NOT_FOUND");

    const free = await createWorkspace(t, owner, "acme-free");
    const unpaid = await captureError(() =>
      asUser(t, owner).mutation(api.functions.customDomains.connect, { workspaceId: free, hostname: "b.acme-test.com" }),
    );
    expect(errorCode(unpaid)).toBe("PREMIUM_REQUIRED");
  });

  test("refuses our own domains, malformed names, a second domain and a taken one", async () => {
    const t = setupTest();
    stubWorld();
    await configureDomains(t);
    const a = await payingWorkspace(t, "acme");
    const b = await payingWorkspace(t, "globex");
    const connect = (who: { owner: Id<"users">; workspaceId: Id<"workspaces"> }, hostname: string) =>
      captureError(() =>
        asUser(t, who.owner).mutation(api.functions.customDomains.connect, { workspaceId: who.workspaceId, hostname }),
      );

    expect(errorCode(await connect(a, "mcp.context.lc"))).toBe("INVALID_HOSTNAME");
    expect(errorCode(await connect(a, "context.lc"))).toBe("INVALID_HOSTNAME");
    expect(errorCode(await connect(a, "not a domain"))).toBe("INVALID_HOSTNAME");
    expect(errorCode(await connect(a, "10.0.0.1"))).toBe("INVALID_HOSTNAME");
    expect(errorCode(await connect(a, "*.acme-test.com"))).toBe("INVALID_HOSTNAME");

    await asUser(t, a.owner).mutation(api.functions.customDomains.connect, {
      workspaceId: a.workspaceId,
      hostname: "docs.acme-test.com",
    });
    expect(errorCode(await connect(a, "www.acme-test.com"))).toBe("LIMIT_REACHED");
    // Another workspace, a different spelling of the same name.
    const taken = await connect(b, "HTTPS://DOCS.ACME-TEST.COM.");
    expect(errorCode(taken)).toBe("HOSTNAME_TAKEN");
    expect(String((taken as Error).message)).not.toContain("acme\"");
  });

  test("an unconfigured deployment says so and offers nothing", async () => {
    const t = setupTest();
    stubWorld();
    const { owner, workspaceId } = await payingWorkspace(t, "acme");
    const settings = await asUser(t, owner).query(api.functions.customDomains.settings, { workspaceId });
    expect(settings.available).toBe(false);
    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.customDomains.connect, { workspaceId, hostname: "docs.acme-test.com" }),
    );
    expect(errorCode(error)).toBe("NOT_CONFIGURED");
  });

  test("a member sees the address and status, never the records or a control", async () => {
    const t = setupTest();
    stubWorld();
    await configureDomains(t);
    const { owner, workspaceId } = await payingWorkspace(t, "acme");
    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "member");
    await asUser(t, owner).mutation(api.functions.customDomains.connect, { workspaceId, hostname: "docs.acme-test.com" });
    const settings = await asUser(t, member).query(api.functions.customDomains.settings, { workspaceId });
    expect(settings.canManage).toBe(false);
    expect(settings.domain?.hostname).toBe("docs.acme-test.com");
    expect(settings.domain?.records).toEqual([]);
  });
});

describe("isolation between customers", () => {
  test("two workspaces with the same short link each resolve only to their own", async () => {
    const t = setupTest();
    const world = stubWorld();
    await configureDomains(t);
    const a = await payingWorkspace(t, "acme");
    const b = await payingWorkspace(t, "globex");
    await shortLink(t, a.workspaceId, a.owner, "intake", "anyone");
    await shortLink(t, b.workspaceId, b.owner, "intake", "anyone");

    const domainA = await connectLive(t, world, a.owner, a.workspaceId, "docs.acme-test.com");
    const domainB = await connectLive(t, world, b.owner, b.workspaceId, "globex-test.com");
    await asUser(t, a.owner).mutation(api.functions.customDomains.setHomepage, { domainId: domainA, slug: "intake" });

    expect(await t.query(api.functions.customDomains.resolveHost, { hostname: "docs.acme-test.com" })).toEqual({
      handle: "acme",
      homeSlug: "intake",
    });
    expect(await t.query(api.functions.customDomains.resolveHost, { hostname: "globex-test.com" })).toEqual({
      handle: "globex",
      homeSlug: null,
    });
    expect(await t.query(api.functions.customDomains.resolveHost, { hostname: "unknown-test.com" })).toBeNull();

    // An owner of one cannot touch the other's domain.
    const crossed = await captureError(() =>
      asUser(t, a.owner).mutation(api.functions.customDomains.remove, { domainId: domainB }),
    );
    expect(errorCode(crossed)).toBe("WORKSPACE_NOT_FOUND");
    // Nor point their homepage at the other's link by name.
    await shortLink(t, b.workspaceId, b.owner, "pricing", "anyone");
    const foreign = await captureError(() =>
      asUser(t, a.owner).mutation(api.functions.customDomains.setHomepage, { domainId: domainA, slug: "pricing" }),
    );
    expect(errorCode(foreign)).toBe("LINK_NOT_FOUND");
  });

  test("a members-only link cannot be the homepage", async () => {
    const t = setupTest();
    const world = stubWorld();
    await configureDomains(t);
    const a = await payingWorkspace(t, "acme");
    await shortLink(t, a.workspaceId, a.owner, "handbook", "members");
    const domainId = await connectLive(t, world, a.owner, a.workspaceId, "docs.acme-test.com");
    const error = await captureError(() =>
      asUser(t, a.owner).mutation(api.functions.customDomains.setHomepage, { domainId, slug: "handbook" }),
    );
    expect(errorCode(error)).toBe("LINK_NOT_FOUND");
  });

  test("the HTTP route answers the router with one shape for every absence", async () => {
    const t = setupTest();
    const world = stubWorld();
    await configureDomains(t);
    const a = await payingWorkspace(t, "acme");
    await connectLive(t, world, a.owner, a.workspaceId, "docs.acme-test.com");
    const ask = async (body: unknown) =>
      await (
        await t.fetch("/domain/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json();
    expect(await ask({ hostname: "docs.acme-test.com" })).toEqual({ handle: "acme", homeSlug: null });
    expect(await ask({ hostname: "nope-test.com" })).toEqual({ handle: null, homeSlug: null });
    expect(await ask({})).toEqual({ handle: null, homeSlug: null });
  });
});

describe("takeover", () => {
  test("a CNAME left behind by the last owner does not verify the next claim", async () => {
    const t = setupTest();
    const world = stubWorld();
    await configureDomains(t);
    const a = await payingWorkspace(t, "acme");
    const mallory = await payingWorkspace(t, "mallory");

    const domainId = await connectLive(t, world, a.owner, a.workspaceId, "docs.acme-test.com");
    await asUser(t, a.owner).mutation(api.functions.customDomains.remove, { domainId });
    await runDue(t);
    expect(await rowFor(t, domainId)).toBeNull();
    expect(world.registrations.size).toBe(0);

    // Acme never cleaned up DNS: their CNAME and their old TXT are still there.
    const claim = await asUser(t, mallory.owner).mutation(api.functions.customDomains.connect, {
      workspaceId: mallory.workspaceId,
      hostname: "docs.acme-test.com",
    });
    await runDue(t);
    world.goLive("docs.acme-test.com");
    await t.action(internal.functions.customDomainsProvision.check, { domainId: claim });

    expect((await rowFor(t, claim))?.status).toBe("pending");
    expect((await rowFor(t, claim))?.ownershipVerified).toBe(false);
    expect(await t.query(api.functions.customDomains.resolveHost, { hostname: "docs.acme-test.com" })).toBeNull();
  });

  test("removal deletes at the provider first, and keeps the claim if that fails", async () => {
    const t = setupTest();
    const world = stubWorld();
    await configureDomains(t);
    const a = await payingWorkspace(t, "acme");
    const domainId = await connectLive(t, world, a.owner, a.workspaceId, "docs.acme-test.com");

    world.failures.deleteFails = true;
    await asUser(t, a.owner).mutation(api.functions.customDomains.remove, { domainId });
    await runDue(t);
    expect((await rowFor(t, domainId))?.status).toBe("removing");
    expect(await t.query(api.functions.customDomains.resolveHost, { hostname: "docs.acme-test.com" })).toBeNull();
    const other = await payingWorkspace(t, "globex");
    const blocked = await captureError(() =>
      asUser(t, other.owner).mutation(api.functions.customDomains.connect, {
        workspaceId: other.workspaceId,
        hostname: "docs.acme-test.com",
      }),
    );
    expect(errorCode(blocked)).toBe("HOSTNAME_TAKEN");

    // The sweep retries once the provider answers.
    world.failures.deleteFails = false;
    vi.advanceTimersByTime(6 * 60 * 1000);
    await t.mutation(internal.functions.customDomains.sweep, {});
    await runDue(t);
    expect(await rowFor(t, domainId)).toBeNull();
    expect(world.registrations.size).toBe(0);
  });

  test("an unverified claim is released, so nobody can squat a domain", async () => {
    const t = setupTest();
    const world = stubWorld();
    await configureDomains(t);
    const squatter = await payingWorkspace(t, "squatter");
    const domainId = await asUser(t, squatter.owner).mutation(api.functions.customDomains.connect, {
      workspaceId: squatter.workspaceId,
      hostname: "docs.acme-test.com",
    });
    await runDue(t);
    vi.advanceTimersByTime(UNVERIFIED_CLAIM_TTL_MS + 1);
    await t.mutation(internal.functions.customDomains.sweep, {});
    await runDue(t);
    expect(await rowFor(t, domainId)).toBeNull();
    expect(world.registrations.size).toBe(0);
  });
});

describe("payment", () => {
  test("a lapse stops serving at once, the sweep suspends, and paying again resumes", async () => {
    const t = setupTest();
    const world = stubWorld();
    await configureDomains(t);
    const a = await payingWorkspace(t, "acme");
    const domainId = await connectLive(t, world, a.owner, a.workspaceId, "docs.acme-test.com");

    await setPlan(t, a.workspaceId, "canceled");
    expect(await t.query(api.functions.customDomains.resolveHost, { hostname: "docs.acme-test.com" })).toBeNull();
    await t.mutation(internal.functions.customDomains.sweep, {});
    expect((await rowFor(t, domainId))?.status).toBe("suspended");
    // Nothing deleted: the registration is kept for a resume.
    expect(world.registrations.size).toBe(1);

    await setPlan(t, a.workspaceId, "active");
    await t.mutation(internal.functions.customDomains.sweep, {});
    expect((await rowFor(t, domainId))?.status).toBe("pending");
    await t.action(internal.functions.customDomainsProvision.check, { domainId });
    expect((await rowFor(t, domainId))?.status).toBe("active");
  });
});

describe("the provider", () => {
  test("no credential is recorded as a problem, never thrown away", async () => {
    const t = setupTest();
    const world = stubWorld();
    await configureDomains(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("appSecrets").collect()) await ctx.db.delete(row._id);
    });
    const a = await payingWorkspace(t, "acme");
    const domainId = await asUser(t, a.owner).mutation(api.functions.customDomains.connect, {
      workspaceId: a.workspaceId,
      hostname: "docs.acme-test.com",
    });
    await runDue(t);
    expect((await rowFor(t, domainId))?.problem).toBe("NOT_CONFIGURED");
    expect(world.calls.some((call) => call.url.includes("custom_hostnames"))).toBe(false);
  });

  test("a create whose answer was lost is adopted rather than duplicated", async () => {
    const t = setupTest();
    const world = stubWorld();
    await configureDomains(t);
    const a = await payingWorkspace(t, "acme");
    world.registrations.set("ch_orphan", {
      id: "ch_orphan",
      hostname: "docs.acme-test.com",
      status: "pending",
      ssl: { status: "initializing" },
    });
    const domainId = await asUser(t, a.owner).mutation(api.functions.customDomains.connect, {
      workspaceId: a.workspaceId,
      hostname: "docs.acme-test.com",
    });
    await runDue(t);
    expect((await rowFor(t, domainId))?.providerId).toBe("ch_orphan");
    expect(world.registrations.size).toBe(1);
  });
});

describe("deleting the workspace", () => {
  test("takes its domain off the provider, then frees the name", async () => {
    const t = setupTest();
    const world = stubWorld();
    await configureDomains(t);
    const owner = await createUser(t, "owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "acme-eng", { kind: "shared" });
    await setPlan(t, workspaceId, "active");
    const domainId = await connectLive(t, world, owner, workspaceId, "docs.acme-test.com");
    expect(world.registrations.size).toBe(1);

    await asUser(t, owner).mutation(api.functions.account.deleteWorkspace, {
      workspaceId,
      confirmSlug: "acme-eng",
    });
    expect(await t.query(api.functions.customDomains.resolveHost, { hostname: "docs.acme-test.com" })).toBeNull();
    await runDue(t);
    expect(world.registrations.size).toBe(0);
    expect(await rowFor(t, domainId)).toBeNull();
  });
});
