/**
 * What Tex's agent may change about a chat, called as a tool with the turn's
 * own grant (Jhonatan, 2026-10-31; `docs/decisions/texting-assistant/command-tools.md`).
 *
 * The chat and the person acting come off the live grant (`resolveLiveGrant`),
 * never from anything the agent names: a group grant names its chat
 * (`texGroup.groupId`) and its tagger; a person's own texting grant names
 * them. The rules are the ones the texting Worker's commands use
 * (`lib/texChatRules.ts`, `lib/textGroupMail.ts`, `texReviews.ts`), so a tool
 * can do exactly what the same person could by text, and nothing more.
 *
 * Who may do what:
 *  - anyone in the chat: mute Tex, read the settings, change the chat's style
 *    and when Tex speaks up;
 *  - a guest (no account) or an invited person tagging through someone else:
 *    only those. Their grant stands on another person's account, so nothing
 *    that acts as a person (mail, their own review sharing) is theirs;
 *  - the mailbox's own person: share or stop sharing their mail here, by the
 *    same check as "Tex, share my mail" (a chat bound to a shared workspace
 *    they can edit);
 *  - in a person's own chat: their own settings and review sharing.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { resolveLiveGrant } from "./lib/controlPlane/liveGrants";
import { mergeTexStyle, readTexStyle, texStyleValidator, type TexStyle } from "./lib/texStyle";
import { muteChat, setChatEngagement, setChatStyle, setPersonStyle, type Engagement } from "./lib/texChatRules";
import { cleanAddress, cleanShareQuery, shareMail, unshareMail } from "./lib/textGroupMail";
import { TEXTS_CLIENT_ID } from "./textLinks";
import { TEXTS_GROUP_CLIENT_ID, ENGAGEMENT_STYLES, handleOf } from "./textGroups";
import { setSharing } from "./texReviews";

export const TEX_COMMANDS = ["mute", "status", "settings", "style", "engagement", "share_mail", "unshare_mail", "review_sharing"] as const;
export type TexCommandKind = (typeof TEX_COMMANDS)[number];

/** Commands a guest or an invited tagger may use: none acts as a person. */
export const GUEST_COMMANDS: ReadonlySet<TexCommandKind> = new Set(["mute", "status", "settings", "style", "engagement"]);
/** Commands a person's own chat has: there is no chat to mute or share into. */
export const OWN_CHAT_COMMANDS: ReadonlySet<TexCommandKind> = new Set(["settings", "style", "review_sharing"]);

const commandValidator = v.object({
  kind: v.string(),
  style: v.optional(v.any()),
  engagement: v.optional(v.string()),
  address: v.optional(v.string()),
  query: v.optional(v.string()),
  share: v.optional(v.boolean()),
});

const answerValidator = v.object({
  status: v.union(
    v.literal("done"),
    v.literal("refused"),
    v.literal("not_allowed"),
    v.literal("bad_request"),
    v.literal("mail_refused"),
  ),
  /** What happened, as data for the tool to word: never another person's number. */
  muted: v.optional(v.boolean()),
  slug: v.optional(v.string()),
  guest: v.optional(v.boolean()),
  style: v.optional(texStyleValidator),
  engagement: v.optional(v.string()),
  engagementChosen: v.optional(v.boolean()),
  address: v.optional(v.string()),
  narrowed: v.optional(v.boolean()),
  count: v.optional(v.number()),
  sharing: v.optional(v.boolean()),
  changed: v.optional(v.boolean()),
});
type Answer = typeof answerValidator.type;

/** Who a grant speaks for, and in which chat. `person` is null when the grant stands on someone else's account. */
type Actor =
  | { kind: "group"; group: Doc<"textGroups">; person: Id<"users"> | null; slug: string; setBy: string }
  | { kind: "own"; person: Id<"users"> };

async function actorOf(ctx: MutationCtx, hashedAccessToken: string): Promise<Actor | null> {
  const live = await resolveLiveGrant(ctx, hashedAccessToken);
  if (live === null) return null;
  const { grant, workspace } = live;
  if (grant.clientId === TEXTS_CLIENT_ID && grant.texGroup === undefined) return { kind: "own", person: grant.userId };
  if (grant.clientId !== TEXTS_GROUP_CLIENT_ID || grant.texGroup === undefined) return null;
  const group = await ctx.db.get(grant.texGroup.groupId);
  if (group === null) return null;
  // A guest's tag, or an invited person's, is minted on the person who opened the chat: never act as them.
  const standsOnSomeoneElse = grant.texGroup.guestTagger === true || grant.texGroup.invitedTaggerRole !== undefined;
  const person = standsOnSomeoneElse ? null : grant.userId;
  const setBy = person === null ? "a guest" : (await handleOf(ctx, person)) || "someone here";
  return { kind: "group", group, person, slug: workspace.slug, setBy };
}

function styleOf(group: Doc<"textGroups">): TexStyle {
  return mergeTexStyle(group.texStyle, {});
}

export const applyTexCommand = internalMutation({
  args: { hashedAccessToken: v.string(), command: commandValidator },
  returns: answerValidator,
  handler: async (ctx, args): Promise<Answer> => {
    const kind = (TEX_COMMANDS as readonly string[]).includes(args.command.kind) ? (args.command.kind as TexCommandKind) : null;
    if (kind === null) return { status: "bad_request" };
    const actor = await actorOf(ctx, args.hashedAccessToken);
    if (actor === null) return { status: "refused" };

    if (actor.kind === "own") {
      if (!OWN_CHAT_COMMANDS.has(kind)) return { status: "not_allowed" };
      if (kind === "review_sharing") {
        if (args.command.share === undefined) return { status: "bad_request" };
        return { status: "done", sharing: args.command.share, changed: await setSharing(ctx, actor.person, args.command.share) };
      }
      const row = await ctx.db
        .query("texStylePreferences")
        .withIndex("by_user", (q) => q.eq("userId", actor.person))
        .unique();
      if (kind === "settings") return { status: "done", style: row?.texStyle ?? {} };
      const patch = readTexStyle(args.command.style);
      if (patch === null) return { status: "bad_request" };
      return { status: "done", style: await setPersonStyle(ctx, actor.person, patch) };
    }

    const { group, person, slug, setBy } = actor;
    if (person === null && !GUEST_COMMANDS.has(kind)) return { status: "not_allowed" };
    const now = Date.now();
    switch (kind) {
      case "mute":
        await muteChat(ctx, group, person, now);
        return { status: "done", muted: true };
      case "status":
        return { status: "done", slug, guest: group.guestGroupId !== undefined };
      case "settings":
        return { status: "done", style: styleOf(group), ...(group.engagement !== undefined ? { engagement: group.engagement } : {}), engagementChosen: group.engagement !== undefined };
      case "style": {
        const patch = readTexStyle(args.command.style);
        if (patch === null) return { status: "bad_request" };
        return { status: "done", style: await setChatStyle(ctx, group, patch, setBy) };
      }
      case "engagement": {
        const style = args.command.engagement;
        if (style === undefined || !(ENGAGEMENT_STYLES as readonly string[]).includes(style)) return { status: "bad_request" };
        await setChatEngagement(ctx, group, style as Engagement, setBy);
        return { status: "done", engagement: style };
      }
      case "share_mail": {
        const address = cleanAddress(args.command.address ?? "");
        const query = cleanShareQuery(args.command.query);
        const shared = person === null || address === null || query === null ? null : await shareMail(ctx, group, person, address, query, now);
        return shared === null ? { status: "mail_refused" } : { status: "done", ...shared };
      }
      case "unshare_mail": {
        const address = args.command.address === undefined ? undefined : (cleanAddress(args.command.address) ?? "");
        return { status: "done", count: person === null ? 0 : await unshareMail(ctx, group, person, address) };
      }
      case "review_sharing":
        // A person's review sharing is theirs to set in their own chat, never from a group.
        return { status: "not_allowed" };
    }
  },
});
