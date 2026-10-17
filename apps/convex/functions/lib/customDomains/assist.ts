/**
 * The help around setting a domain up, as opposed to the setup itself
 * (`handlers.ts`): looking a domain up before it is claimed, keeping what
 * public DNS says is in the way, and the two emails — the steps sent to
 * whoever runs the domain, and "it's live".
 *
 * Nothing here decides whether a domain goes live. A survey that never
 * answers, or mail that never sends, leaves the records and the checks
 * exactly as they were.
 */

import { dnsHostSteps } from "@context/shared";
import { ConvexError, type Infer } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { requireUserId } from "../billing/plan";
import { hashToken } from "../crypto";
import { readPersonEmail, recipientLimitKey } from "../personEmail";
import { consumeRateLimit } from "../rateLimit";
import type { domainSurveyValidator } from "../schema/domains";
import { requireWorkspaceRole } from "../workspaceAuth";
import { customDomainsDeployment } from "./config";
import { domainViewFor, workspacePaying } from "./handlers";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Lookups one person may run in an hour: one per pause in typing is plenty. */
export const LOOKUP_HOURLY_LIMIT = 60;
/** Step emails per domain in a day, and to one address in a day. */
export const STEPS_MAIL_DAILY_LIMIT = 3;
export const STEPS_MAIL_RECIPIENT_DAILY_LIMIT = 2;
/** The owner's own words above the steps. */
export const STEPS_NOTE_MAX = 300;

/* -------------------------------------------------------------------------- */
/* Looking a domain up before connecting it                                    */
/* -------------------------------------------------------------------------- */

/**
 * Before the lookup runs: the caller owns the workspace, it may have a
 * domain, and they have not looked up an unreasonable number of names. The
 * lookup itself reads public DNS only, so the limit is about being a polite
 * client of the resolver, not about secrecy.
 */
export async function admitLookupHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<{ target: string }> {
  const userId = await requireUserId(ctx);
  await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");
  const deployment = customDomainsDeployment();
  if (deployment === null) {
    throw new ConvexError({ code: "NOT_CONFIGURED", message: "Custom domains aren't available on this deployment yet." });
  }
  if (!(await workspacePaying(ctx, args.workspaceId))) {
    throw new ConvexError({ code: "PREMIUM_REQUIRED", message: "Custom domains are part of Premium." });
  }
  await consumeRateLimit(ctx, { key: `domain.lookup:${userId}`, limit: LOOKUP_HOURLY_LIMIT, windowMs: HOUR_MS });
  return { target: deployment.target };
}

/* -------------------------------------------------------------------------- */
/* What public DNS said                                                        */
/* -------------------------------------------------------------------------- */

export async function recordSurveyHandler(
  ctx: MutationCtx,
  args: { domainId: Id<"customDomains">; survey: Infer<typeof domainSurveyValidator> },
): Promise<null> {
  const row = await ctx.db.get(args.domainId);
  if (row === null || row.wwwOf !== undefined) return null;
  if (row.status !== "pending" && row.status !== "active") return null;
  await ctx.db.patch(row._id, { survey: args.survey });
  return null;
}

/* -------------------------------------------------------------------------- */
/* Emailing the steps to whoever runs the domain                               */
/* -------------------------------------------------------------------------- */

/** One plain address, or null. The same rule the person-email path applies. */
export function plainAddress(raw: string): string | null {
  const email = readPersonEmail({ to: [raw.trim()], subject: "x", body: "x" });
  return email?.to[0] ?? null;
}

/**
 * The owner sends the setup steps to someone else. Plain text, no sign-in
 * and no link into Context, so it cannot pass for a login request; bounded
 * per domain and per address so it cannot be turned into a mailer.
 */
export async function emailStepsHandler(
  ctx: MutationCtx,
  args: { domainId: Id<"customDomains">; to: string; note: string | null },
): Promise<null> {
  const userId = await requireUserId(ctx);
  const row = await ctx.db.get(args.domainId);
  if (row === null || row.wwwOf !== undefined) {
    throw new ConvexError({ code: "DOMAIN_NOT_FOUND", message: "That domain is no longer connected." });
  }
  await requireWorkspaceRole(ctx, row.workspaceId, userId, "owner");
  if (row.status !== "pending" && !(row.status === "active" && row.hostname.startsWith("www."))) {
    throw new ConvexError({ code: "NOTHING_TO_SEND", message: "There's nothing left to set up for this domain." });
  }
  const to = plainAddress(args.to);
  if (to === null) {
    throw new ConvexError({ code: "INVALID_EMAIL", message: "Enter one email address, like name@example.com." });
  }
  const note = (args.note ?? "").trim();
  if (note.length > STEPS_NOTE_MAX || /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(note)) {
    throw new ConvexError({ code: "INVALID_NOTE", message: `Keep the note under ${STEPS_NOTE_MAX} characters.` });
  }
  const recipient = await hashToken(recipientLimitKey(to));
  try {
    await consumeRateLimit(ctx, { key: `domain.steps:${row._id}`, limit: STEPS_MAIL_DAILY_LIMIT, windowMs: DAY_MS });
    await consumeRateLimit(ctx, {
      key: `domain.steps.to:${recipient}`,
      limit: STEPS_MAIL_RECIPIENT_DAILY_LIMIT,
      windowMs: DAY_MS,
    });
  } catch {
    throw new ConvexError({ code: "RATE_LIMITED", message: "That's enough emails for today. Try again tomorrow." });
  }
  const now = Date.now();
  await ctx.db.patch(row._id, { stepsSent: { to, at: now } });
  await recordAudit(ctx, {
    workspaceId: row.workspaceId,
    actorUserId: userId,
    action: "domain.steps_emailed",
    details: { hostname: row.hostname },
  });
  await ctx.scheduler.runAfter(0, internal.functions.customDomainsMail.sendSteps, {
    domainId: row._id,
    senderId: userId,
    note: note === "" ? null : note,
  });
  return null;
}

/* -------------------------------------------------------------------------- */
/* The two emails                                                              */
/* -------------------------------------------------------------------------- */

export interface StepsMailFacts {
  to: string;
  senderName: string;
  hostname: string;
  zone: string;
  dnsHost: { key: string; name: string } | null;
  records: { type: string; host: string; value: string; done: boolean }[];
  forwardingRoot: string | null;
}

/** What the steps email says, read as its owner would see it on screen. */
export async function stepsMailFactsHandler(
  ctx: QueryCtx,
  args: { domainId: Id<"customDomains">; senderId: Id<"users"> },
): Promise<StepsMailFacts | null> {
  const row = await ctx.db.get(args.domainId);
  if (row === null || row.stepsSent === undefined) return null;
  const view = await domainViewFor(ctx, row.workspaceId, true);
  if (view === null || view.id !== row._id) return null;
  const sender = await ctx.db.get(args.senderId);
  return {
    to: row.stepsSent.to,
    senderName: senderLabel(sender),
    hostname: row.hostname,
    zone: view.zone ?? row.hostname.split(".").slice(-2).join("."),
    dnsHost: view.dnsHost,
    records: view.records.map(({ type, host, value, done }) => ({ type, host, value, done })),
    forwardingRoot: view.forwarding?.forwards === true ? null : (view.forwarding?.root ?? null),
  };
}

function senderLabel(user: Doc<"users"> | null): string {
  const name = typeof user?.name === "string" ? user.name.trim() : "";
  if (name !== "") return name.slice(0, 80);
  return typeof user?.email === "string" ? user.email : "Someone";
}

/** Strip anything that would let a name pretend to be more than a name. */
function plainLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
}

export function stepsMail(facts: StepsMailFacts, note: string | null): { subject: string; text: string } {
  const sender = plainLine(facts.senderName);
  const steps = dnsHostSteps(facts.dnsHost?.key ?? null, facts.dnsHost?.name ?? null, facts.zone);
  const lines: string[] = [];
  if (note !== null) lines.push(`"${plainLine(note)}"`, "");
  lines.push(
    `${sender} is putting their website on ${facts.hostname} and asked you to add a few settings for it.`,
    "",
    steps.open,
    "",
  );
  let n = 1;
  for (const record of facts.records.filter((r) => !r.done)) {
    lines.push(`${n}. ${steps.add}`, `   Type: ${record.type}`, `   Name: ${record.host}`, `   Value: ${record.value}`, "");
    n += 1;
  }
  if (facts.forwardingRoot !== null) {
    lines.push(`${n}. ${steps.forwarding}`, "");
  }
  lines.push(
    `Type only the Name shown above. ${facts.dnsHost?.name ?? "Your DNS company"} adds .${facts.zone} by itself.`,
    "Don't change or delete anything else, including mail settings.",
    "",
    `${sender} sees each step tick off as it arrives. Nothing to reply to.`,
    "",
    "Sent by Context (context.lc) at their request.",
  );
  return { subject: `${sender} asked you to set up ${facts.hostname}`, text: lines.join("\n") };
}

export interface LiveMailFacts {
  hostname: string;
  owner: string | null;
  /** Whoever the steps were emailed to, if anyone: they did the work too. */
  helper: string | null;
}

export async function liveMailFactsHandler(
  ctx: QueryCtx,
  args: { domainId: Id<"customDomains"> },
): Promise<LiveMailFacts | null> {
  const row = await ctx.db.get(args.domainId);
  if (row === null || row.status !== "active" || row.wwwOf !== undefined) return null;
  const owner = await ctx.db.get(row.createdBy);
  const ownerEmail = typeof owner?.email === "string" && owner.email.length > 0 ? owner.email.toLowerCase() : null;
  const helper = row.stepsSent?.to ?? null;
  return { hostname: row.hostname, owner: ownerEmail, helper: helper === ownerEmail ? null : helper };
}

export function liveMail(hostname: string, forHelper: boolean): { subject: string; text: string } {
  return {
    subject: `${hostname} is live`,
    text: (forHelper
      ? [`Thanks for setting it up. The website now opens at https://${hostname}, so there's nothing more to do.`]
      : [
          `Your website now opens at https://${hostname}.`,
          "",
          "Shared links with a short name open there too, and your context.lc links keep working.",
        ]
    )
      .concat(["", "Sent by Context (context.lc)."])
      .join("\n"),
  };
}
