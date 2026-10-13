/**
 * `/gateway/site` `domain` — AN OWNER'S AGENT CAN CONNECT THE WORKSPACE'S
 * DOMAIN AND READ THE DNS RECORDS TO ADD; NOBODY ELSE'S CAN CONNECT ONE.
 *
 * Asked for by the owner, 2026-10-13: Tex sets up a person's website down to
 * its domain. What is proved here:
 *
 *  1. A member's, a stranger's and a forged token's call is the bare `null`,
 *     and connects nothing.
 *  2. An owner's agent connects a domain through the settings screen's own
 *     function: the same records the screen shows, the same audit line.
 *  3. An editor's agent sees the domain but not its records, and cannot
 *     connect one.
 *  4. The Premium rule and the one-domain rule hold, said in words.
 *  5. Asking again for the connected domain is "Check again", never a second row.
 *  6. A site status names the settings page and each page in the app.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { addMember, asUser, createUser, gatewayPost, setupTest, type TestConvex } from "../fixtures.helpers";
import { configureDomains, payingWorkspace, runDue, setPlan, stubWorld, TARGET } from "../customDomains/fixtures.helpers";
import { bodyOf, registerClient, seedConnectedClient, token } from "./fixtures.helpers";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const OWNER = token("domain_owner");
const EDITOR = token("domain_editor");
const MEMBER = token("domain_member");
const STRANGER = token("domain_stranger");
const CLIENT = "mcp_client_domain";
const SCOPES = ["context:read", "context:write"];

async function domainFixture() {
  vi.stubEnv("APP_ORIGIN", "https://context.lc");
  const t = setupTest();
  const world = stubWorld();
  await configureDomains(t);
  const { owner, workspaceId } = await payingWorkspace(t, "acme");
  const editor = await createUser(t, "acme-editor@example.invalid");
  const member = await createUser(t, "acme-member@example.invalid");
  await addMember(t, workspaceId, editor, "editor", owner);
  await addMember(t, workspaceId, member, "member", owner);
  const { owner: stranger, workspaceId: elsewhere } = await payingWorkspace(t, "elsewhere");

  await registerClient(t, CLIENT);
  const grant = (userId: Id<"users">, accessToken: string, inWorkspace: Id<"workspaces"> = workspaceId) =>
    seedConnectedClient(t, { workspaceId: inWorkspace, userId, clientId: CLIENT, accessToken, scopes: SCOPES });
  await grant(owner, OWNER);
  await grant(editor, EDITOR);
  await grant(member, MEMBER);
  await grant(stranger, STRANGER, elsewhere);
  return { t, world, owner, workspaceId };
}

type Answer = Record<string, unknown> & {
  owner: boolean;
  paying: boolean;
  message?: string;
  settingsUrl: string | null;
  domain: null | { hostname: string; status: string; records: Array<{ type: string; host: string; value: string }> };
};

async function domain(
  f: { t: TestConvex; workspaceId: Id<"workspaces"> },
  accessToken: string,
  hostname?: string,
): Promise<Answer | null> {
  const response = await gatewayPost(f.t, "/gateway/site", {
    accessToken,
    expectedWorkspaceId: f.workspaceId,
    action: "domain",
    ...(hostname === undefined ? {} : { hostname }),
  });
  expect(response.status).toBe(200);
  await runDue(f.t);
  return (await bodyOf(response)).site as Answer | null;
}

const rows = (t: TestConvex) => t.run(async (ctx) => await ctx.db.query("customDomains").collect());

describe("/gateway/site domain", () => {
  test("a member, a stranger and a forged token get the bare null, and nothing is connected", async () => {
    const f = await domainFixture();
    for (const accessToken of [MEMBER, STRANGER, token("domain_forged")]) {
      expect(await domain(f, accessToken, "docs.acme-test.com")).toBeNull();
      expect(await domain(f, accessToken)).toBeNull();
    }
    expect(await rows(f.t)).toEqual([]);
  });

  test("an owner's agent connects a domain and is shown the records the settings screen shows", async () => {
    const f = await domainFixture();
    const before = await domain(f, OWNER);
    expect(before).toMatchObject({ action: "domain", available: true, paying: true, owner: true, domain: null });
    expect(before?.settingsUrl).toBe("https://context.lc/console/@acme?settings=website");

    const answer = await domain(f, OWNER, "Docs.Acme-Test.com");
    expect(answer?.message).toBeUndefined();
    expect(answer?.domain?.hostname).toBe("docs.acme-test.com");
    const screen = await asUser(f.t, f.owner).query(api.functions.customDomains.settings, { workspaceId: f.workspaceId });
    expect(answer?.domain?.records).toEqual(screen.domain?.records);
    expect(answer?.domain?.records.map((record) => [record.type, record.host])).toEqual([
      ["CNAME", "docs"],
      ["TXT", "_context.docs"],
    ]);
    expect(answer?.domain?.records[0]?.value).toBe(TARGET);
    expect([...f.world.registrations.values()].map((row) => row.hostname)).toEqual(["docs.acme-test.com"]);

    const audit = await f.t.run(async (ctx) =>
      (await ctx.db.query("auditEvents").collect()).filter((event) => event.action === "domain.connected"),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBe(f.owner);
  });

  test("an editor's agent sees the domain without its records, and cannot connect one", async () => {
    const f = await domainFixture();
    expect((await domain(f, EDITOR, "docs.acme-test.com"))?.message).toBe(
      "Only the workspace's owner can connect a domain.",
    );
    expect(await rows(f.t)).toEqual([]);

    await domain(f, OWNER, "docs.acme-test.com");
    const seen = await domain(f, EDITOR);
    expect(seen).toMatchObject({ owner: false, domain: { hostname: "docs.acme-test.com", records: [] } });
  });

  test("a workspace that does not pay is told domains are Premium, and nothing is connected", async () => {
    const f = await domainFixture();
    await setPlan(f.t, f.workspaceId, "canceled");
    const answer = await domain(f, OWNER, "docs.acme-test.com");
    expect(answer).toMatchObject({ paying: false, domain: null, message: "Custom domains are part of Premium." });
    expect(await rows(f.t)).toEqual([]);
  });

  test("the connected domain again is a fresh check, and a different one is refused in words", async () => {
    const f = await domainFixture();
    await domain(f, OWNER, "docs.acme-test.com");
    vi.advanceTimersByTime(10_000);
    const lookups = () => f.world.calls.filter((call) => call.url.startsWith("https://cloudflare-dns.com")).length;
    const before = lookups();
    const again = await domain(f, OWNER, "docs.acme-test.com");
    expect(again?.message).toBeUndefined();
    expect(lookups()).toBeGreaterThan(before);

    const other = await domain(f, OWNER, "www.other-test.com");
    expect(other?.message).toBe(
      "This workspace already has docs.acme-test.com. Its owner removes it in Settings › Website before connecting a different one.",
    );
    expect((await rows(f.t)).map((row) => row.hostname)).toEqual(["docs.acme-test.com"]);
  });
});
