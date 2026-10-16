/**
 * The admin console's Features tab (`functions/featureSwitches.ts`): staff
 * switch a built feature on or off for everyone, and `/gateway/binding`
 * carries the states as `features`. Off is the default, and only a switch
 * staff turned on reads as on.
 *
 * Sabotage (temporary local edit, reverted): `featureStates` answering true
 * for a missing row fails the binding test; dropping `requireAdmin` from `setFeatureSwitch` fails the
 * stranger test.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { gatewayPost } from "./fixtures.helpers";
import { ACCESS_A, bodyOf, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { ADMIN, tester, user } from "./noteIds/noteIds.helpers";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

describe("the Features tab", () => {
  test("every feature is off until staff turn it on, and back off again", async () => {
    const t = tester();
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    const listed = await staff.query(api.functions.featureSwitches.listFeatureSwitches, {});
    expect(listed.map((f) => [f.key, f.on])).toEqual([["vaultKeyUse", false]]);
    await staff.mutation(api.functions.featureSwitches.setFeatureSwitch, { key: "vaultKeyUse", on: true });
    expect((await staff.query(api.functions.featureSwitches.listFeatureSwitches, {}))[0]).toMatchObject({ on: true });
    await staff.mutation(api.functions.featureSwitches.setFeatureSwitch, { key: "vaultKeyUse", on: false });
    expect((await staff.query(api.functions.featureSwitches.listFeatureSwitches, {}))[0]).toMatchObject({ on: false });
    const trail = await t.run((ctx) => ctx.db.query("adminAuditEvents").collect());
    expect(trail.filter((row) => row.action === "feature.switched").map((row) => row.details?.on)).toEqual([true, false]);
  });

  test("a stranger and nobody can neither read nor switch them", async () => {
    const t = tester();
    const stranger = t.withIdentity({ subject: await user(t, "someone@example.com") });
    for (const caller of [t, stranger]) {
      await expect(caller.query(api.functions.featureSwitches.listFeatureSwitches, {})).rejects.toThrow();
      await expect(caller.mutation(api.functions.featureSwitches.setFeatureSwitch, { key: "vaultKeyUse", on: true })).rejects.toThrow();
    }
    expect(await t.run((ctx) => ctx.db.query("featureSwitches").collect())).toEqual([]);
  });

  test("a name not on the list is refused", async () => {
    const t = tester();
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    await expect(staff.mutation(api.functions.featureSwitches.setFeatureSwitch, { key: "everything", on: true })).rejects.toThrow(/no such feature/);
  });
});

describe("/gateway/binding: features", () => {
  test("is absent while every switch is off, and says on once staff switch one on", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const before = await bodyOf(await gatewayPost(t, "/gateway/binding", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs }));
    expect("features" in before).toBe(false);
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    await staff.mutation(api.functions.featureSwitches.setFeatureSwitch, { key: "vaultKeyUse", on: true });
    const after = await bodyOf(await gatewayPost(t, "/gateway/binding", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs }));
    expect(after.features).toEqual({ vaultKeyUse: true });
  });
});

test("switched back off, the binding carries no features again", async () => {
  const { t, aliceWs } = await twoConnectedTenants();
  const staff = t.withIdentity({ subject: await user(t, ADMIN) });
  await staff.mutation(api.functions.featureSwitches.setFeatureSwitch, { key: "vaultKeyUse", on: true });
  await staff.mutation(api.functions.featureSwitches.setFeatureSwitch, { key: "vaultKeyUse", on: false });
  const after = await bodyOf(await gatewayPost(t, "/gateway/binding", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs }));
  expect("features" in after).toBe(false);
});
