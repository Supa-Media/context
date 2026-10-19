/**
 * The share dialog's Members position on the rows: base `private` plus the built-in `members` grantee
 * (`rowAccess.ts`), which every real member holds and a pin reader never does. In the pinned workspace that is the
 * only way to keep a note to the people actually invited, because `team` there is every signed-in Context account
 * (`docs/decisions/privacy-and-sharing/all-context-users.md`).
 *
 * The general access control moves a row between positions with one tier write (`nodesAccess.consoleAccess`). Members
 * is a tier write too, and it is the one that touches the list: it adds the members grant, and every other tier
 * takes it away. Everybody else on the list is kept either way.
 */

import type { Doc } from "../../../_generated/dataModel";
import { granteeInputOf, type GranteeInput } from "./setAccess";

/**
 * The owner's list a tier write leaves, from the row's own grants (shares excluded by the caller). `undefined` when
 * the list stays exactly as it is, which is every tier write on a row with no members grant that is not Members.
 */
export function listForTier(own: readonly Doc<"nodeAccess">[], members: boolean): GranteeInput[] | undefined {
  const held = own.some((grant) => grant.granteeKind === "members");
  if (!held && !members) return undefined;
  const others = own
    .filter((grant) => grant.granteeKind !== "members")
    .map(granteeInputOf)
    .filter((grantee): grantee is GranteeInput => grantee !== null);
  if (!members) return others;
  // A members grant already there keeps its role; a new one reads.
  const role = own.find((grant) => grant.granteeKind === "members")?.role ?? "view";
  return [...others, { kind: "members", role }];
}
