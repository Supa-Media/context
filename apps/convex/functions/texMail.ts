/**
 * Tex in mail, the texting Worker's half (`docs/decisions/note-mail.md`; Dev, 2026-11-27: "Tex in mail should be the
 * same flow as tex in comments I feel, its own mini tex", and its access "should be the same" as a bot's private
 * connection: everything the person can read).
 *
 * `askTexMail` (`noteMail.ts`) keeps a run waiting when a line reaches a person's own Tex's mailbox. The person's Tex
 * store wakes the texting Worker, which claims the owner's waiting runs here: each gets a texting session for the
 * mailbox's own person, minted exactly as their next text would mint it (`keepTextsGrantForUser`, so the same checks:
 * linked, not paused, a member who may operate), and the Worker hands it to the gateway's `/tex/mail-run`. The mail is
 * then sent from the same texting grant that joined the mailbox, so Tex answers as the "tex" it already is there.
 *
 * Only ids and a path cross here, never a word of the mail.
 */

import { v } from "convex/values";
import { internalMutation } from "./lib/rowWatch/mutations";
import { keepTextsGrantForUser, TEXTS_GRANT_TTL_MS } from "./textLinks";

/** The most runs one claim hands out. */
export const MAX_CLAIMED_TEX_MAIL_RUNS = 3;

export const claimTexMailRuns = internalMutation({
  args: {
    ownerWorkspaceId: v.string(),
    runIds: v.array(v.string()),
    tokens: v.array(v.object({ hashedAccessToken: v.string(), hashedRefreshToken: v.string() })),
  },
  returns: v.array(
    v.object({ token: v.number(), runId: v.string(), workspaceId: v.id("workspaces"), path: v.string(), mailboxId: v.string() }),
  ),
  handler: async (ctx, args) => {
    const owner = ctx.db.normalizeId("workspaces", args.ownerWorkspaceId);
    if (owner === null) return [];
    const room = Math.min(MAX_CLAIMED_TEX_MAIL_RUNS, args.tokens.length, args.runIds.length);
    const due = await ctx.db
      .query("texMailRuns")
      .withIndex("by_owner_status", (q) => q.eq("ownerWorkspaceId", owner).eq("status", "due"))
      .take(room);
    const out: Array<{ token: number; runId: string; workspaceId: typeof due[number]["workspaceId"]; path: string; mailboxId: string }> = [];
    for (const run of due) {
      const index = out.length;
      const token = args.tokens[index]!;
      // Marked first: a run is claimed once, whether or not a session comes of it.
      await ctx.db.patch(run._id, { status: "claimed" });
      const linked = await keepTextsGrantForUser(ctx, run.userId, {
        hashedAccessToken: token.hashedAccessToken,
        hashedRefreshToken: token.hashedRefreshToken,
        expiresAt: Date.now() + TEXTS_GRANT_TTL_MS,
        personalWorkspaceId: owner,
        via: "mail",
      });
      if (linked !== "linked") continue;
      out.push({ token: index, runId: args.runIds[index]!, workspaceId: run.workspaceId, path: run.path, mailboxId: run.mailboxId });
    }
    return out;
  },
});
