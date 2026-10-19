/**
 * The share dialog's built-in positions on the rows: the grants a tier write sets or takes away
 * (`nodesAccess.consoleAccess`). Everybody else on the list is kept either way.
 *
 *  - **All Context users** (pinned workspace only): base `team` plus the built-in `accounts` grantee, which every
 *    signed-in account holds (`rowAccess.ts`).
 *  - **Members of @context-lc**: base `team` and neither built-in grant, since `team` means the real members there
 *    as everywhere (`docs/decisions/privacy-and-sharing/all-context-users.md`). Before the pinned workspace's
 *    migration has run (`lib/pinnedReaders.ts`) a pin reader still reads `team`, so there it is written as it was
 *    on 2026-10-19: base `private` plus the built-in `members` grantee, which a pin reader never holds.
 *
 * Any other tier takes both built-in grants away, so Restricted means owners and the people named, nothing hidden.
 */

import type { Doc } from "../../../_generated/dataModel";
import { granteeInputOf, type GranteeInput } from "./setAccess";

/** The built-in grant a position puts on the row, or none. */
export type BuiltIn = "members" | "accounts" | null;

const BUILT_IN = new Set(["members", "accounts"]);

/**
 * The owner's list a tier write leaves, from the row's own grants (shares excluded by the caller). `undefined` when
 * the list stays exactly as it is, which is every tier write on a row holding no built-in grant that adds none.
 */
export function listForTier(own: readonly Doc<"nodeAccess">[], builtIn: BuiltIn): GranteeInput[] | undefined {
  const held = own.some((grant) => BUILT_IN.has(grant.granteeKind));
  if (!held && builtIn === null) return undefined;
  const others = own
    .filter((grant) => !BUILT_IN.has(grant.granteeKind))
    .map(granteeInputOf)
    .filter((grantee): grantee is GranteeInput => grantee !== null);
  if (builtIn === null) return others;
  // A members grant already there keeps its role; a new one reads. `accounts` only ever reads (`setAccess`).
  const role = builtIn === "members" ? (own.find((grant) => grant.granteeKind === "members")?.role ?? "view") : "view";
  return [...others, { kind: builtIn, role }];
}
