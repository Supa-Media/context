/**
 * `<handle>.ctxlc.site`: every workspace's published website on the sites
 * domain, answered by the same `resolveHost` the router asks for a customer's
 * domain.
 *
 * What these prove:
 *
 *  - a workspace whose website is on is served at its handle, from `/`, on
 *    any plan, exactly as `context.lc/@handle` is;
 *  - a website that is off, a name nobody holds, a user's name with no
 *    workspace, the bare domain, `www.` and deeper names serve nothing;
 *  - nobody can connect a name on the sites domain as a custom domain.
 */

import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { sitesSubdomainHandle } from "@context/shared";
import { asUser, captureError, createUser, createWorkspace, errorCode, setupTest, type TestConvex } from "../fixtures.helpers";
import { configureDomains, payingWorkspace } from "./fixtures.helpers";

const resolve = (t: TestConvex, hostname: string) => t.query(api.functions.customDomains.resolveHost, { hostname });

async function website(t: TestConvex, workspaceId: Id<"workspaces">, state: "enabled" | "disabled") {
  await t.run(async (ctx) => {
    await ctx.db.insert("websiteStates", { workspaceId, state, updatedAt: Date.now(), ...(state === "enabled" ? { enabledAt: Date.now() } : {}) });
  });
}

async function workspace(t: TestConvex, slug: string) {
  const owner = await createUser(t, `${slug}@example.invalid`);
  return await createWorkspace(t, owner, slug, { kind: "shared" });
}

describe("the sites domain", () => {
  test("a workspace with its website on is served at <handle>.ctxlc.site, on any plan", async () => {
    const t = setupTest();
    await website(t, await workspace(t, "acme"), "enabled");
    expect(await resolve(t, "acme.ctxlc.site")).toEqual({ handle: "acme", homeSlug: null });
    expect(await resolve(t, "ACME.ctxlc.site.")).toEqual({ handle: "acme", homeSlug: null });

    const response = await t.fetch("/domain/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "acme.ctxlc.site" }),
    });
    expect(await response.json()).toEqual({ handle: "acme", homeSlug: null });
  });

  test("a website that is off, or was never turned on, serves nothing", async () => {
    const t = setupTest();
    await website(t, await workspace(t, "acme"), "disabled");
    await workspace(t, "globex");
    expect(await resolve(t, "acme.ctxlc.site")).toBeNull();
    expect(await resolve(t, "globex.ctxlc.site")).toBeNull();
  });

  test("names that are not one workspace's handle serve nothing", async () => {
    const t = setupTest();
    await website(t, await workspace(t, "acme"), "enabled");
    for (const hostname of [
      "nobody.ctxlc.site",
      "ctxlc.site",
      "www.ctxlc.site",
      "docs.acme.ctxlc.site",
      "acme-.ctxlc.site",
      "acme.ctxlc.site.example",
      "acmectxlc.site",
      "acme.ctxlc.site:443",
    ]) {
      expect([hostname, await resolve(t, hostname)]).toEqual([hostname, null]);
    }
  });

  test("a person's own name with no workspace behind it serves nothing", async () => {
    const t = setupTest();
    await createUser(t, "solo@example.invalid");
    expect(await resolve(t, "solo.ctxlc.site")).toBeNull();
  });

  test("a name on the sites domain can never be connected as a custom domain", async () => {
    const t = setupTest();
    await configureDomains(t);
    const { owner, workspaceId } = await payingWorkspace(t, "mallory");
    for (const hostname of ["acme.ctxlc.site", "ctxlc.site", "www.ctxlc.site"]) {
      const error = await captureError(() =>
        asUser(t, owner).mutation(api.functions.customDomains.connect, { workspaceId, hostname }),
      );
      expect([hostname, errorCode(error)]).toEqual([hostname, "INVALID_HOSTNAME"]);
    }
  });

  test("the label is read only from the one shape the address can have", () => {
    expect(sitesSubdomainHandle("acme.ctxlc.site")).toBe("acme");
    expect(sitesSubdomainHandle("a-b-1.ctxlc.site")).toBe("a-b-1");
    for (const bad of ["ctxlc.site", "www.ctxlc.site", "-a.ctxlc.site", "a..ctxlc.site", "a.b.ctxlc.site", "a_b.ctxlc.site", "a.ctxlc.site.evil", "xn--pple-43d.ctxlc.site", "ab--c.ctxlc.site"]) {
      expect([bad, sitesSubdomainHandle(bad)]).toEqual([bad, null]);
    }
  });
});
