/**
 * A root domain, pointed at us by ALIAS or a flattened CNAME.
 *
 * Such a record answers with addresses, not a CNAME, and without Enterprise
 * apex proxying Cloudflare only activates the hostname once its own TXT record
 * is in place. What these prove:
 *
 *  - the owner of a root domain is shown that TXT beside the other two, and it
 *    is found when the hostname goes active;
 *  - a subdomain, which validates by its CNAME, is never shown it;
 *  - the TXT is taken from Cloudflare only in the one shape it can have;
 *  - "Check again" on a pending root domain asks Cloudflare to look now, and a
 *    scheduled check does not.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { hostnameTxtOf } from "../../functions/lib/customDomains/provider";
import { asUser, setupTest, type TestConvex } from "../fixtures.helpers";
import { configureDomains, payingWorkspace, runDue, stubWorld } from "./fixtures.helpers";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function connect(t: TestConvex, hostname: string) {
  await configureDomains(t);
  const { owner, workspaceId } = await payingWorkspace(t, "acme");
  const domainId = (await asUser(t, owner).mutation(api.functions.customDomains.connect, {
    workspaceId,
    hostname,
  })) as Id<"customDomains">;
  await runDue(t);
  return { owner, workspaceId, domainId };
}

async function records(t: TestConvex, owner: Id<"users">, workspaceId: Id<"workspaces">) {
  const settings = await asUser(t, owner).query(api.functions.customDomains.settings, { workspaceId });
  return settings.domain?.records ?? [];
}

describe("a root domain", () => {
  test("shows Cloudflare's TXT between the ALIAS and ours, found when the hostname goes active", async () => {
    const t = setupTest();
    const world = stubWorld();
    const { owner, workspaceId, domainId } = await connect(t, "acme-test.com");

    const before = await records(t, owner, workspaceId);
    expect(before.map((record) => [record.purpose, record.type, record.host])).toEqual([
      ["routing", "ALIAS", "@"],
      ["hostname", "TXT", "_cf-custom-hostname"],
      ["ownership", "TXT", "_context"],
    ]);
    const registration = [...world.registrations.values()][0]!;
    expect(before[1]).toMatchObject({
      name: "_cf-custom-hostname.acme-test.com",
      value: registration.ownership_verification!.value,
      done: false,
    });

    world.goLive("acme-test.com");
    await t.action(internal.functions.customDomainsProvision.check, { domainId });
    const after = await records(t, owner, workspaceId);
    expect(after.find((record) => record.purpose === "hostname")?.done).toBe(true);
  });

  test("a subdomain validates by its CNAME and is never shown Cloudflare's TXT", async () => {
    const t = setupTest();
    stubWorld();
    const { owner, workspaceId } = await connect(t, "docs.acme-test.com");
    expect((await records(t, owner, workspaceId)).map((record) => record.purpose)).toEqual(["routing", "ownership"]);
  });

  test("Check again asks Cloudflare to look now; a scheduled check leaves its backoff alone", async () => {
    const t = setupTest();
    const world = stubWorld();
    const { owner, domainId } = await connect(t, "acme-test.com");
    const patches = () => world.calls.filter((call) => call.method === "PATCH").length;
    const afterConnect = patches();

    await t.action(internal.functions.customDomainsProvision.check, { domainId });
    expect(patches()).toBe(afterConnect);

    vi.advanceTimersByTime(10_000);
    await asUser(t, owner).mutation(api.functions.customDomains.checkNow, { domainId });
    await runDue(t);
    expect(patches()).toBe(afterConnect + 1);
  });

  test("the TXT is taken from Cloudflare only in its own shape", () => {
    const base = { id: "ch_1", hostname: "acme-test.com" };
    const good = { type: "txt", name: "_cf-custom-hostname.acme-test.com", value: "5b9d356e-a748-4a62-8318-678de84d6eb7" };
    expect(hostnameTxtOf({ ...base, ownership_verification: good })).toEqual({ name: good.name, value: good.value });
    for (const bad of [
      { ...good, name: "_cf-custom-hostname.victim-test.com" },
      { ...good, name: "acme-test.com" },
      { ...good, type: "http" },
      { ...good, value: "x\" onclick=\"" },
      { ...good, value: "short" },
    ]) {
      expect([bad, hostnameTxtOf({ ...base, ownership_verification: bad })]).toEqual([bad, null]);
    }
    expect(hostnameTxtOf(base)).toBeNull();
  });
});
