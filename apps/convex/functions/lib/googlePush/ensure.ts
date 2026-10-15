/**
 * Keep one product's push registration alive, from inside the pass that just
 * synced it.
 *
 * The pass is the right place for three reasons. It already holds a fresh
 * access token, so registering costs no extra credential handling. It runs at
 * least once per sync interval (at most a day) for every healthy connection,
 * so renewing inside it needs no second scheduler. And it only runs for
 * connections every gate has just allowed, so a disconnected, revoked or
 * switched-off account is never registered for anything.
 *
 * Best-effort, always. A failure here is recorded on the row and the pass
 * still reports what it synced: push is latency, and polling is the
 * guarantee.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { calendarPushAddress, pubsubTopic } from "./config";
import {
  ensureChatSubscription,
  GooglePushError,
  stopCalendarChannel,
  watchCalendar,
  watchGmail,
} from "./watch";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Product = "gmail" | "calendar" | "chat";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Renew when less than this is left. Gmail asks for a daily `watch`, which
 * only extends the one watch; a Calendar channel or Chat subscription is
 * renewed with two days to spare, more than the longest sync interval plus
 * the longest failure backoff.
 */
export const RENEW_WHEN_LEFT_MS: Record<Product, number> = {
  gmail: 6 * DAY,
  calendar: 2 * DAY,
  chat: 2 * DAY,
};
/** After a failed registration, wait this long before trying again. */
export const RETRY_AFTER_FAILURE_MS = HOUR;
/** Calendar's longest channel lifetime. */
const CALENDAR_TTL_SECONDS = 7 * 24 * 60 * 60;

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function failureText(error: unknown): string {
  if (error instanceof GooglePushError) return `${error.reason} (${error.status})`;
  return error instanceof Error ? error.name : "unknown";
}

function needsWork(
  current: { expiresAt?: number; failedAt?: number } | undefined,
  matches: boolean,
  product: Product,
  now: number,
): boolean {
  if (current?.failedAt !== undefined && now - current.failedAt < RETRY_AFTER_FAILURE_MS) return false;
  if (!matches) return true;
  return current?.expiresAt === undefined || current.expiresAt - now < RENEW_WHEN_LEFT_MS[product];
}

export async function ensureGooglePush(
  ctx: ActionCtx,
  input: {
    connectionId: Id<"googleConnections">;
    product: Product;
    accessToken: string;
    fetchImpl: Fetch;
    now?: number;
  },
): Promise<void> {
  const { connectionId, product, accessToken, fetchImpl } = input;
  const now = input.now ?? Date.now();
  try {
    const state = await ctx.runQuery(internal.functions.googlePush.pushState, { connectionId });
    if (state === null || !state.products.includes(product)) return;
    const push = state.push ?? {};

    if (product === "gmail") {
      const topic = pubsubTopic();
      const address = state.address.trim().toLowerCase();
      if (topic === undefined || state.gmailFolders.length === 0) return;
      const current = push.gmail;
      if (!needsWork(current, current?.topic === topic && current?.address === address, "gmail", now)) return;
      try {
        const watched = await watchGmail({ fetchImpl, accessToken, topic, folders: state.gmailFolders });
        await ctx.runMutation(internal.functions.googlePush.recordPushWatch, {
          connectionId,
          gmail: { address, topic, expiresAt: watched.expiresAt },
        });
      } catch (error) {
        await ctx.runMutation(internal.functions.googlePush.recordPushWatch, {
          connectionId,
          gmail: { failedAt: now, failure: failureText(error) },
        });
      }
      return;
    }

    if (product === "chat") {
      const topic = pubsubTopic();
      if (topic === undefined) return;
      const current = push.chat;
      const matches = current?.topic === topic && current?.subscriptionName !== undefined;
      if (!needsWork(current, matches, "chat", now)) return;
      try {
        const subscription = await ensureChatSubscription({
          fetchImpl,
          accessToken,
          topic,
          known: matches ? current?.subscriptionName : undefined,
        });
        await ctx.runMutation(internal.functions.googlePush.recordPushWatch, {
          connectionId,
          chat: {
            subscriptionName: subscription.name,
            topic,
            // Google finished the renewal later than this call: try again in
            // an hour rather than trusting a lifetime nobody reported.
            expiresAt: subscription.expiresAt ?? now + RENEW_WHEN_LEFT_MS.chat + HOUR,
          },
        });
      } catch (error) {
        await ctx.runMutation(internal.functions.googlePush.recordPushWatch, {
          connectionId,
          chat: { failedAt: now, failure: failureText(error) },
        });
      }
      return;
    }

    const address = calendarPushAddress();
    if (address === undefined) return;
    const current = push.calendar;
    const matches = current?.address === address && current?.channelId !== undefined;
    if (!needsWork(current, matches, "calendar", now)) return;
    try {
      const channelId = crypto.randomUUID();
      const token = randomHex(32);
      const watched = await watchCalendar({
        fetchImpl,
        accessToken,
        address,
        channelId,
        token,
        ttlSeconds: CALENDAR_TTL_SECONDS,
      });
      // Recorded before the old channel is stopped, so there is never a
      // moment with no channel this deployment will accept.
      await ctx.runMutation(internal.functions.googlePush.recordPushWatch, {
        connectionId,
        calendar: {
          channelId,
          resourceId: watched.resourceId,
          tokenHash: await sha256Hex(token),
          address,
          expiresAt: watched.expiresAt,
        },
      });
      if (current?.channelId !== undefined && current.resourceId !== undefined) {
        await stopCalendarChannel({
          fetchImpl,
          accessToken,
          channelId: current.channelId,
          resourceId: current.resourceId,
        }).catch(() => undefined);
      }
    } catch (error) {
      await ctx.runMutation(internal.functions.googlePush.recordPushWatch, {
        connectionId,
        calendar: { failedAt: now, failure: failureText(error) },
      });
    }
  } catch (error) {
    // Never the pass's failure. Logged with identifiers only.
    console.log(
      JSON.stringify({
        event: "google.push_register_failed",
        connectionId,
        product,
        errorName: error instanceof Error ? error.name : typeof error,
      }),
    );
  }
}
