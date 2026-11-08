/**
 * MAIL TO A GROUP CHAT'S OWN ADDRESS (decided by the owner, 2026-11-08: "give groups emails too ...
 * group-three-words-id@context.lc so people could potentially forward things to that email that way people can add
 * their groups to mailing lists and give their groupchats more context";
 * `docs/decisions/identity-and-access/ingestion.md`, "A group chat's address").
 *
 * `group-<words>@context.lc` resolves to the chat whose home is named `<words>` (`textGroups.homeWords`), and its
 * mail is filed in that home, `tex/groups/<words>/email/`, in the pinned workspace. That folder is sealed to the
 * chat's people (`lib/nodes/sealedChats.ts`), so what lands there is read by the people in the chat and by nobody
 * else, the people who run the pinned workspace included. That is what answers the three reasons a shared context has
 * no address (`ingestion.md`): the readers are exactly the chat, the chat's people are who it is for, and the note
 * says, as every capture does, that its sender was not verified.
 *
 * What stays the same as a person's address, by being the same route:
 *
 *  - **Nothing in the request names a workspace.** The Worker sends the local part; the chat, the pin and the folder
 *    are read here, and the ticket is bound to them.
 *  - **The ticket opens only the chat's mail folder.** It records `tex/groups/<words>/email/`, and the id-layer routes
 *    (`lib/noteIds/ingestHttp.ts`) accept only paths under it, so a capture can write its own mail and nothing else
 *    in the home, never `about.md` or a routine.
 *  - **Every no is the same `null`** as an unknown username: no such chat, a chat with no home, no pin, the pin's
 *    storage unbound, over the cap.
 *
 * Who may send: anyone. Mailing lists send from many addresses and forwards keep the original sender, so an allow-list
 * would break what the address is for; the owner chose open with a cap (2026-11-08). A daily cap per chat bounds a
 * flood, counted only for a chat that resolved, so invented names write no rows.
 */

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { GROUP_MAIL_FOLDER, groupMailLocalPart } from "./groupMailAddress";
import { DEFAULT_ATTACHMENT_POLICY, DEFAULT_MAX_ATTACHMENT_BYTES } from "./ingestion";
import { logIngest } from "./ingestLog";
import { liveNodeAt } from "./nodes/paths";
import { tryConsumeRateLimit } from "./rateLimit";
import { chatHomePath, sealedPin } from "./textGroupHome";

/** Most mail one chat's address takes a day. */
export const GROUP_MAIL_DAILY_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What a group's address resolves to, for `resolveForIngestion` to mint its ticket with. */
export type GroupMailTarget = {
  workspaceId: Id<"workspaces">;
  chatId: Id<"textGroups">;
  /** The home, as the Worker files into it: `<home>/email/<hash>.md`. */
  homeFolder: string;
  /** What the ticket opens: the mail folder alone. */
  ticketFolder: string;
  localPart: string;
};

/** The chat whose home is named `words`, its home standing in the pin whose storage is bound, or null. */
export async function resolveGroupMail(ctx: MutationCtx, words: string): Promise<GroupMailTarget | null> {
  const localPart = groupMailLocalPart(words);
  const refuse = (reason: string) => {
    logIngest({ event: "resolve_refused", reason: `group_${reason}`, name: localPart });
    return null;
  };
  const chats = await ctx.db
    .query("textGroups")
    .withIndex("by_home_words", (q) => q.eq("homeWords", words))
    .take(2);
  // Two chats claiming one home is a fault, and mail for it goes to neither.
  if (chats.length !== 1) return refuse(chats.length === 0 ? "no_chat" : "two_chats");
  const chat = chats[0]!;
  if ((chat.homeUsers ?? []).length === 0) return refuse("no_people");
  const pinned = await sealedPin(ctx);
  if (pinned === null) return refuse("no_pin");
  const homeFolder = chatHomePath(words);
  const home = await liveNodeAt(ctx.db, pinned, homeFolder);
  if (home === null || home.kind !== "folder") return refuse("no_home");
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", pinned))
    .unique();
  if (binding === null || binding.status !== "connected") return refuse("storage_unbound");
  const room = await tryConsumeRateLimit(ctx, { key: `ingest.group:${words}`, limit: GROUP_MAIL_DAILY_LIMIT, windowMs: DAY_MS });
  if (!room) return refuse("rate_limited");
  return {
    workspaceId: pinned,
    chatId: chat._id,
    homeFolder: `${homeFolder}/`,
    ticketFolder: `${homeFolder}/${GROUP_MAIL_FOLDER}/`,
    localPart,
  };
}

/** The policy a group's address is answered with: any sender, the defaults for attachments. */
export function groupMailPolicy() {
  return {
    attachmentPolicy: DEFAULT_ATTACHMENT_POLICY,
    maxAttachmentBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
    policy: { allowedSenders: [] as string[], allowedDomains: [] as string[], allowAnySender: true },
  };
}
