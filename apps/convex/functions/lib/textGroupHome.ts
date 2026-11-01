/**
 * A group chat's home: `tex/groups/<words>/` in the pinned workspace, sealed so that only the people in the chat open
 * it (decided by the owner, 2026-10-31; `docs/decisions/texting-assistant/chat-homes.md`, `lib/nodes/sealedChats.ts`).
 *
 * Made on the chat's first turn that opens a session, named with three words, and from then on its row names the
 * chat's people with an account, each to edit, so they find it under Shared with me. Who is named follows who is in
 * the chat on each such turn: somebody who leaves stops seeing it, somebody added starts. Phone numbers are never
 * kept here; account ids only.
 *
 * The chat's own turn reaches the home through the row's token, held beside the pin reader's names on the pin's
 * setup row (`lib/controlPlane/liveGrants.ts`), read for the chat the way a guest chat's rows are (`READS_AS_CHAT`,
 * `lib/nodes/chatFolders.ts`): the home is the one thing it may change there, and everything else it holds is read.
 *
 * Only in a pinned workspace that seals the homes: a chat is never filed in an ordinary folder somebody's role opens.
 */

import { CHAT_HOMES_FOLDER } from "@context/shared";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { pinnedContextWorkspace } from "./pinnedContext";
import { liveNodeAt, nodeAt } from "./nodes/paths";
import { chainAt, standFolders } from "./nodes/rowMove";
import { CHAT_HOMES_CLIENT_ID } from "./nodes/sealedChats";
import { setAccessRow } from "./nodes/setAccess";
import { threeWords } from "./threeWords";

/** Names tried before a chat goes on without a home this turn. */
const NAME_TRIES = 12;

/**
 * The pinned workspace, or null. It is found by the name the seal is drawn by (`PINNED_CONTEXT_SLUG`,
 * `sealsChatHomes`), so a home is never made anywhere the homes aren't sealed.
 */
async function sealedPin(ctx: QueryCtx): Promise<Id<"workspaces"> | null> {
  return (await pinnedContextWorkspace(ctx))?._id ?? null;
}

/** The chat's home folder. */
export function chatHomePath(words: string): string {
  return `${CHAT_HOMES_FOLDER}/${words}`;
}

/** Account ids as one comparable list: sorted, once each. */
function peopleList(userIds: readonly Id<"users">[]): Id<"users">[] {
  return [...new Set(userIds)].sort();
}

/** Why a home was not made, as a fixed code a public log may carry. */
export type HomeRefusal = "no_pin" | "no_name" | `row_${string}`;

/**
 * The chat's home made, and its row naming exactly `people`, each to edit. `actor` is who tagged Tex: the audit
 * trail names them, and in the pinned workspace a row about a home is its actor's alone (`audit.ts`). Answers the
 * home's folder, or why there is none: no sealed pin, no free name, or the row refused (`row_<code>`).
 */
export async function makeChatHome(
  ctx: MutationCtx,
  chat: Doc<"textGroups">,
  people: readonly Id<"users">[],
  actor: Id<"users">,
): Promise<{ folder: string } | { refused: HomeRefusal }> {
  const pinned = await sealedPin(ctx);
  if (pinned === null) return { refused: "no_pin" };
  const now = Date.now();
  let words = chat.homeWords;
  if (words === undefined) {
    for (let attempt = 0; attempt < NAME_TRIES && words === undefined; attempt += 1) {
      const tried = threeWords();
      if ((await nodeAt(ctx.db, pinned, chatHomePath(tried))) === null) words = tried;
    }
    if (words === undefined) return { refused: "no_name" };
  }
  const folder = chatHomePath(words);
  const wanted = peopleList(people);
  const kept = chat.homeWords === words && sameList(chat.homeUsers ?? [], wanted);
  // A home standing and naming the same people is left as it is: no write on an ordinary turn.
  if (kept && (await liveNodeAt(ctx.db, pinned, folder))?.kind === "folder") return { folder };
  // `chainAt` of a path inside the home stands every folder down to the home itself.
  await standFolders(ctx, pinned, await chainAt(ctx.db, pinned, `${folder}/-`), now);
  const answer = await setAccessRow(ctx, {
    workspaceId: pinned,
    path: folder,
    base: "private",
    grantees: wanted.map((userId) => ({ kind: "user" as const, userId, role: "edit" as const })),
    kind: "folder",
    actor: { userId: actor, role: "owner", clientId: CHAT_HOMES_CLIENT_ID },
  });
  if (!answer.ok) return { refused: `row_${answer.code}` };
  await ctx.db.patch(chat._id, { homeWords: words, homeUsers: wanted });
  return { folder };
}

/**
 * `makeChatHome`, answering the folder or null, as a turn needs it. A home that could not be made is said in the log,
 * by its code alone, so a chat answered without one is never silent again (2026-11-01: three chats had none).
 */
export async function ensureChatHome(
  ctx: MutationCtx,
  chat: Doc<"textGroups">,
  people: readonly Id<"users">[],
  actor: Id<"users">,
): Promise<string | null> {
  const answer = await makeChatHome(ctx, chat, people, actor);
  if ("folder" in answer) return answer.folder;
  // A deployment with no pinned workspace has no homes at all (self-hosting): that is how it runs, not a failure.
  if (answer.refused !== "no_pin") console.log(JSON.stringify({ event: "chat_home_not_made", reason: answer.refused }));
  return null;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * A chat's home, as its own turn reaches it: the folder and the token of the row there, or null when the chat has
 * none, the pin doesn't seal the homes, or the row isn't a live folder.
 */
export async function chatHomeOf(
  ctx: QueryCtx,
  groupId: Id<"textGroups">,
): Promise<{ workspaceId: Id<"workspaces">; folder: string; noteId: string } | null> {
  const chat = await ctx.db.get(groupId);
  if (chat === null || chat.homeWords === undefined) return null;
  const pinned = await sealedPin(ctx);
  if (pinned === null) return null;
  const folder = chatHomePath(chat.homeWords);
  const row = await liveNodeAt(ctx.db, pinned, folder);
  if (row === null || row.kind !== "folder" || row.noteId === undefined) return null;
  return { workspaceId: pinned, folder, noteId: row.noteId };
}
