/**
 * Every old style dial becomes its quick-pick line (Dev2, 2026-11-01;
 * `docs/decisions/texting-assistant/custom-instructions.md`): a person's own
 * row and each group chat's get `instructions` written from their dials
 * (`linesFromStyle`), only where none are set yet. One bubble also turned the
 * progress texts off, so those rows get `updates: "off"` where none is set. A
 * group row gets `speaksUp` from its mute and style. The old fields are left
 * as they are, no longer read (TODO there to drop them). Run by the `settings`
 * step of the `Tex group chats migration` workflow: a dry run counts and
 * writes nothing; counts only, never an id.
 */

import { v } from "convex/values";
import { internalMutation } from "./lib/rowWatch/mutations";
import { linesFromStyle } from "./lib/texInstructions";

export const moveToInstructions = internalMutation({
  args: { dryRun: v.boolean() },
  returns: v.object({ people: v.number(), peopleMoved: v.number(), groups: v.number(), groupsMoved: v.number() }),
  handler: async (ctx, { dryRun }) => {
    let peopleMoved = 0;
    const people = await ctx.db.query("texStylePreferences").collect();
    for (const row of people) {
      const lines = row.instructions === undefined ? linesFromStyle(row.texStyle) : "";
      const off = row.updates === undefined && row.texStyle?.bubbles === "one";
      if (lines === "" && !off) continue;
      peopleMoved += 1;
      if (!dryRun) await ctx.db.patch(row._id, { ...(lines !== "" ? { instructions: lines } : {}), ...(off ? { updates: "off" as const } : {}) });
    }
    let groupsMoved = 0;
    const groups = await ctx.db.query("textGroups").collect();
    for (const row of groups) {
      const lines = row.instructions === undefined ? linesFromStyle(row.texStyle) : "";
      const off = row.updates === undefined && row.texStyle?.bubbles === "one";
      const level = row.speaksUp !== undefined ? null : row.mutedAt !== undefined ? ("off" as const) : (row.engagement ?? null);
      if (lines === "" && !off && level === null) continue;
      groupsMoved += 1;
      if (dryRun) continue;
      await ctx.db.patch(row._id, {
        ...(lines !== "" ? { instructions: lines, instructionsSetBy: row.texStyleSetBy, instructionsSetAt: row.texStyleSetAt } : {}),
        ...(off ? { updates: "off" as const } : {}),
        ...(level !== null ? { speaksUp: level, speaksUpSetBy: row.engagementSetBy, speaksUpSetAt: level === "off" ? row.mutedAt : row.engagementSetAt } : {}),
        ...(level === "off" && row.engagement !== undefined ? { speaksUpBefore: row.engagement } : {}),
      });
    }
    return { people: people.length, peopleMoved, groups: groups.length, groupsMoved };
  },
});
