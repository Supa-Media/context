import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { issueTarget, newIssuedCode, recordIssued, storedCodeFor } from "./lib/issuedSignInCodes";
import { sendAccountMail } from "./lib/accountMail";
import { teamInbox } from "./signupAlerts";

/**
 * Sign-in codes staff issue, for the accounts that cannot read their own mail:
 * the CUJ account, the App Store, directory and Google reviewers, and staging's
 * personas (`lib/issuedSignInCodes.ts` names them).
 *
 * Every one is random, works once, expires after ten minutes for every
 * account, and is attempt-limited: ten wrong codes
 * an hour under the address, like every customer, and ten in all against one
 * issued code. It is stored as a keyed hash, like every code
 * (`lib/oneTimeCodes.ts`). This replaced the fixed codes that failed CASA
 * 1.2.1 and 1.3.1/1.3.2/1.3.4 (2026-11-11).
 *
 * Both functions are internal: only someone holding the deployment's deploy
 * key can run them (`npx convex run`), which is already full control of the
 * deployment. Nothing on the public sign-in surface issues or reads a code.
 *
 *  - `issue` returns the code, for staging's scripts, which read it from
 *    `convex run` and never print it.
 *  - `mailToTeam` mails it to the team inbox and returns only when it
 *    expires, for the "Issue a review sign-in code" workflow: a code printed
 *    in a public repository's Actions log would be public.
 */

const issued = v.object({ email: v.string(), code: v.string(), expiresAt: v.number() });

export const issue = internalMutation({
  args: { email: v.string() },
  returns: issued,
  handler: async (ctx, { email }) => {
    const target = issueTarget(email);
    if ("refused" in target) throw new Error(target.refused);
    const code = newIssuedCode();
    const expiresAt = Date.now() + target.lifetimeMs;
    // Through `auth:store`, like every code the library writes: the ordinary
    // provider's send budget is spent for a persona, and the code row replaces
    // any earlier one for the account.
    await ctx.runMutation(internal.auth.store, {
      args: {
        type: "createVerificationCode",
        provider: target.provider,
        email: target.email,
        code: storedCodeFor(target, code),
        expirationTime: expiresAt,
        allowExtraProviders: false,
      },
    });
    await recordIssued(ctx, target, expiresAt);
    console.log(JSON.stringify({ event: "signInCode.issued", provider: target.provider, expiresAt }));
    return { email: target.email, code, expiresAt };
  },
});

export const mailToTeam = internalAction({
  args: { email: v.string() },
  returns: v.object({ mailed: v.boolean(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ mailed: boolean; expiresAt: number }> => {
    const to = teamInbox();
    if (to === null) throw new Error("SIGNUP_ALERTS_EMAIL names no team inbox; nowhere to send the code.");
    const { email, code, expiresAt } = await ctx.runMutation(internal.functions.signInCodes.issue, args);
    const until = new Date(expiresAt).toUTCString();
    await sendAccountMail("signInCode.mailed", {
      to,
      subject: `Sign-in code for ${email}`,
      text:
        `Sign-in code for ${email}: ${code}\n\n` +
        `It works once and expires ${until}. Ten wrong tries delete it. ` +
        `Issuing another replaces it. Give it only through the reviewer's private form.\n`,
    });
    return { mailed: true, expiresAt };
  },
});
