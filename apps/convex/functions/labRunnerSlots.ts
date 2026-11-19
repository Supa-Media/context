/**
 * Lab runner slots (`.github/workflows/tex-lab-run.yml`'s `lease` job; `scripts/lab-runner-lease.mjs`). The Lab's runs
 * on GitHub no longer share one benchmark runner grant, which rotates its refresh token on every sign-in and so had to
 * run one at a time. Instead there are up to three slots, each its own grant of the same bench test account, and a run
 * takes a free connected slot or waits for one. The rows live in `labRunnerLeases` (`lib/schema/texLab.ts`).
 *
 * Who holds what is decided here, in one place: a run asks `acquire` on every poll and is handed a slot or told how
 * many runs wait ahead of it. A holder's row is reclaimed when its GitHub run is no longer queued or running (a
 * cancelled or finished run never calls `release`), or when it expires. A waiter that stops polling falls out.
 */

import { ConvexError, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "./lib/rowWatch/mutations";

/** A slot is held this long at most, which is past the workflow's own polling limit. */
const SLOT_TTL_MS = 4 * 60 * 60 * 1000;
/** A waiter that has not polled for this long is dropped from the queue. */
const WAIT_TTL_MS = 10 * 60 * 1000;
/** The slots that exist; a slot is connected only when its secrets are set in the workflow's environment. */
const SLOT_MAX = 3;

const GH_RUN_ID = /^\d{1,20}$/;

function checkGhRunId(ghRunId: string): void {
  if (!GH_RUN_ID.test(ghRunId)) throw new ConvexError("Not a GitHub run id");
}

function checkAttempt(attempt: number): void {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 1000) throw new ConvexError("Not a run attempt");
}

function checkSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_MAX) throw new ConvexError("Not a Lab runner slot");
}

/**
 * The caller asks for a slot. Returns the slot it holds, or how many runs wait ahead of it and how many slots are free
 * (a waiting caller polls again). `connected` lists the slots whose secrets the workflow has; `active` lists the ids of
 * the Lab workflow's GitHub runs that are still queued or running.
 */
export const acquire = internalMutation({
  args: {
    ghRunId: v.string(),
    attempt: v.number(),
    labRunId: v.string(),
    connected: v.array(v.number()),
    active: v.array(v.string()),
  },
  returns: v.union(v.object({ slot: v.number() }), v.object({ waiting: v.number(), free: v.number() })),
  handler: async (ctx, a) => {
    checkGhRunId(a.ghRunId);
    checkAttempt(a.attempt);
    a.connected.forEach(checkSlot);
    a.active.forEach(checkGhRunId);
    if (a.connected.length === 0) throw new ConvexError("no Lab runner slot is connected");
    const connected = [...new Set(a.connected)].sort((x, y) => x - y);
    const active = new Set(a.active);
    const now = Date.now();

    // 1. Reclaim: expired rows, rows of GitHub runs that are no longer active, and an older attempt of this same run.
    const rows = await ctx.db.query("labRunnerLeases").collect();
    const live: Doc<"labRunnerLeases">[] = [];
    for (const row of rows) {
      const own = row.ghRunId === a.ghRunId;
      const gone = !own && !active.has(row.ghRunId);
      const stale = own && row.attempt !== a.attempt;
      if (row.expiresAt < now || gone || stale) {
        await ctx.db.delete(row._id);
      } else {
        live.push(row);
      }
    }

    // 2. The caller already holds a slot: keep it.
    const mine = live.find((row) => row.ghRunId === a.ghRunId && row.attempt === a.attempt);
    if (mine?.slot !== undefined) {
      await ctx.db.patch(mine._id, { seenAt: now });
      return { slot: mine.slot };
    }

    // 3. Queue the caller (or keep its place in the queue) and refresh its poll time.
    let me = mine;
    if (me) {
      await ctx.db.patch(me._id, { labRunId: a.labRunId, seenAt: now, expiresAt: now + WAIT_TTL_MS });
    } else {
      const id = await ctx.db.insert("labRunnerLeases", {
        ghRunId: a.ghRunId,
        attempt: a.attempt,
        labRunId: a.labRunId,
        requestedAt: now,
        seenAt: now,
        expiresAt: now + WAIT_TTL_MS,
      });
      me = (await ctx.db.get(id)) as Doc<"labRunnerLeases">;
    }

    // 4. Free connected slots go to the first waiters, by when they asked (then by run id, for a tie).
    const taken = new Set(live.flatMap((row) => (row.slot !== undefined ? [row.slot] : [])));
    const free = connected.filter((slot) => !taken.has(slot));
    const waiters = live
      .filter((row) => row.slot === undefined && !(row.ghRunId === a.ghRunId && row.attempt === a.attempt))
      .concat([me])
      .sort((x, y) => x.requestedAt - y.requestedAt || (x.ghRunId < y.ghRunId ? -1 : x.ghRunId > y.ghRunId ? 1 : 0));
    const place = waiters.findIndex((row) => row.ghRunId === a.ghRunId && row.attempt === a.attempt);

    if (place < free.length) {
      const slot = free[0];
      await ctx.db.patch(me._id, { slot, seenAt: now, expiresAt: now + SLOT_TTL_MS });
      return { slot };
    }
    return { waiting: place, free: free.length };
  },
});

/** The run's attempt is done with its slot (or gave up waiting): its row goes, so the next waiter can take it. */
export const release = internalMutation({
  args: { ghRunId: v.string(), attempt: v.number() },
  returns: v.object({ released: v.boolean() }),
  handler: async (ctx, a) => {
    checkGhRunId(a.ghRunId);
    checkAttempt(a.attempt);
    const rows = await ctx.db
      .query("labRunnerLeases")
      .withIndex("by_ghRun", (q) => q.eq("ghRunId", a.ghRunId))
      .collect();
    const mine = rows.filter((row) => row.attempt === a.attempt);
    for (const row of mine) await ctx.db.delete(row._id);
    return { released: mine.length > 0 };
  },
});
