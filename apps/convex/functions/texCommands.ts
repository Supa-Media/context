/**
 * What Tex's agent may change about a chat, called as a tool with the turn's
 * own grant (Dev2, 2026-10-31; `docs/decisions/texting-assistant/command-tools.md`).
 *
 * The chat and the person acting come off the live grant (`resolveLiveGrant`),
 * never from anything the agent names: a group grant names its chat
 * (`texGroup.groupId`) and its tagger; a person's own texting grant names
 * them. The rules are the ones the texting Worker's commands use
 * (`lib/texChatRules.ts`, `lib/textGroupMail.ts`, `texReviews.ts`), so a tool
 * can do exactly what the same person could by text, and nothing more.
 *
 * Who may do what:
 *  - anyone in the chat: mute Tex, read the settings, change the chat's
 *    instructions, progress updates and when Tex speaks up;
 *  - a guest (no account, in a home-only chat) or an invited person tagging through someone else:
 *    only those. Their grant stands on another person's account, so nothing
 *    that acts as a person (mail, their own review sharing) is theirs;
 *  - the mailbox's own person: share or stop sharing their mail here, by the
 *    same check as "Tex, share my mail" (a chat bound to a shared workspace
 *    they can edit);
 *  - in a person's own chat: their own instructions, progress updates and
 *    review sharing. Their instructions never reach a group, nor a group's them.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { type MutationCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { resolveLiveGrant } from "./lib/controlPlane/liveGrants";
import { MAX_INSTRUCTIONS, TEX_UPDATES, texUpdatesValidator, type InstructionsChange, type TexUpdates } from "./lib/texInstructions";
import { muteChat, personRow, setChatSettings, setPersonSettings, setSpeaksUp, settingsOf, speaksUpOf, type Settings, type SettingsRefusal } from "./lib/texChatRules";
import { cleanAddress, cleanShareQuery, mailSharesNamed, shareMail, unshareMail } from "./lib/textGroupMail";
import { TEXTS_CLIENT_ID } from "./textLinks";
import { TEXTS_GROUP_CLIENT_ID, ENGAGEMENT_STYLES, type Engagement } from "./textGroups";
import { handleOf } from "./lib/textGroupAccounts";
import { setSharing, sharesReviews } from "./texReviews";

export const TEX_COMMANDS = ["mute", "status", "settings", "instructions", "updates", "engagement", "share_mail", "unshare_mail", "review_sharing"] as const;
export type TexCommandKind = (typeof TEX_COMMANDS)[number];

/** Commands a guest or an invited tagger may use: none acts as a person. */
export const GUEST_COMMANDS: ReadonlySet<TexCommandKind> = new Set(["mute", "status", "settings", "instructions", "updates", "engagement"]);
/** Commands a person's own chat has: there is no chat to mute or share into. */
export const OWN_CHAT_COMMANDS: ReadonlySet<TexCommandKind> = new Set(["settings", "instructions", "updates", "review_sharing"]);

const commandValidator = v.object({
  kind: v.string(),
  /** `instructions`: one of `add` (a line), `remove` (a line), `replace` (the whole text), or `clear`. */
  action: v.optional(v.string()),
  text: v.optional(v.string()),
  updates: v.optional(v.string()),
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
    v.literal("too_long"),
    v.literal("nothing_to_undo"),
  ),
  /** What happened, as data for the tool to word: never another person's number. */
  muted: v.optional(v.boolean()),
  slug: v.optional(v.string()),
  guest: v.optional(v.boolean()),
  instructions: v.optional(v.string()),
  updates: v.optional(texUpdatesValidator),
  setBy: v.optional(v.string()),
  engagement: v.optional(v.string()),
  engagementChosen: v.optional(v.boolean()),
  address: v.optional(v.string()),
  narrowed: v.optional(v.boolean()),
  count: v.optional(v.number()),
  sharing: v.optional(v.boolean()),
  changed: v.optional(v.boolean()),
  /** A group chat's settings: whose mail is shared there. */
  mail: v.optional(v.array(v.object({ handle: v.string(), address: v.string() }))),
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
  // A home-only grant (`lib/textGroupHomeOnly.ts`) is held for the chat's sponsor: it acts for the account that tagged
  // Tex (`taggerId`), and for nobody when a guest without an account did. An invited person's tag stands on the
  // binder's account, so it acts for nobody either. Guest mode is retired (2026-10-31); a grant left from it is a guest's.
  const texGroup = grant.texGroup;
  const person = texGroup.homeOnly === true ? (texGroup.taggerId ?? null) : texGroup.guestTagger === true || texGroup.invitedTaggerRole !== undefined ? null : grant.userId;
  const setBy = person === null ? "a guest" : (await handleOf(ctx, person)) || "someone here";
  return { kind: "group", group, person, slug: texGroup.homeOnly === true ? "" : workspace.slug, setBy };
}

/** The tool's change, read against its closed set; null when it names none. */
function changeOf(command: { action?: string; text?: string }): InstructionsChange | null {
  const text = command.text ?? "";
  if (text.length > MAX_INSTRUCTIONS) return null;
  if (command.action === "clear") return { clear: true };
  // "Tex, undo the change", said to the instructions tool since the fixed words were retired (2026-11-11).
  if (command.action === "undo") return { undo: true };
  if (text.trim() === "") return null;
  return command.action === "add" ? { add: text } : command.action === "remove" ? { remove: text } : command.action === "replace" ? { replace: text } : null;
}

/** A settings change's answer: what is saved now, or why nothing was. */
function saved(result: Settings | SettingsRefusal, setBy?: string): Answer {
  if ("refused" in result) return { status: result.refused };
  return { status: "done", ...result, ...(setBy !== undefined ? { setBy } : {}) };
}

const updatesOf = (value: string | undefined): TexUpdates | null => ((TEX_UPDATES as readonly string[]).includes(value ?? "") ? (value as TexUpdates) : null);

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
      if (kind === "settings") return { status: "done", ...settingsOf((await personRow(ctx, actor.person)) ?? {}), sharing: await sharesReviews(ctx, actor.person) };
      if (kind === "updates") {
        const updates = updatesOf(args.command.updates);
        return updates === null ? { status: "bad_request" } : saved(await setPersonSettings(ctx, actor.person, { updates }));
      }
      const change = changeOf(args.command);
      return change === null ? { status: "bad_request" } : saved(await setPersonSettings(ctx, actor.person, { change }));
    }

    const { group, person, slug, setBy } = actor;
    if (person === null && !GUEST_COMMANDS.has(kind)) return { status: "not_allowed" };
    const now = Date.now();
    switch (kind) {
      case "mute":
        await muteChat(ctx, group, setBy);
        return { status: "done", muted: true };
      case "status":
        // A home-only chat (someone here has no account) reads only its own home: no workspace to name.
        return { status: "done", slug, guest: slug === "" };
      case "settings": {
        const level = speaksUpOf(group);
        // Whose mail is shared here, as the chat's own prompt already says it (`mailSharesNamed`), for "how are you set up here".
        const { mail } = await mailSharesNamed(ctx, group._id);
        return { status: "done", ...settingsOf(group), ...(level !== undefined ? { engagement: level } : {}), engagementChosen: level !== undefined, slug, ...(mail ? { mail } : {}) };
      }
      case "instructions": {
        const change = changeOf(args.command);
        return change === null ? { status: "bad_request" } : saved(await setChatSettings(ctx, group, { change }, setBy), setBy);
      }
      case "updates": {
        const updates = updatesOf(args.command.updates);
        return updates === null ? { status: "bad_request" } : saved(await setChatSettings(ctx, group, { updates }, setBy), setBy);
      }
      case "engagement": {
        const style = args.command.engagement;
        if (style === undefined || !(ENGAGEMENT_STYLES as readonly string[]).includes(style)) return { status: "bad_request" };
        await setSpeaksUp(ctx, group, style as Engagement, setBy);
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
