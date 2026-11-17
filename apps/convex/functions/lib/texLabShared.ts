/**
 * The Lab's "Shared with developers" chats (Dev2, 2026-11-16: "an easy, reliable way for someone to share their chat
 * history and future chats with developers ... go to the Lab and see a new category, shared with developers, click
 * through histories, replay things and debug issues"; decision `docs/decisions/texting-assistant/lab-shared-chats.md`).
 *
 * Built on the one yes that already exists, never a second switch: Settings → Feedback "Share finished Tex
 * conversations", or texting Tex "share my chats with the devs" (`texReviews.ts` `texReviewSharing`). A row is the yes;
 * turning it off deletes it, and the chat leaves this list on the next read, past and future texts alike.
 *
 *  - A person's 1:1 is listed while they say yes.
 *  - A group chat is listed only when everybody in it has said yes or is on the team, and at least one said yes: the
 *    rule self-review already keeps a group's words by (`texReviews.ts` `reviewSetup`). One person who has not said yes
 *    keeps the whole chat out.
 *  - The caller's own chats are not here: they are under "Your account".
 *
 * What a developer gets is the chat's history file, read only (`apps/mcp/src/labSandbox/shared.js`). No test text runs
 * on a shared chat, since a turn would read the person's notes afresh, which their yes never covered.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { onTheTeam, sharesReviews } from "../texReviews";
import { handleFor } from "../texPage";
import { personalWorkspaceOf } from "../textLinks";
import { pinnedContextWorkspace } from "./pinnedContext";

/** Yeses read at once, and group chats scanned (no index on `homeUsers`, as the Tex page scans them). */
const MAX_SHARERS = 500;
const CHAT_SCAN = 2000;
export const MAX_SHARED_CHATS = 200;

/** A 1:1's key in the Lab: `u:` and the person's id, never confused with a group's 64-hex key or "me". */
export const SHARED_ONE = /^u:[a-z0-9]{1,64}$/;

export type SharedChat = {
  /** `u:<userId>` for a 1:1, the group's key for a group chat. */
  key: string;
  kind: "1:1" | "group";
  name: string;
  /** Who said yes, by handle: the 1:1's person, or a group's people who did. */
  sharedBy: string[];
  sharedAt: number;
  people: number;
  /** Where the chat's history file lives (`agent/ledger.js` `ledgerFor`). */
  owner: { person: string } | { chat: string };
  lastAt: number | null;
};

/** Every chat shared with the developers, newest yes or activity first, the caller's own left out. */
export async function sharedChats(ctx: QueryCtx, callerId: Id<"users">): Promise<SharedChat[]> {
  const yeses = await ctx.db.query("texReviewSharing").take(MAX_SHARERS);
  const yesAt = new Map<Id<"users">, number>();
  for (const row of yeses) yesAt.set(row.userId, Math.min(yesAt.get(row.userId) ?? Infinity, row.sharedAt));
  if (yesAt.size === 0) return [];
  const pinned = (await pinnedContextWorkspace(ctx))?._id ?? null;
  const handles = new Map<Id<"users">, Promise<string>>();
  const handle = (id: Id<"users">) => {
    let h = handles.get(id);
    if (h === undefined) handles.set(id, (h = handleFor(ctx, id)));
    return h;
  };

  const out: SharedChat[] = [];
  for (const [userId, sharedAt] of yesAt) {
    if (userId === callerId) continue;
    const workspaceId = await personalWorkspaceOf(ctx, userId);
    if (workspaceId === null) continue;
    const name = (await handle(userId)) || "Someone";
    out.push({ key: `u:${userId}`, kind: "1:1", name: `@${name}`, sharedBy: [name], sharedAt, people: 1, owner: { person: workspaceId }, lastAt: null });
  }

  const allowed = new Map<Id<"users">, boolean>();
  const counts = async (id: Id<"users">) => {
    let ok = allowed.get(id);
    if (ok === undefined) allowed.set(id, (ok = yesAt.has(id) || (await onTheTeam(ctx, pinned, id))));
    return ok;
  };
  for (const group of await ctx.db.query("textGroups").take(CHAT_SCAN)) {
    const people = [...new Set(group.homeUsers ?? [])];
    if (people.length === 0 || people.includes(callerId)) continue;
    const said = people.filter((id) => yesAt.has(id));
    if (said.length === 0) continue;
    let everyone = true;
    for (const id of people) if (!(await counts(id))) everyone = false;
    if (!everyone) continue;
    const names = await Promise.all(people.map(async (id) => (await handle(id)) || "someone"));
    out.push({
      key: group.groupKey,
      kind: "group",
      name: group.chatName ?? names.map((n) => "@" + n).slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : ""),
      sharedBy: await Promise.all(said.map(async (id) => (await handle(id)) || "someone")),
      sharedAt: Math.max(...said.map((id) => yesAt.get(id) ?? 0)),
      people: people.length,
      owner: { chat: group.groupKey },
      lastAt: group.lastSeenAt ?? null,
    });
  }
  return out.sort((a, b) => Math.max(b.lastAt ?? 0, b.sharedAt) - Math.max(a.lastAt ?? 0, a.sharedAt)).slice(0, MAX_SHARED_CHATS);
}

/**
 * Whether one group chat is in the Lab's "Shared with developers" list, by the same rule as `sharedChats`, for its own
 * turn to be told (Dev2, 2026-11-17: Tex told a chat "Dev2 can't see this chat" while it was shared, because no turn
 * was told). `by` are the people here who said yes; `waiting` are the people here with an account who have neither
 * said yes nor are on the team, so one of them keeps it out. People with no account are not in `homeUsers` and are
 * never counted, as `sharedChats` never counts them. Handles only, never ids or numbers.
 */
export type DevShare = { shared: boolean; by: string[]; waiting: string[] };

export async function devShareOf(ctx: QueryCtx, group: Pick<Doc<"textGroups">, "homeUsers">): Promise<{ devShare: DevShare }> {
  const people = [...new Set(group.homeUsers ?? [])].slice(0, 64);
  const pinned = people.length === 0 ? null : (await pinnedContextWorkspace(ctx))?._id ?? null;
  const by: string[] = [];
  const waiting: string[] = [];
  // Asked side by side: this runs on every group turn's answer.
  const answers = await Promise.all(
    people.map(async (id) => {
      const [said, handle] = await Promise.all([sharesReviews(ctx, id), handleFor(ctx, id)]);
      return { said, name: handle || "someone", team: said ? false : await onTheTeam(ctx, pinned, id) };
    }),
  );
  for (const { said, name, team } of answers) {
    if (said) by.push(name);
    else if (!team) waiting.push(name);
  }
  return { devShare: { shared: by.length > 0 && waiting.length === 0, by, waiting } };
}
