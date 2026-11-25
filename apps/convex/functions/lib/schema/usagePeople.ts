import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The Context usage source's one table (`functions/usagePeople.ts`): that a person wrote a note in the app, or an AI
 * client of theirs called a tool, on a UTC day. One row per person per day.
 *
 * `person` is the gateway's MAC of the person's account (16 hex, under a key derived from the root the gateway's
 * `SEARCH_QUALITY_KEY` object keeps), so this table never names an account and the control plane cannot turn a row
 * back into one. No path, no tool, no time finer than the day.
 */
export const usagePeopleTables = {
  usagePeopleDaily: defineTable({
    day: v.string(),
    person: v.string(),
    wrote: v.optional(v.boolean()),
    called: v.optional(v.boolean()),
    at: v.number(),
  })
    .index("by_day_person", ["day", "person"])
    .index("by_day", ["day"]),
};
