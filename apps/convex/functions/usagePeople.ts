/**
 * THE CONTEXT USAGE SOURCE: who was active, by an id the control plane cannot turn back into an account.
 *
 * The owner asked for daily-changing people metrics (Active humans, Weekly texters, writers and callers, Returning
 * users, New actives, Day-1 active; decided 2026-11-25, `docs/decisions/data-and-metrics.md`, "The Context usage
 * source"). Those count people, which `usageActiveDaily` (one row per *workspace* per surface per day) cannot.
 *
 * What is kept here, and nothing else: `usagePeopleDaily`, one row per person per UTC day saying they wrote a note in
 * the app or an AI client of theirs called a tool. The person is the gateway's MAC (`apps/mcp/src/usage/person.js`),
 * 16 hex under a key the control plane never holds, so a row names no account here; the gateway marks it behind its
 * own response (`/gateway/usage`'s `people`), and the day is this deployment's, never the caller's. Texting needs no
 * row of its own: a person's own texts are already `agentTurnMarks` in their personal workspace.
 *
 * `exportRows` is what the gateway's hourly usage run reads (`/gateway/usage/export`): those rows, the texts a
 * personal workspace's owner sent, and the accounts made, for the run to MAC and write into the one workspace the
 * gateway's config names. Ids and times only, never a word, a path or a name.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { dayKey } from "./lib/usage";

/** How long a person-day is kept: Returning users reads 8 days, a sheet reads 90. */
export const PEOPLE_RETENTION_DAYS = 90;
/** One gateway report's most people, and one export's most rows of each kind. */
export const MAX_PEOPLE_PER_REPORT = 50;
export const MAX_EXPORT_ROWS = 20_000;
/** An export reaches back at most this far: the sheets keep 90 days, and a turn's mark is kept 30. */
export const MAX_EXPORT_DAYS = 90;

const PERSON = /^[0-9a-f]{16}$/;
export const PEOPLE_KINDS = ["wrote", "called"] as const;
export type PeopleKind = (typeof PEOPLE_KINDS)[number];
const KIND_SET: ReadonlySet<string> = new Set(PEOPLE_KINDS);
const PRUNE_BATCH = 500;
const DAY_MS = 86_400_000;

/** The people marks riding on a usage report, shape-checked: a MAC and a kind, nothing else; the rest dropped. */
export function peopleMarks(raw: unknown): { person: string; kind: PeopleKind }[] {
  if (!Array.isArray(raw)) return [];
  const out: { person: string; kind: PeopleKind }[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, MAX_PEOPLE_PER_REPORT)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { person, kind } = entry as Record<string, unknown>;
    if (typeof person !== "string" || !PERSON.test(person) || typeof kind !== "string" || !KIND_SET.has(kind)) continue;
    const key = `${person}:${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ person, kind: kind as PeopleKind });
  }
  return out;
}

/** Mark each person active today: one row per person per day, a flag set once and then left alone. */
export const mark = internalMutation({
  args: {
    people: v.array(v.object({ person: v.string(), kind: v.string() })),
    /** Test seam. Absent means now; never supplied by a remote caller. */
    at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.at ?? Date.now();
    const day = dayKey(now);
    let applied = 0;
    for (const { person, kind } of peopleMarks(args.people)) {
      const row = await ctx.db
        .query("usagePeopleDaily")
        .withIndex("by_day_person", (q) => q.eq("day", day).eq("person", person))
        .unique();
      if (row === null) {
        await ctx.db.insert("usagePeopleDaily", { day, person, [kind]: true, at: now });
        applied += 1;
      } else if (row[kind] !== true) {
        await ctx.db.patch(row._id, { [kind]: true });
        applied += 1;
      }
    }
    return { applied };
  },
});

/** Person-days past their retention, a batch at a time (`crons.ts`). */
export const prune = internalMutation({
  args: { at: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff = dayKey((args.at ?? Date.now()) - PEOPLE_RETENTION_DAYS * DAY_MS);
    const old = await ctx.db
      .query("usagePeopleDaily")
      .withIndex("by_day", (q) => q.lt("day", cutoff))
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    return { deleted: old.length };
  },
});

export interface UsageExport {
  activity: { day: string; person: string; wrote: boolean; called: boolean }[];
  /** A person's own texts: a turn in their personal workspace (`kind` one), its owner's account. */
  texts: { at: number; userId: string; outcome: "answered" | "exhausted" | "failed" }[];
  signups: { at: number; userId: string }[];
  /** True when a list stopped at `MAX_EXPORT_ROWS`: the run says so rather than writing a short week as whole. */
  cut: boolean;
}

/** Everything since `since` (ms), each list oldest first. */
export const exportRows = internalQuery({
  args: { since: v.number(), at: v.optional(v.number()) },
  handler: async (ctx, args): Promise<UsageExport> => {
    const now = args.at ?? Date.now();
    const since = Math.max(args.since, now - MAX_EXPORT_DAYS * DAY_MS);
    let cut = false;

    const people = await ctx.db
      .query("usagePeopleDaily")
      .withIndex("by_day", (q) => q.gte("day", dayKey(since)))
      .take(MAX_EXPORT_ROWS + 1);
    if (people.length > MAX_EXPORT_ROWS) cut = true;
    const activity = people.slice(0, MAX_EXPORT_ROWS).map((row) => ({ day: row.day, person: row.person, wrote: row.wrote === true, called: row.called === true }));

    const marks = await ctx.db
      .query("agentTurnMarks")
      .withIndex("by_at", (q) => q.gte("at", since))
      .take(MAX_EXPORT_ROWS + 1);
    if (marks.length > MAX_EXPORT_ROWS) cut = true;
    const owners = new Map<Id<"workspaces">, string | null>();
    const texts: UsageExport["texts"] = [];
    for (const turn of marks.slice(0, MAX_EXPORT_ROWS)) {
      // Only a person's own 1:1 texts: a group's turn runs on its sponsor's grant, so it can't say who texted.
      if (turn.client !== "texts" || (turn.kind !== undefined && turn.kind !== "one")) continue;
      if (!owners.has(turn.workspaceId)) {
        const workspace: Doc<"workspaces"> | null = await ctx.db.get(turn.workspaceId);
        owners.set(turn.workspaceId, workspace?.kind === "personal" ? workspace.createdBy : null);
      }
      const userId = owners.get(turn.workspaceId);
      if (userId) texts.push({ at: turn.at, userId, outcome: turn.outcome });
    }

    const made = await ctx.db
      .query("users")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", since))
      .take(MAX_EXPORT_ROWS + 1);
    if (made.length > MAX_EXPORT_ROWS) cut = true;
    const signups = made.slice(0, MAX_EXPORT_ROWS).map((user) => ({ at: Math.round(user._creationTime), userId: user._id as string }));

    return { activity, texts, signups, cut };
  },
});
