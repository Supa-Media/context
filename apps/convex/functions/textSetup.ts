import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { checkAvailability } from "./lib/nameClaims";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { isPhoneAdmitted } from "./lib/waitlist";
import { phoneSignInPaused } from "./lib/emailProof";
import { APP_REVIEW_PHONE } from "./lib/reviewerAccount";
import { attachedEmailsOf } from "./lib/signInEmails";
import { joinedThroughDomain, ownedPersonalWorkspace } from "./lib/accountSetup";
import { createWorkspaceHandler } from "./lib/workspaces/create";
import { startTextedStorage } from "./lib/textSetup/storage";
import { newPhoneAccount, phoneHolder } from "./phoneSignIn";
import { scheduleSignInAlert } from "./signInAlerts";
import { isPhoneNumber, TEXTS_CLIENT_ID } from "./textLinks";

/**
 * Setting somebody up by text (Dev2, 2026-10-17: onboarding happens by text,
 * handle first). A phone let in off the waitlist is told "Text Tex and Tex
 * will set you up" (`waitlistText.ts`); until this, Tex answered it with the
 * sign-in link, because it had no account to answer from.
 *
 * A small fixed exchange, decided here and never by a model:
 *
 *  1. An unlinked phone that may be set up texts anything. Tex asks for the
 *     handle it wants, and an `asked` row remembers that it asked.
 *  2. The next text that is one word (`candidate`, cut out by the Worker) is
 *     checked as a handle with the app's own rules (`checkAvailability`:
 *     format, the reserved list in `lib/names.ts`, and whether it is free).
 *     A refusal says why, and Tex asks again.
 *  3. A good one makes, in one transaction: the account if the phone has none
 *     (as `signInUser` does for an admitted phone), the personal workspace
 *     through `createWorkspaceHandler`, the free managed bucket where this
 *     deployment offers it, and the phone's link. The five starting folders
 *     follow once the bucket answers (`lib/textSetup/layout.ts`). The next
 *     text is an ordinary linked session.
 *
 * ## Who may be set up
 *
 * The sending number is the identity (`apps/agent` answers only iMessage,
 * whose senders Apple authenticates, behind Linq's signature and Tex's
 * contact list). That is the same proof phone sign-in accepts, a code texted
 * to the number, and no more, so this makes exactly the accounts phone
 * sign-in would and nothing it would not:
 *
 *  - a phone nobody holds, only once staff let it in (`isPhoneAdmitted`);
 *  - a phone confirmed on an account (`phoneHolder`), only when that account
 *    owns no personal workspace yet, is not paused by "This wasn't me", and
 *    has no texting link to another number. Its emails are mailed, as for a
 *    phone sign-in.
 *
 * An account that already owns a personal workspace is never set up again
 * and never linked by this: it keeps the link-and-code flow, so a number
 * recycled by its carrier cannot start answering from somebody's notes. A
 * text never makes a second account for a held phone, and never links a
 * phone to any account but the one holding it. Anyone else gets `not_eligible`
 * and the Worker sends the sign-in link, as before.
 *
 * The message's words never reach here: only a single-word candidate does.
 */

/** How long an unanswered "what handle?" stands; a later text asks again. */
export const SETUP_ASK_TTL_MS = 24 * 60 * 60 * 1000;
/** Setup texts one phone may send per hour, handles tried included. */
const SETUP_TEXTS_PER_HOUR = 20;
const WINDOW_MS = 60 * 60 * 1000;
/** Longer than any name may be, so a long one is refused by the rules. */
const MAX_CANDIDATE = 64;

export const setupAnswerValidator = v.union(
  v.object({ status: v.literal("not_eligible") }),
  v.object({ status: v.literal("ask") }),
  v.object({ status: v.literal("too_many") }),
  v.object({ status: v.literal("rejected"), reason: v.string(), handle: v.optional(v.string()) }),
  v.object({
    status: v.literal("set_up"),
    handle: v.string(),
    storage: v.union(v.literal("on_the_way"), v.literal("none")),
  }),
);
export type SetupAnswer = typeof setupAnswerValidator.type;

type Who = { kind: "new" } | { kind: "held"; userId: Id<"users"> };

/** Whether `phone` may be set up by text, and as whom; `null` when it may not. */
async function whoMaySetUp(ctx: MutationCtx, phone: string): Promise<Who | null> {
  if (!isPhoneNumber(phone) || phone === APP_REVIEW_PHONE) return null;
  // Linked already (the session said otherwise only because it is paused).
  const link = await ctx.db
    .query("phoneLinks")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .first();
  if (link !== null) return null;
  const holder = await phoneHolder(ctx, phone);
  if (holder === null) return (await isPhoneAdmitted(ctx.db, phone)) ? { kind: "new" } : null;
  if (await phoneSignInPaused(ctx, holder)) return null;
  if ((await ownedPersonalWorkspace(ctx, holder)) !== null) return null;
  const otherLink = await ctx.db
    .query("phoneLinks")
    .withIndex("by_user", (q) => q.eq("userId", holder))
    .first();
  if (otherLink !== null) return null;
  // `finishSetup`'s rule for someone who came in through a work domain: a
  // personal email first, so leaving that domain cannot strand the account.
  if ((await joinedThroughDomain(ctx, holder)) && (await attachedEmailsOf(ctx, holder)).length === 0) return null;
  return { kind: "held", userId: holder };
}

async function askedRow(ctx: MutationCtx, phone: string) {
  return await ctx.db
    .query("textSetups")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .first();
}

/**
 * One texted step of setting up `phone`. Never throws for an answer, so a
 * rate-limit spend holds; a creation that fails rolls everything back and the
 * route says so.
 */
export const answerSetupText = internalMutation({
  args: { phone: v.string(), candidate: v.optional(v.string()) },
  returns: setupAnswerValidator,
  handler: async (ctx, { phone, candidate }): Promise<SetupAnswer> => {
    const who = await whoMaySetUp(ctx, phone);
    if (who === null) return { status: "not_eligible" };
    if (!(await tryConsumeRateLimit(ctx, { key: `texts.setup:${phone}`, limit: SETUP_TEXTS_PER_HOUR, windowMs: WINDOW_MS }))) {
      return { status: "too_many" };
    }

    const now = Date.now();
    const asked = await askedRow(ctx, phone);
    if (asked === null || asked.at + SETUP_ASK_TTL_MS <= now) {
      if (asked === null) await ctx.db.insert("textSetups", { stage: "asked", phone, at: now });
      else await ctx.db.patch(asked._id, { at: now });
      return { status: "ask" };
    }
    if (candidate === undefined) return { status: "rejected", reason: "not_a_handle" };

    const availability = await checkAvailability(ctx, candidate.slice(0, MAX_CANDIDATE));
    if (!availability.available) {
      return { status: "rejected", reason: availability.reason, handle: availability.normalized.slice(0, 40) };
    }
    return await setUp(ctx, phone, who, availability.normalized, asked._id);
  },
});

async function setUp(
  ctx: MutationCtx,
  phone: string,
  who: Who,
  handle: string,
  askedId: Id<"textSetups">,
): Promise<SetupAnswer> {
  const userId = who.kind === "held" ? who.userId : await newPhoneAccount(ctx, phone);
  const user = await ctx.db.get(userId);
  const displayName = user?.name?.trim() || handle;
  const { workspaceId, slug } = await createWorkspaceHandler(ctx, userId, { slug: handle, displayName, kind: "personal" });
  const now = Date.now();
  await ctx.db.insert("phoneLinks", { userId, phone, linkedAt: now });
  await ctx.db.delete(askedId);

  // Every creation on the trail under the person who texted, through Tex.
  const actor = { workspaceId, actorUserId: userId, actorClientId: TEXTS_CLIENT_ID };
  if (who.kind === "new") {
    await recordAudit(ctx, { ...actor, action: "texts.setup.account_created", details: { phone: phone.slice(-4) } });
  }
  await recordAudit(ctx, { ...actor, action: "texts.setup.workspace_created", details: { slug } });
  await recordAudit(ctx, { ...actor, action: "texts.phone.linked", details: { via: "text_setup" } });
  // An account that existed hears about it at every email, as a phone sign-in does.
  if (who.kind === "held") await scheduleSignInAlert(ctx, userId, phone);

  const storage = await startTextedStorage(ctx, userId, workspaceId);
  return { status: "set_up", handle: slug, storage: storage ? "on_the_way" : "none" };
}

/** Hourly: questions nobody answered, and layouts whose bucket never came. */
export const purgeTextSetups = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("textSetups")
      .withIndex("by_at", (q) => q.lte("at", Date.now() - SETUP_ASK_TTL_MS))
      .take(500);
    for (const row of stale) await ctx.db.delete(row._id);
    return null;
  },
});
