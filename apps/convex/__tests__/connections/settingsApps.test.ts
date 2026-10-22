import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { asUser, captureError, createUser, createWorkspace, setupTest } from "../fixtures.helpers";
import { CONNECT_LINK_LIMIT, SETTINGS_CONNECT_LIMIT } from "../../functions/lib/connections/links";
import { stubLinear } from "./linearStub.helpers";

/**
 * Apps in Settings (`functions/connectionSettings.ts`): the person sees every
 * app and where they stand in each, and connects one without texting Tex.
 * The Connect button mints the same one-use link Tex sends, so it can only
 * ever connect the presser's own personal workspace.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function world() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.invalid");
  const ana = await createUser(t, "ana@example.invalid");
  const personal = await createWorkspace(t, seyi, "seyi-apps", { kind: "personal" });
  const anas = await createWorkspace(t, ana, "ana-apps", { kind: "personal" });
  const band = await createWorkspace(t, seyi, "band-apps", { kind: "shared" });
  return { t, seyi, ana, personal, anas, band };
}

describe("apps in Settings", () => {
  test("Connect opens the one connect flow, and the connected app shows with its Disconnect", async () => {
    stubLinear();
    const { t, seyi, personal } = await world();
    const before = await asUser(t, seyi).query(api.functions.connectionSettings.myApps, { workspaceId: personal });
    expect(before.find((a) => a.app === "linear")).toMatchObject({ state: "not_connected" });
    expect(before.find((a) => a.app === "planning-center")).toMatchObject({ state: "not_connected" });

    const { token } = await asUser(t, seyi).action(api.functions.connectionSettings.startAppConnect, { workspaceId: personal, provider: "linear" });
    expect(await asUser(t, seyi).query(api.functions.connections.connectLinkInfo, { token })).toMatchObject({ state: "ready", provider: "linear" });
    const started = await asUser(t, seyi).action(api.functions.connections.startProviderConnect, { token });
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;
    await asUser(t, seyi).action(api.functions.connections.completeProviderConnect, {
      provider: "linear",
      state,
      code: "code-1",
      completionSecret: started.completionSecret,
    });
    await t.finishAllScheduledFunctions(() => {}, 20);

    const after = await asUser(t, seyi).query(api.functions.connectionSettings.myApps, { workspaceId: personal });
    const linear = after.find((a) => a.app === "linear")!;
    expect(linear.state).toBe("connected");
    await asUser(t, seyi).mutation(api.functions.connections.disconnectConnection, { connectionId: linear.connectionId! });
    const gone = await asUser(t, seyi).query(api.functions.connectionSettings.myApps, { workspaceId: personal });
    expect(gone.find((a) => a.app === "linear")).toMatchObject({ state: "not_connected" });
  });

  /** Sabotage: give Settings Tex's key again, and the first press here is refused. */
  test("Tex's spent link allowance never refuses the person's own Connect, which has its own", async () => {
    const { t, seyi, personal } = await world();
    await t.run(async (ctx) => {
      await ctx.db.insert("rateLimits", { key: `connect.link:${seyi}`, windowStartedAt: Date.now(), count: CONNECT_LINK_LIMIT });
    });
    const start = () => asUser(t, seyi).action(api.functions.connectionSettings.startAppConnect, { workspaceId: personal, provider: "linear" });
    for (let press = 0; press < SETTINGS_CONNECT_LIMIT; press++) await start();
    expect(await captureError(start)).not.toBeNull();
  });

  /** Sabotage: drop `mayConnect` from `issueLink`, and both refusals here pass a link. */
  test("Connect never makes a link for someone else's workspace or a shared one", async () => {
    const { t, seyi, anas, band } = await world();
    for (const workspaceId of [anas, band]) {
      const error = await captureError(() =>
        asUser(t, seyi).action(api.functions.connectionSettings.startAppConnect, { workspaceId, provider: "linear" }),
      );
      expect(error).not.toBeNull();
    }
    expect(await t.run((ctx) => ctx.db.query("providerConnectLinks").collect())).toHaveLength(0);
  });

  test("a workspace that connects nothing shows no section, and another person's lists nothing of theirs", async () => {
    const { t, seyi, anas, band } = await world();
    expect(await asUser(t, seyi).query(api.functions.connectionSettings.myApps, { workspaceId: band })).toEqual([]);
    expect(await asUser(t, seyi).query(api.functions.connectionSettings.myApps, { workspaceId: anas })).toEqual([]);
  });
});
