/**
 * A simulated group chat (the texts simulator's group mode, `simulatorGroup.ts`): its id, its members, and the group
 * line that stands in for a real app's line. A simulated group is answered into its own log, never sent anywhere.
 *
 * Why a simulated group cannot be mistaken for a real one:
 * - Its id always starts with `sim-group-` (minted as that and 32 hex digits), and `groupLineFor` routes every id with
 *   that prefix here, before any app's line. A prefix that is not a valid simulated id is refused here too, so it can
 *   never reach Sendblue, WhatsApp or Photon.
 * - Every member is a 555-01XX number (`SIMULATED_PHONE`), and the line is the fixed fictional `SIM_GROUP_LINE`.
 */

import type { GroupLine } from "./groupLine";
import type { InboxStorage } from "./inbox";
import { record, SIMULATED_PHONE, type SimEntry } from "./simulatorLog";

export const SIM_GROUP_PREFIX = "sim-group-";
export const SIM_GROUP_ID = /^sim-group-[0-9a-f]{32}$/;
/** Tex's line in a simulated group: fictional, a 555-01XX number, never a real line's. */
export const SIM_GROUP_LINE = "+15555550100";
export const SIM_GROUP_MIN_MEMBERS = 2;
export const SIM_GROUP_MAX_MEMBERS = 8;
/** Where a simulated group's members are kept, in its object. */
export const SIM_MEMBERS_KEY = "sim:members";

/** Any id under the simulator's prefix is a simulated group's, valid or not: no real app's line is ever given one. */
export function isSimulatedGroup(groupId: string): boolean {
  return groupId.startsWith(SIM_GROUP_PREFIX);
}

export function mintSimGroupId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return SIM_GROUP_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 2 to 8 distinct 555-01XX numbers, the sender among them. */
export function simMembersOk(phone: string, members: unknown): members is string[] {
  if (!Array.isArray(members) || members.length < SIM_GROUP_MIN_MEMBERS || members.length > SIM_GROUP_MAX_MEMBERS) return false;
  if (!members.every((member) => typeof member === "string" && SIMULATED_PHONE.test(member))) return false;
  return new Set(members).size === members.length && members.includes(phone);
}

/**
 * The group line for a simulated group, writing its replies to the group object's log (`storage`). With no storage
 * (a path that has none to give) every send refuses: a simulated reply is never sent on a real line instead.
 */
export function simulatedGroupLine(storage: InboxStorage | undefined): GroupLine {
  if (storage === undefined) {
    const refuse = (): never => {
      throw new Error("simulated group has no log to write to");
    };
    return {
      sendText: refuse,
      sendMedia: refuse,
      react: async () => {},
      readMembers: async () => null,
      readOwnMessage: async () => null,
    };
  }
  const say = (text: string, extra: Partial<Pick<SimEntry, "from" | "handle">> = {}) => record(storage, "in", text, Date.now(), extra);
  return {
    sendText: async (_place, text) => {
      const handle = `simh_${crypto.randomUUID()}`;
      await say(text, { handle });
      return handle;
    },
    sendMedia: async (_place, url) => {
      await say(`[picture ${url}]`);
    },
    // Never throws (`GroupLine`): a tapback that cannot be logged is only a missing line in the log.
    react: async (_place, _messageId, emoji) => {
      await say(`Tex reacted ${emoji}`).catch(() => {});
    },
    readMembers: async () => (await storage.get<string[]>(SIM_MEMBERS_KEY)) ?? null,
    readOwnMessage: async (_place, messageId) => {
      for (const entry of (await storage.list<SimEntry>({ prefix: "sim:log:" })).values()) {
        if (entry.handle === messageId && entry.dir === "in") return entry.text;
      }
      return null;
    },
  };
}
