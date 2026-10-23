/**
 * What somebody who reaches the pinned workspace through the pin alone may read there: the notes the owner opened
 * to All Context users, and nothing else (decided by the owner, 2026-10-19;
 * `docs/decisions/privacy-and-sharing/all-context-users.md`).
 *
 * `team` in `@context-lc` means its real members, as it does in every workspace. A pin reader is not one: they have
 * no `workspaceMembers` row (`lib/pinnedContext.ts` says why there is none), so they read the way an outsider does,
 * as a **guest**. A guest's rules are the rows rendered for guests (`renderAccess(rows, "guest")`), where `team`
 * never appears, and the names they hold are the tokens of the rows granted to `accounts`
 * (`accessNamesFor({ account: true })`). Beside those they hold `READS_AS_GUEST`, which is how every reader
 * downstream of a clearance knows to render for a guest, and which shuts `team` to them even where a reader was
 * handed a member's rules instead (`lib/privacy.ts`).
 *
 * ## The names travel where a clearance's names already travel
 *
 * `grantedNames` is what every read path already passes from the place a caller is resolved
 * (`resolveFileAccess`, `contextsForGrant`) to the place a path is judged. Putting the guest's answer there, rather
 * than in a new argument beside it, is what keeps this from being one more parameter threaded through ninety call
 * sites, any one of which could miss it. A site that drops the names entirely drops `READS_AS_GUEST` with them; the
 * gateway's tree routes did, and `readClearance` now carries the names for that reason.
 *
 * ## Until the migration has run, a pin reader reads as before
 *
 * The rows that were `team` here get their `accounts` grant from `functions/pinnedAccounts.ts`. Reading pin readers
 * as guests before that would leave the guides, the forms and the website dark for every account, so the guest
 * clearance waits for `nodeMigration.pinnedAccountsAt`, which the migration sets when every `team` row has its
 * grant. Before it, a pin reader gets no names and reads at `team`, exactly as on the day this shipped.
 */

import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { accessRowsOf } from "./nodes/accessRows";
import { accessNamesFor, type Audience } from "./nodes/rowAccess";
import { reachesPinnedContext } from "./pinnedContext";
import { READS_AS_GUEST } from "./privacy";

/** `READS_AS_GUEST` as a granted name is stored: without its `@`, as `grantedNamesFor` returns names. */
export const READS_AS_GUEST_NAME = READS_AS_GUEST.slice(1);

/** Whether pin readers read as guests yet: rows mode, and the pinned workspace's rows migrated. */
export async function pinReadersAreGuests(db: QueryCtx["db"]): Promise<boolean> {
  const row = await db.query("nodeMigration").first();
  return row?.pinnedAccountsAt !== undefined;
}

/**
 * The names a pin reader holds in the pinned workspace, without `@`: `READS_AS_GUEST` and the token of every row
 * granted to `accounts`. `null` for anybody who is not a pin reader of this workspace, a real member included, so
 * the caller resolves them as it always has. `[]` before the migration (see the module comment).
 */
export async function pinReaderNames(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<string[] | null> {
  if (!(await reachesPinnedContext(ctx, workspaceId, userId))) return null;
  return await guestNamesIn(ctx, workspaceId);
}

/**
 * The names every pin reader of this workspace holds, the same for each of them: `READS_AS_GUEST` and the tokens of
 * the rows granted to `accounts`. `[]` before the migration. For a check made on all their behalf, such as "may a
 * bug report be written here" (`bugNotes.ts`), as well as for one reader.
 */
export async function guestNamesIn(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<string[]> {
  if (!(await pinReadersAreGuests(ctx.db))) return [];
  // Only the `accounts` grants: a person named on a row here reads it through Shared with me, as any outsider does.
  const rows = (await accessRowsOf(ctx, workspaceId)).map((row) => ({
    ...row,
    grantees: row.grantees.filter((grantee) => grantee.kind === "accounts"),
  }));
  const names = accessNamesFor({ account: true }, rows).map((name) => name.slice(1));
  return [READS_AS_GUEST_NAME, ...names];
}

/** Which rendering of the rows these names are judged by: a guest's when they say so (`READS_AS_GUEST`). */
export function audienceOfNames(names: Iterable<string> | undefined): Audience {
  for (const name of names ?? []) {
    if (name === READS_AS_GUEST || name === READS_AS_GUEST_NAME) return "guest";
  }
  return "member";
}
