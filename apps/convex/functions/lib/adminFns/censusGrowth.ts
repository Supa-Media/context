/**
 * The census's growth slice: how far each account got, texting, and who may
 * text Tex.
 *
 * Feeds the Growth page of the staff console. Like the rest of the census it
 * is metadata only: whether a link exists, whether a membership is of a shared
 * workspace, an @slug. Nothing a customer wrote.
 *
 * ## The four facts
 *
 * - `textsTex`: the account has at least one phone linked for texting
 *   (`phoneLinks`, the same rows `people.ts` reads as `textingPhones`).
 * - `hasActiveClient`: one of its grants is active (`census.ts`, as before).
 * - `inSharedWorkspace`: it is a member of a workspace whose kind is `shared`.
 * - `signsInWithPhone`: it has a verified sign-in phone (`rosterPhone`'s rule).
 *
 * ## Who may text Tex
 *
 * The Linq shared line's contact list is held by Linq, not by any table here
 * (`lib/adminFns/texAllowlist.ts`), and reading it is a network call. So the
 * census cannot count "phone on the list" without an external read. The
 * fallback is in `texAccessOf`: `canText` is the accounts with a texting link,
 * and `phoneButOff` the accounts with a sign-in phone and no texting link.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { CENSUS_CEILING, pageOf, type Page } from "../census";

/** The @slugs the mail list names at most. */
export const MAIL_OPEN_SLUG_LIMIT = 20;

/** What one account has done, as the growth funnel reads it. */
export interface GrowthFacts {
  textsTex: boolean;
  hasActiveClient: boolean;
  inSharedWorkspace: boolean;
  signsInWithPhone: boolean;
}

export interface GrowthRow {
  step: string;
  count: number;
}

/**
 * Every account, against four independent thresholds. Like `funnelOf`, each
 * step is counted on its own, never clamped to the one above it.
 */
export function growthFunnelOf(accounts: readonly GrowthFacts[]): GrowthRow[] {
  return [
    { step: "signed-up", count: accounts.length },
    { step: "texted-tex", count: accounts.filter((a) => a.textsTex).length },
    { step: "connected-a-client", count: accounts.filter((a) => a.hasActiveClient).length },
    { step: "in-a-shared-workspace", count: accounts.filter((a) => a.inSharedWorkspace).length },
  ];
}

/** The waitlist's funnel: `let-in` first, then the accounts let in. */
export function waitlistGrowthFunnelOf(letIn: number, accounts: readonly GrowthFacts[]): GrowthRow[] {
  return [
    { step: "let-in", count: letIn },
    { step: "signed-up", count: accounts.length },
    { step: "texted-tex", count: accounts.filter((a) => a.textsTex).length },
    { step: "connected-a-client", count: accounts.filter((a) => a.hasActiveClient).length },
  ];
}

/**
 * Who may text Tex, without reading Linq.
 *
 * `canText` is accounts with a texting link. `phoneButOff` is accounts with a
 * sign-in phone and no texting link: the people who have a number Tex could
 * answer, and are not linked for it.
 */
export function texAccessOf(accounts: readonly GrowthFacts[]): { canText: number; phoneButOff: number } {
  return {
    canText: accounts.filter((a) => a.textsTex).length,
    phoneButOff: accounts.filter((a) => a.signsInWithPhone && !a.textsTex).length,
  };
}

/** Accounts holding a membership of a shared workspace, by account key. */
export function accountsInShared(
  members: readonly { userId: Id<"users">; workspaceId: Id<"workspaces"> }[],
  sharedWorkspaceKeys: ReadonlySet<string>,
): Set<string> {
  const accounts = new Set<string>();
  for (const member of members) {
    if (sharedWorkspaceKeys.has(String(member.workspaceId))) accounts.add(String(member.userId));
  }
  return accounts;
}

/**
 * The accounts with a texting link. A bounded scan of `phoneLinks`, like the
 * other census reads; a filled page makes the figures floors (see `pageOf`).
 */
export async function textingUsers(ctx: QueryCtx): Promise<{ page: Page<{ userId: Id<"users"> }>; keys: Set<string> }> {
  const page = pageOf(await ctx.db.query("phoneLinks").take(CENSUS_CEILING + 1));
  return { page, keys: new Set(page.rows.map((row) => String(row.userId))) };
}

/**
 * The @slugs of the workspaces whose mail list accepts anyone: sorted,
 * de-duplicated, at most `MAIL_OPEN_SLUG_LIMIT`. A row whose workspace is gone
 * is skipped rather than named.
 */
export async function openMailSlugs(
  ctx: QueryCtx,
  mailRows: readonly { workspaceId: Id<"workspaces">; allowAnySender: boolean }[],
): Promise<string[]> {
  const slugs = new Set<string>();
  for (const row of mailRows) {
    if (!row.allowAnySender) continue;
    const workspace = await ctx.db.get(row.workspaceId);
    if (workspace !== null) slugs.add(workspace.slug);
  }
  return [...slugs].sort().slice(0, MAIL_OPEN_SLUG_LIMIT);
}
