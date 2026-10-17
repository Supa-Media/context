/**
 * The two emails around setting a domain up: the steps an owner sends to
 * whoever runs the domain, and "it's live". Both plain text, both scheduled
 * from a mutation that already decided they may go (`lib/customDomains/assist.ts`),
 * and neither can change whether a domain is served. Logs carry the domain id
 * and the outcome, never an address.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { sendAccountMail } from "./lib/accountMail";
import { liveMail, stepsMail, type LiveMailFacts, type StepsMailFacts } from "./lib/customDomains/assist";

const FROM = process.env.AUTH_EMAIL_FROM ?? "hello@context.lc";

export const sendSteps = internalAction({
  args: { domainId: v.id("customDomains"), senderId: v.id("users"), note: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const facts: StepsMailFacts | null = await ctx.runQuery(internal.functions.customDomains.stepsMailFacts, {
      domainId: args.domainId,
      senderId: args.senderId,
    });
    if (facts === null) return null;
    const mail = stepsMail(facts, args.note);
    await sendAccountMail("custom_domain.steps_mail", { to: facts.to, ...mail, from: FROM });
    return null;
  },
});

export const sendLive = internalAction({
  args: { domainId: v.id("customDomains") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const facts: LiveMailFacts | null = await ctx.runQuery(internal.functions.customDomains.liveMailFacts, {
      domainId: args.domainId,
    });
    if (facts === null) return null;
    if (facts.owner !== null) {
      await sendAccountMail("custom_domain.live_mail", { to: facts.owner, ...liveMail(facts.hostname, false), from: FROM });
    }
    if (facts.helper !== null) {
      await sendAccountMail("custom_domain.live_mail", { to: facts.helper, ...liveMail(facts.hostname, true), from: FROM });
    }
    return null;
  },
});
