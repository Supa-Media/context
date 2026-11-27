/**
 * CALENDARS FOR A MADE-UP GROUP CHAT'S PEOPLE (Dev2, 2026-11-27: a group check-in's calendar clash goes to the
 * calendar's own person privately, and no Lab test chat had a calendar with events to show it; the standing rule is to
 * fix a testing gap for everyone, through the shared mocks).
 *
 * `open { source: "world", world: { people: [{ name, calendar: { events, shared? } }] } }` on a pull request's preview
 * gives that person a Google calendar on the preview's own emulators (`packages/emulators`), connected to their
 * personal workspace as a real connect leaves it, with the events asked for on it and, unless `shared: false`, shared
 * with the chat (`chatCalendarShares`) as "Tex share my calendar here" would. Every read then runs the real path:
 * the calendar route, `chatCalendarClearance`, free and busy for anyone but its own person.
 *
 * The emulator signs in only its seeded accounts, so each calendar is one of the personas' (`beta` to `epsilon`; alpha
 * is the preview's own developer), at most four a chat. A persona's calendar is the preview's, not the chat's: events
 * an earlier test chat added stay on it, and emulate's event list names no time zone, so a day reads in UTC. Guarded by
 * `isIsolatedPreview` and the emulators' origin on every call.
 */

import "./lib/emulators";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { encryptSecret, requireKeyset } from "./lib/crypto";
import { emulatorsOrigin } from "./lib/emulators";
import { CALENDAR_OWNED_READ_SCOPE, CALENDAR_OWNED_SCOPE, exchangeGoogleCode, IDENTITY_SCOPES } from "./lib/googleOAuth";
import { googleClientFor } from "./lib/googleConnect/clients";
import { isIsolatedPreview } from "./lib/previewDeployment";
import { personalWorkspaceOf } from "./textLinks";

/** The emulator's seeded accounts a made-up person's calendar may be, in order (`packages/emulators/src/seed.mjs`). */
export const WORLD_CALENDAR_PERSONAS = ["beta", "gamma", "delta", "epsilon"] as const;
export const MAX_WORLD_EVENTS = 8;
const MAX_TITLE = 80;
/** Where the emulator's sign-in sends its code: never followed, only read off the redirect. */
const REDIRECT = "https://lab-world.invalid/google/callback";

export const worldEvent = v.object({ title: v.string(), start: v.string(), end: v.string() });
export const worldCalendar = v.object({ events: v.array(worldEvent), shared: v.optional(v.boolean()) });
export type WorldCalendar = { events: { title: string; start: string; end: string }[]; shared?: boolean };

/** What a person's calendar asks for, checked: the first thing wrong, or null. */
export function calendarProblem(name: string, calendar: WorldCalendar): string | null {
  if (calendar.events.length > MAX_WORLD_EVENTS) return `${name}'s calendar has at most ${MAX_WORLD_EVENTS} events`;
  for (const event of calendar.events) {
    if (typeof event.title !== "string" || event.title.trim() === "" || event.title.length > MAX_TITLE) return `each of ${name}'s events needs a title of 1 to ${MAX_TITLE} characters`;
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return `each of ${name}'s events needs a start and a later end, as ISO times`;
  }
  return null;
}

/** The made-up people's accounts, by the email `texLabWorld.ts` made them under: user and personal workspace. */
export const worldCalendarTargets = internalQuery({
  args: { emails: v.array(v.string()) },
  returns: v.array(v.union(v.null(), v.object({ userId: v.id("users"), workspaceId: v.id("workspaces") }))),
  handler: async (ctx, args) => {
    const out: ({ userId: Id<"users">; workspaceId: Id<"workspaces"> } | null)[] = [];
    for (const email of args.emails) {
      const user = await ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", email)).unique();
      const workspaceId = user === null ? null : await personalWorkspaceOf(ctx, user._id);
      out.push(user === null || workspaceId === null ? null : { userId: user._id, workspaceId });
    }
    return out;
  },
});

/** The chat's share of one made-up person's calendar, as `shareCalendar` writes one (`lib/textGroupCalendar.ts`). */
export const shareWorldCalendar = internalMutation({
  args: { groupKey: v.string(), userId: v.id("users"), workspaceId: v.id("workspaces"), address: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!isIsolatedPreview()) return null;
    const address = args.address.toLowerCase();
    const rows = await ctx.db.query("chatCalendarShares").withIndex("by_group", (q) => q.eq("groupKey", args.groupKey)).collect();
    const existing = rows.find((row) => row.userId === args.userId && row.address === address);
    if (existing !== undefined) await ctx.db.patch(existing._id, { workspaceId: args.workspaceId, createdAt: Date.now(), endedAt: undefined });
    else await ctx.db.insert("chatCalendarShares", { groupKey: args.groupKey, workspaceId: args.workspaceId, userId: args.userId, address, createdAt: Date.now() });
    return null;
  },
});

/** Signs a persona in on the emulator, as its consent page does, and answers the code it hands back. */
async function emulatorCode(email: string, scope: string): Promise<string> {
  const form = new URLSearchParams({ email, redirect_uri: REDIRECT, scope, state: "lab-world", client_id: googleClientFor("agent")?.clientId ?? "lab-world", nonce: "", code_challenge: "", code_challenge_method: "" });
  const back = await fetch("https://accounts.google.com/o/oauth2/v2/auth/callback", { method: "POST", body: form, redirect: "manual" });
  const code = new URL(back.headers.get("location") ?? REDIRECT).searchParams.get("code");
  if (code === null || code === "") throw new Error(`the emulator's sign-in answered ${back.status}`);
  return code;
}

/**
 * Gives each made-up person who asked for one a calendar (see the header). `people` are in the chat's order; only
 * those with `calendar` are wired. Answers each one's address, or why it could not be.
 */
export const wireWorldCalendars = internalAction({
  args: { groupKey: v.string(), people: v.array(v.object({ email: v.string(), calendar: worldCalendar })) },
  returns: v.array(v.object({ address: v.optional(v.string()), error: v.optional(v.string()) })),
  handler: async (ctx, args): Promise<{ address?: string; error?: string }[]> => {
    if (!isIsolatedPreview() || emulatorsOrigin() === null) return args.people.map(() => ({ error: "calendars for made-up people run only on a pull request's preview" }));
    const targets = await ctx.runQuery(internal.functions.texLabWorldCalendar.worldCalendarTargets, { emails: args.people.map((p) => p.email) });
    const keyset = requireKeyset();
    const scope = [...IDENTITY_SCOPES, CALENDAR_OWNED_READ_SCOPE, CALENDAR_OWNED_SCOPE].join(" ");
    const out: { address?: string; error?: string }[] = [];
    for (const [i, person] of args.people.entries()) {
      const target = targets[i];
      const persona = WORLD_CALENDAR_PERSONAS[i];
      if (target === null || persona === undefined) {
        out.push({ error: target === null ? "no account for this person" : `at most ${WORLD_CALENDAR_PERSONAS.length} calendars a chat` });
        continue;
      }
      try {
        const client = googleClientFor("standard") ?? { clientId: "lab-world" };
        const tokens = await exchangeGoogleCode({ ...client, code: await emulatorCode(`${persona}@supa.media`, scope), verifier: "", redirectUri: REDIRECT });
        const context = { workspaceId: target.workspaceId as string };
        const sealed = {
          scopes: tokens.scopes,
          encryptedRefreshToken: await encryptSecret(tokens.refreshToken, keyset, context),
          encryptedAccessToken: await encryptSecret(tokens.accessToken, keyset, context),
          accessTokenExpiresAt: tokens.expiresAt,
        };
        // As a connect leaves it: Calendar on the row, and the same grant as the AI side's, which Tex reads through.
        const connectionId = await ctx.runMutation(internal.functions.calendarConnect.applyCalendarConnectionBinding, { workspaceId: target.workspaceId, boundBy: target.userId, address: tokens.address, googleAccountId: tokens.googleAccountId, ...sealed });
        await ctx.runMutation(internal.functions.googleClients.applyAgentGrant, { connectionId, workspaceId: target.workspaceId, googleAccountId: tokens.googleAccountId, ...sealed });
        for (const event of person.calendar.events) {
          const made = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
            method: "POST",
            headers: { authorization: `Bearer ${tokens.accessToken}`, "content-type": "application/json" },
            body: JSON.stringify({ summary: event.title.trim(), start: { dateTime: new Date(event.start).toISOString() }, end: { dateTime: new Date(event.end).toISOString() } }),
          });
          if (!made.ok) throw new Error(`the emulator's calendar answered ${made.status}`);
        }
        if (person.calendar.shared !== false) await ctx.runMutation(internal.functions.texLabWorldCalendar.shareWorldCalendar, { groupKey: args.groupKey, userId: target.userId, workspaceId: target.workspaceId, address: tokens.address });
        out.push({ address: tokens.address.toLowerCase() });
      } catch (error) {
        out.push({ error: String((error as Error)?.message ?? "the calendar could not be made").slice(0, 200) });
      }
    }
    return out;
  },
});
