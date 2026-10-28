import { ConvexError, v } from "convex/values";
import { internal } from "../../_generated/api";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import { tryConsumeRateLimit, windowEndsAt, type RateLimitPolicy } from "./rateLimit";

/**
 * How many email sign-in codes one address may be sent.
 *
 * Asking for a code is public: anybody can call `signIn("email", { email })`
 * for an address that is let in, and each call mails it a code. Guessing gains
 * nothing from that (the guess limit is per address and a new code does not
 * reset it), but nothing stopped the mail itself, so one address could be
 * flooded. Phone codes have had the same kind of budget all along
 * (`functions/phoneSignIn.ts`, five a phone an hour).
 *
 * ## Where it is counted, and why there
 *
 * Inside `auth:store`'s `createVerificationCode`, in the same transaction that
 * writes the new code. Two things follow from that:
 *
 *  - **A refused request changes nothing.** Each new code replaces the last
 *    one, and the library writes the row before it mails it. Counting at the
 *    send instead would leave the person holding a code that had just been
 *    replaced by one nobody received. Refused here, the transaction rolls
 *    back, so the newest code already in their inbox still works.
 *  - **Concurrent requests cannot overspend.** Convex mutations are
 *    serializable, so two requests racing for the last slot cannot both win.
 *
 * ## Only per address
 *
 * There is deliberately no deployment-wide cap: one person sending requests
 * for many addresses would use it up and lock everybody else out. What
 * bounds a flood of many addresses is admission (`lib/waitlist.ts`): only an
 * address that is let in is ever mailed.
 *
 * The cost of a per-address budget is that somebody else can spend yours.
 * They cannot read the codes it sends, which arrive in your inbox, so the
 * newest one still signs you in for its ten minutes; after that you wait for
 * the window to end. Fifteen minutes keeps that wait short while allowing a
 * person several resends.
 *
 * Only the ordinary `email` provider is counted. The fixed-code providers
 * (`test-email*`) mail nothing, and the invitation link's code
 * (`magic-link`, `functions/invitationEmail.ts`) has its own limits.
 */
export const EMAIL_CODE_SENDS_PER_ADDRESS = 5;
export const EMAIL_CODE_SEND_WINDOW_MS = 15 * 60 * 1000;
export const TOO_MANY_CODES = "TOO_MANY_CODES";

const COUNTED_PROVIDER = "email";

function policyFor(email: string): RateLimitPolicy {
  return {
    key: `emailCode.sendTo:${email.trim().toLowerCase()}`,
    limit: EMAIL_CODE_SENDS_PER_ADDRESS,
    windowMs: EMAIL_CODE_SEND_WINDOW_MS,
  };
}

/** Spend one send for `email`, or throw `TOO_MANY_CODES` with when to retry. */
export async function spendEmailCodeSend(ctx: MutationCtx, email: string): Promise<void> {
  const policy = policyFor(email);
  if (await tryConsumeRateLimit(ctx, policy)) return;
  throw new ConvexError({
    code: TOO_MANY_CODES,
    message: "Too many codes sent to this address. Use the newest one, or ask again later.",
    retryAfterMs: Math.max(0, (await windowEndsAt(ctx, policy)) - Date.now()),
  });
}

type StoreArgs = { type?: unknown; provider?: unknown; email?: unknown };

/**
 * `auth:store`, with the send budget spent before a new email code is written.
 *
 * `@convex-dev/auth` offers no hook between "a code was asked for" and "a code
 * was written", and it calls its store by the fixed name `auth:store`. So
 * `auth.ts` registers the library's own store under another internal name
 * (`auth:libraryStore`) and exports this as `auth:store`: it spends the budget,
 * then calls the library's store with `ctx.runMutation`. Called from a
 * mutation, that runs inside this same transaction, so a refusal still rolls
 * back before any code row changes, and requests still serialize. Every other
 * call passes through untouched.
 *
 * The arguments are `v.any()` because the library does not export its
 * validator; the library's store validates them when it runs. Both mutations
 * are internal: only the library's own `signIn` and
 * `functions/invitationEmail.ts` call `auth:store`, never a client, and
 * nothing but this calls `auth:libraryStore` (`emailCodeSends.test.ts` pins
 * that).
 */
export function limitEmailCodeSends() {
  return internalMutation({
    args: { args: v.any() },
    handler: async (ctx, { args }): Promise<unknown> => {
      const call = args as StoreArgs;
      if (call?.type === "createVerificationCode" && call.provider === COUNTED_PROVIDER && typeof call.email === "string") {
        await spendEmailCodeSend(ctx, call.email);
      }
      return await ctx.runMutation(internal.auth.libraryStore, { args });
    },
  });
}
