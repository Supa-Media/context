/**
 * A read-only dry run of the access rules a workspace object renders, against Convex's own (owner, 2026-11-01;
 * `docs/decisions/storage-and-credentials/workspace-objects.md`). For every workspace at `home: "object"`, Convex
 * sends its access set and its rendered member and guest rules to the object's `ws.access.check`, which renders
 * the rules from the set and compares. The object stores nothing from it, and nothing in Convex changes.
 *
 * Counts and the workspace's Convex id only, never a path, a name or a message: the workflow's log is public. A
 * workspace whose call fails is recorded with the error's name and counted; the rest are still checked.
 * Internal only; run by `.github/workflows/workspace-object-access-parity.yml`.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { objectDoor } from "./lib/rowWatch/objectDoor";

/** Workspaces per page when the caller names none. Each is one read and one door call. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

type Compared = {
  equal: boolean;
  folders?: { missing: number; extra: number; differs: number };
  notes?: { missing: number; extra: number; differs: number };
};
type Audience = Compared | { skipped: string };
type CheckAnswer = { version: number; skipped?: string; audiences?: Partial<Record<"member" | "guest", Audience>> };

const rowValidator = v.object({
  workspaceId: v.string(),
  version: v.optional(v.number()),
  member: v.string(),
  guest: v.string(),
  skipped: v.optional(v.string()),
  error: v.optional(v.string()),
});

const resultValidator = v.object({
  checked: v.number(),
  equal: v.number(),
  differs: v.number(),
  skipped: v.number(),
  failed: v.number(),
  rows: v.array(rowValidator),
  next: v.union(v.string(), v.null()),
});

const counts = (part: { missing: number; extra: number; differs: number }) => `${part.missing}/${part.extra}/${part.differs}`;

/** One audience as the report words it: `equal`, `differs f:<missing>/<extra>/<differs> n:<missing>/<extra>/<differs>`, or why not compared. */
function audienceWord(audience: Audience | undefined): string {
  if (audience === undefined) return "absent";
  if ("skipped" in audience) return `skipped:${audience.skipped}`;
  if (audience.equal) return "equal";
  // The object could not render one rule per path (`accessRows.js` `check`): a difference with no counts.
  if (audience.folders === undefined || audience.notes === undefined) return "differs render";
  return `differs f:${counts(audience.folders)} n:${counts(audience.notes)}`;
}

/** The error's name, never its message: messages can carry paths. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/** Asks one workspace's object to render and compare. Throws when the object cannot be reached or refuses. */
async function checkOne(ctx: ActionCtx, workspaceId: Id<"workspaces">) {
  const member = await ctx.runQuery(internal.functions.nodesPrivacy.authority, { workspaceId, audience: "member" });
  const guest = await ctx.runQuery(internal.functions.nodesPrivacy.authority, { workspaceId, audience: "guest" });
  const access = await ctx.runQuery(internal.functions.nodesPrivacy.accessSet, { workspaceId });
  const call = objectDoor(ctx, workspaceId);
  return await call<CheckAnswer>("ws.access.check", { access, rules: { member, guest } });
}

/**
 * One page of the dry run over every object-home workspace, in the order `atHome` lists them. `after` is the last
 * workspace id of the previous page; `next` is null when the page reached the end.
 */
export const dryRun = internalAction({
  args: { after: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: resultValidator,
  handler: async (ctx, { after, limit }) => {
    const size = Math.min(Math.max(Math.floor(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const all: Id<"workspaces">[] = await ctx.runQuery(internal.functions.workspaceObjectsRows.atHome, { home: "object" });
    const start = after === undefined ? 0 : all.indexOf(after as Id<"workspaces">) + 1;
    if (after !== undefined && start === 0) throw new Error("the cursor is not an object-home workspace; start again without it");
    const page = all.slice(start, start + size);

    const result = { checked: 0, equal: 0, differs: 0, skipped: 0, failed: 0 };
    const rows: {
      workspaceId: string;
      version?: number;
      member: string;
      guest: string;
      skipped?: string;
      error?: string;
    }[] = [];

    for (const workspaceId of page) {
      result.checked += 1;
      try {
        const answer = await checkOne(ctx, workspaceId);
        const member = audienceWord(answer.audiences?.member);
        const guest = audienceWord(answer.audiences?.guest);
        const audiences = [answer.audiences?.member, answer.audiences?.guest];
        const differs = audiences.some((audience) => audience !== undefined && !("skipped" in audience) && !audience.equal);
        const skippedAudience = audiences.some((audience) => audience !== undefined && "skipped" in audience);
        const skipped = answer.skipped ?? undefined;
        if (skipped !== undefined || (!differs && skippedAudience)) result.skipped += 1;
        else if (differs) result.differs += 1;
        else result.equal += 1;
        rows.push({
          workspaceId: String(workspaceId),
          version: answer.version,
          member: skipped !== undefined ? `skipped:${skipped}` : member,
          guest: skipped !== undefined ? `skipped:${skipped}` : guest,
          ...(skipped !== undefined ? { skipped } : {}),
        });
      } catch (error) {
        result.failed += 1;
        rows.push({ workspaceId: String(workspaceId), member: "unchecked", guest: "unchecked", error: errorName(error) });
      }
    }

    const next = start + size < all.length && page.length > 0 ? String(page[page.length - 1]) : null;
    return { ...result, rows, next };
  },
});
