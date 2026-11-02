/**
 * Who the workspace-object parity check (`functions/workspaceObjects.ts`) asks about when it compares what Convex
 * and the object each let a reader see.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { samplePrincipals, type ReaderRules, type SamplePrincipal } from "./rows";

/** At most this many real members are asked about once the object decides who its members are. */
const MEMBER_PROBES = 12;

export type Probe = SamplePrincipal & { ask?: { userId: string; groups: string[] } };

/**
 * Who the visibility check asks about. While Convex decides who is a member, the sampled grants
 * (`samplePrincipals`). Once the object does (its access home is `object`), a read naming nobody sees nothing
 * there (`judgedReader`), so the check asks as real members instead: each with the scope their role allows, and
 * Convex's answer computed with the groups the object adds for them (`@<group>`).
 */
export async function probesFor(ctx: ActionCtx, workspaceId: Id<"workspaces">, readerRules: ReaderRules): Promise<Probe[]> {
  const access = await ctx.runQuery(internal.functions.accessObjectsRows.accessOf, { workspaceId, scope: "workspace" });
  if (access !== "object") return samplePrincipals(readerRules);
  const probes: Probe[] = [];
  let cursor: string | null = null;
  do {
    const page = (await ctx.runQuery(internal.functions.accessObjectsExpected.membersPageOf, { workspaceId, cursor, now: Date.now() })) as unknown as {
      rows: Array<{ userId: string; role: string; groups: string[] }>;
      next: string | null;
    };
    for (const member of page.rows) {
      if (probes.length >= MEMBER_PROBES) break;
      const scope = member.role === "owner" ? ("private" as const) : ("team" as const);
      probes.push({ scope, groups: member.groups.map((group) => `@${group}`), ask: { userId: member.userId, groups: [] } });
      if (scope === "private" && probes.length < MEMBER_PROBES) {
        probes.push({ scope: "team", groups: member.groups.map((group) => `@${group}`), ask: { userId: member.userId, groups: [] } });
      }
    }
    cursor = page.next;
  } while (cursor !== null && probes.length < MEMBER_PROBES);
  return probes;
}

