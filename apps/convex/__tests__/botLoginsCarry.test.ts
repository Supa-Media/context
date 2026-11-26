import { describe, expect, test } from "vitest";
import { addMember, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";
import { registerClient, seedConnectedClient, token } from "./controlPlane/fixtures.helpers";

/**
 * Bot logins bound in the control plane before bindings moved to the workspace's object (`functions/botLoginsCarry.ts`;
 * Dev, 2026-11-26: "why would they need to rebind?"): the connection's own token reads its old binding once, to carry
 * it into the object. Nobody else's token reads it, and nothing writes it.
 *
 * Sabotage: dropping the grant from the lookup (any row in the workspace) failed "only that connection reads it".
 */

async function world() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi-carry@example.invalid");
  const ana = await createUser(t, "ana-carry@example.invalid");
  const supa = await createWorkspace(t, seyi, "supa-carry", { kind: "shared" });
  await addMember(t, supa, ana, "editor");
  await registerClient(t, "mcp_client_cursor");
  const GROK = token("grok_carry");
  const ANA = token("ana_carry");
  await seedConnectedClient(t, { workspaceId: supa, userId: seyi, clientId: "mcp_client_cursor", accessToken: GROK });
  await seedConnectedClient(t, { workspaceId: supa, userId: ana, clientId: "mcp_client_cursor", accessToken: ANA });
  const door = async (accessToken: string) =>
    await (await gatewayPost(t, "/gateway/bots/hook", { accessToken, expectedWorkspaceId: String(supa), action: "carried" })).json();
  return { t, seyi, supa, GROK, ANA, door };
}

describe("carrying a bot login into its workspace's object", () => {
  test("only that connection reads its old binding", async () => {
    const { t, seyi, supa, GROK, ANA, door } = await world();
    expect(await door(GROK)).toEqual({ bot: null });
    await t.run(async (ctx) => {
      const grant = (await ctx.db.query("oauthGrants").collect()).find((row) => row.userId === seyi)!;
      await ctx.db.insert("botLogins", { grantId: grant._id, workspaceId: supa, bot: "grok-bot", name: "Grok Bot", at: 1 });
    });
    expect(await door(GROK)).toEqual({ bot: "grok-bot", name: "Grok Bot" });
    expect(await door(ANA)).toEqual({ bot: null });
  });
});
