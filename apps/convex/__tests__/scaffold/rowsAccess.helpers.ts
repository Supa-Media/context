/**
 * What a connected client is allowed to see in a workspace, judged the way the product judges it now: from the
 * access rows, not from a `privacy.md` in the bucket (`lib/nodes/readerRules.ts`).
 *
 * The gateway's `canSee` is the same function the gateway runs; it is borrowed through `gatewayFormat.helpers`,
 * so these answers are the gateway's own judgement over the rows' rules, not a restatement of them.
 */

import type { Id } from "../../_generated/dataModel";
import type { TestConvex } from "../fixtures.helpers";
import { gatewayInternals, type PrivacyRule } from "../gatewayFormat.helpers";
import { rulesForReaders } from "../../functions/lib/nodes/readerRules";
import type { Audience } from "../../functions/lib/nodes/rowAccess";

/** The rules a workspace's rows give an audience, in the shape the gateway's `canSee` takes. */
export async function rowsRules(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  audience: Audience = "member",
): Promise<{ rules: PrivacyRule[]; overrides: Map<string, PrivacyRule["vis"]> }> {
  // A Map cannot leave `t.run`, so the overrides cross as pairs and are rebuilt here.
  const judged = await t.run(async (ctx) => {
    const held = await rulesForReaders(ctx, workspaceId, audience);
    return {
      rules: held.rules.map((rule) => ({ prefix: rule.prefix, vis: rule.vis as PrivacyRule["vis"] })),
      overrides: [...held.overrides].map(([path, vis]) => [path, vis as PrivacyRule["vis"]] as const),
    };
  });
  return { rules: judged.rules, overrides: new Map(judged.overrides) };
}

/** Whether a client at `scope` may read `key` in this workspace, judged by the gateway over the rows. */
export async function canSeeInRows(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  key: string,
  scope: "private" | "team",
): Promise<boolean> {
  const { rules, overrides } = await rowsRules(t, workspaceId);
  const { canSee } = gatewayInternals();
  return canSee(key, scope, rules, overrides);
}

/** The rows' folder rules as `prefix` and `vis` pairs, sorted by prefix. */
export async function rowFolderRules(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
): Promise<PrivacyRule[]> {
  const { rules } = await rowsRules(t, workspaceId);
  return [...rules].sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
}
