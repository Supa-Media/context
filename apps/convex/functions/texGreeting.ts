/**
 * Tex texts first (Dev2, 2026-10-17: "when someone signs up for the waitlist,
 * and I let them in, I want them to get immediate tex access so that tex can
 * guide them through creating their workspaces, connecting their emails and
 * their ai agents"). Until this, a person let in was told to text Tex and
 * nothing happened until they did; somebody who never texted never met Tex.
 *
 * Once a let-in row's phone is on Tex's line (`waitlistTex.ts`), Tex opens a
 * chat from that line and asks for the handle, the first step of setting up
 * by text (`textSetup.ts`). The greeting is the same question that exchange
 * asks, and the `asked` row is written before it goes, so the person's first
 * reply is read as their handle and setup carries on from there: account,
 * personal workspace, then Gmail and their AI in the ordinary texted session.
 *
 * ## Who is greeted
 *
 * Only a phone setup by text would accept anyway (`whoMaySetUp`): a new phone
 * staff let in, or an account's confirmed phone whose account has no personal
 * workspace yet. Anybody already set up, paused, linked or held back is not
 * texted by this. Only an admitted row is greeted, at most once
 * (`texGreetedAt`, claimed in the same transaction as the `asked` row), and
 * only staff letting a row in, or that person confirming their own phone,
 * leads here, so nobody outside can make Tex text a number.
 *
 * A failed send clears both claims, so the next text the person sends is
 * asked for a handle, never taken as one, and the caller falls back to the
 * "You're in" text through the Messaging Service.
 *
 * The call is Linq's Partner API v3 "create a chat" (`POST /v3/chats`, the
 * shape `@linqapp/sdk` sends), with the key the texting Worker replies with.
 * The number never appears in a log.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type ActionCtx } from "../_generated/server";
import { askedRow, SETUP_ASK_TTL_MS, whoMaySetUp } from "./textSetup";

export const LINQ_PARTNER_API = "https://api.linqapp.com/api/partner/v3";
const TIMEOUT_MS = 10_000;

/**
 * Tex's first text. The question `apps/agent/src/setup.ts` asks (`SETUP_COPY.ask`),
 * so whichever side asks first, the person reads one question.
 */
export const TEX_GREETING =
  "Hi, I'm Tex, your Context assistant. You're in, so let's set you up. First, your handle: it's your name on Context, like @ada. Text me the one you want.";

/**
 * Claim the greeting and the `asked` row together. `null` when this row must
 * not be greeted: not admitted, greeted already, a phone setup would refuse,
 * or a setup question already standing (they are mid-exchange).
 */
export const claimGreeting = internalMutation({
  args: { waitlistId: v.id("waitlist"), phone: v.string() },
  returns: v.union(v.null(), v.object({ at: v.number() })),
  handler: async (ctx, { waitlistId, phone }) => {
    const row = await ctx.db.get(waitlistId);
    if (row === null || row.status !== "admitted" || row.texGreetedAt !== undefined) return null;
    if ((await whoMaySetUp(ctx, phone)) === null) return null;
    const now = Date.now();
    const asked = await askedRow(ctx, phone);
    if (asked !== null && asked.stage === "asked") {
      // A live question means Tex already asked; a stale one is renewed.
      if (asked.at + SETUP_ASK_TTL_MS > now) return null;
      await ctx.db.patch(asked._id, { at: now });
    } else {
      await ctx.db.insert("textSetups", { stage: "asked", phone, at: now });
    }
    await ctx.db.patch(waitlistId, { texGreetedAt: now });
    return { at: now };
  },
});

/** Undo a claim whose text never went: only the rows this claim wrote. */
export const releaseGreeting = internalMutation({
  args: { waitlistId: v.id("waitlist"), phone: v.string(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, { waitlistId, phone, at }) => {
    const row = await ctx.db.get(waitlistId);
    if (row?.texGreetedAt === at) await ctx.db.patch(waitlistId, { texGreetedAt: undefined });
    const asked = await askedRow(ctx, phone);
    if (asked !== null && asked.stage === "asked" && asked.at === at) await ctx.db.delete(asked._id);
    return null;
  },
});

/** Linq's answer to the send, in our words. */
type Sent = "sent" | "refused" | "unreachable";

async function openChat(key: string, line: string, phone: string, idempotencyKey: string): Promise<Sent> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${LINQ_PARTNER_API}/chats`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: line,
        to: [phone],
        message: { parts: [{ type: "text", value: TEX_GREETING }], idempotency_key: idempotencyKey },
      }),
      signal: controller.signal,
    });
    return response.ok ? "sent" : "refused";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Have Tex text `phone` first from `line`, when this row may be greeted.
 * True only when the text went. Never throws.
 */
export async function greetByTex(
  ctx: ActionCtx,
  waitlistId: Id<"waitlist">,
  phone: string,
  line: string,
): Promise<boolean> {
  const log = (event: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event: `tex_greeting_${event}`, waitlistId, ...extra }));
  try {
    const key = process.env.LINQ_API_KEY?.trim();
    if (!key) return false;
    const claim = await ctx.runMutation(internal.functions.texGreeting.claimGreeting, { waitlistId, phone });
    if (claim === null) return false;
    const sent = await openChat(key, line, phone, `tex-greeting:${waitlistId}`);
    log(sent);
    if (sent === "sent") return true;
    await ctx.runMutation(internal.functions.texGreeting.releaseGreeting, { waitlistId, phone, at: claim.at });
    return false;
  } catch {
    log("failed", { reason: "unexpected" });
    return false;
  }
}
