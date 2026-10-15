/**
 * The id-copy switch (`functions/noteIds.ts` `setMode`, and the `idLayout`
 * sibling `/gateway/binding` carries): which keys reads use, set by staff and
 * read by the gateway.
 *
 * What is proved:
 *  - `setMode` is staff-only: a stranger and nobody are refused, and the switch
 *    row is untouched by them;
 *  - it is a round trip (paths, ids, paths), and it is allowed while the copy is
 *    paused, which keeps the pause as it was;
 *  - `/gateway/binding` carries `idLayout: "ids"` only in ids mode: absent with
 *    no switch row, absent in paths mode, and present in ids mode, for the
 *    grant's own workspace.
 *
 * Sabotage (temporary local edit, reverted): answering `idLayout` for every
 * mode (not only `ids`) makes the paths-mode case fail; dropping the staff
 * check in `setMode` makes the stranger case fail.
 */

import { beforeEach, afterEach, describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { gatewayPost } from "../fixtures.helpers";
import { ACCESS_A, bodyOf, twoConnectedTenants } from "../controlPlane/fixtures.helpers";
import { ADMIN, tester, user } from "./noteIds.helpers";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

describe("setMode: the id-copy switch", () => {
  test("staff set it both ways, and each answer says the mode it now has", async () => {
    const t = tester();
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    expect(await staff.mutation(api.functions.noteIds.setMode, { mode: "ids" })).toEqual({ mode: "ids" });
    expect((await staff.query(api.functions.noteIds.report, {})).mode).toBe("ids");
    expect(await staff.mutation(api.functions.noteIds.setMode, { mode: "paths" })).toEqual({ mode: "paths" });
    expect((await staff.query(api.functions.noteIds.report, {})).mode).toBe("paths");
  });

  test("the first switch inserts the row, not paused, and names who changed it", async () => {
    const t = tester();
    const staffId = await user(t, ADMIN);
    const staff = t.withIdentity({ subject: staffId });
    expect(await t.run((ctx) => ctx.db.query("noteIdLayout").first())).toBeNull();
    await staff.mutation(api.functions.noteIds.setMode, { mode: "ids" });
    const row = await t.run((ctx) => ctx.db.query("noteIdLayout").first());
    expect(row).toMatchObject({ mode: "ids", paused: false, updatedBy: String(staffId) });
    expect(typeof row!.updatedAt).toBe("number");
  });

  test("a stranger and nobody are refused, and the switch is untouched", async () => {
    const t = tester();
    const stranger = t.withIdentity({ subject: await user(t, "someone@example.com") });
    for (const caller of [t, stranger]) {
      await expect(caller.mutation(api.functions.noteIds.setMode, { mode: "ids" })).rejects.toThrow();
    }
    expect(await t.run((ctx) => ctx.db.query("noteIdLayout").first())).toBeNull();
  });

  test("a stranger cannot switch a row that is already in ids mode back", async () => {
    const t = tester();
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    await staff.mutation(api.functions.noteIds.setMode, { mode: "ids" });
    const stranger = t.withIdentity({ subject: await user(t, "someone@example.com") });
    await expect(stranger.mutation(api.functions.noteIds.setMode, { mode: "paths" })).rejects.toThrow();
    expect((await t.run((ctx) => ctx.db.query("noteIdLayout").first()))!.mode).toBe("ids");
  });

  test("it is allowed while the copy is paused, and the pause stays as it was", async () => {
    const t = tester();
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    await t.run((ctx) => ctx.db.insert("noteIdLayout", { paused: true, mode: "paths", updatedAt: Date.now() }));
    await staff.mutation(api.functions.noteIds.setMode, { mode: "ids" });
    const row = await t.run((ctx) => ctx.db.query("noteIdLayout").first());
    expect(row).toMatchObject({ mode: "ids", paused: true });
    expect((await staff.query(api.functions.noteIds.report, {})).paused).toBe(true);
  });
});

describe("/gateway/binding: idLayout", () => {
  test("is absent while the switch is in paths mode, and absent with no switch row at all", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const none = await bodyOf(await gatewayPost(t, "/gateway/binding", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs }));
    expect("idLayout" in none).toBe(false);
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    await staff.mutation(api.functions.noteIds.setMode, { mode: "paths" });
    const paths = await bodyOf(await gatewayPost(t, "/gateway/binding", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs }));
    expect("idLayout" in paths).toBe(false);
  });

  test("is \"ids\" in ids mode, for the grant's own workspace, and goes again on a switch back", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    await staff.mutation(api.functions.noteIds.setMode, { mode: "ids" });
    const ids = await bodyOf(await gatewayPost(t, "/gateway/binding", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs }));
    expect(ids.idLayout).toBe("ids");
    expect((ids.binding as { workspaceId: string }).workspaceId).toBe(aliceWs);
    await staff.mutation(api.functions.noteIds.setMode, { mode: "paths" });
    const back = await bodyOf(await gatewayPost(t, "/gateway/binding", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs }));
    expect("idLayout" in back).toBe(false);
  });

  test("a refused binding carries no idLayout at all", async () => {
    const { t, bobWs } = await twoConnectedTenants();
    const staff = t.withIdentity({ subject: await user(t, ADMIN) });
    await staff.mutation(api.functions.noteIds.setMode, { mode: "ids" });
    const refused = await bodyOf(await gatewayPost(t, "/gateway/binding", { accessToken: ACCESS_A, expectedWorkspaceId: bobWs }));
    expect(refused).toEqual({ binding: null });
  });
});
