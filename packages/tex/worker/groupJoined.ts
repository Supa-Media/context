/**
 * TEX SAYS HELLO WHEN IT IS ADDED TO A GROUP (Dev2, 2026-11-25: "Tex should have an intro when added to a group").
 * The one deliberate exception to "Tex never texts first": once per group, the moment Tex is in it.
 *
 * Node `joined` (an input, `texConfig.json`; on the shelf until a Lab draft wires it). Two things mean Tex is new to a
 * group, and both reach the chat's own object (`chatObject.ts`):
 *  - the line says Tex's own number was added to a group (Photon's `group.changed` `participantAdded` naming Tex's
 *    line, `photonInbound.ts` `photonGroupChange`), by the person who added it;
 *  - a group's first message ever reaches an object that has never kept where it is (`groupRoutines.ts`
 *    `WHERE_KEPT_KEY`): a group just made with Tex in it. Its sender is who brought Tex in.
 *
 * Either queues one turn of the chat's own, as a saved login's turn is (`vaultWatch.ts`): `event: "joined"`, asked by
 * the person who brought Tex in, so the control plane checks them as it checks any routine's writer, and a chat it
 * can't run in says nothing. The gateway's node `joined` gives that turn its fixed line (never anything this Worker
 * sends as words), and the Front door writes the hello. `gintro` marks the chat as introduced, so it is said once.
 *
 * Nothing is queued unless the config (or a Lab draft's, `env.TEX_GRAPH`) has the node, on: until then this is code
 * on the shelf, and no group hears anything new.
 */

import { TEX_CONFIG as bundled } from "../../../packages/tex/src/texConfig.cjs";
import { INTRO_KEY, JOINED_EVENT } from "./groupChat";
import { queueGroupByCode } from "./groupInbox";
import type { InboxStorage } from "./inbox";
import type { GroupMessage } from "./sendblueGroups";

/** The node's id in the config. */
export const JOINED_NODE = "joined";
/** The event the chat's turn names, read by the gateway's node of the same name. */
export { JOINED_EVENT } from "./groupChat";
/** The routine path its turn runs under, as a saved login's does (`vaultWatch.ts` `VAULT_SAVED_PATH`): no note. */
export const JOINED_PATH = "(joined)";
/** Set in the chat's object once its hello is queued: a group is introduced once (kept in `groupChat.ts`, which binds by it). */
export { INTRO_KEY } from "./groupChat";
/** What the turn's own row reads as in the chat's queue; the gateway asks the model its own line, never this. */
export const JOINED_TEXT = "(Tex was added to this chat)";

const E164 = /^\+[1-9]\d{6,14}$/;

/** Whether the config (or a Lab draft's) has node `joined`, on: else Tex says nothing new when added. */
export function joinedWired(graph?: unknown): boolean {
  const config = (graph ?? bundled) as { nodes?: { id?: unknown; on?: unknown }[] };
  return Array.isArray(config.nodes) && config.nodes.some((node) => node?.id === JOINED_NODE && node.on !== false);
}

/** Tex added to a group: where, and who brought it in (their number). */
export type Joined = { groupId: string; line: string; by: string; participants?: string[] };

/** A `Joined`, read strictly (it reaches the object as JSON from the line's event, or from the Lab), or null. */
export function joinedOf(value: unknown): Joined | null {
  const raw = value as Partial<Joined> | null;
  if (raw === null || typeof raw !== "object") return null;
  if (typeof raw.groupId !== "string" || raw.groupId === "" || raw.groupId.length > 200) return null;
  if (typeof raw.line !== "string" || !E164.test(raw.line)) return null;
  if (typeof raw.by !== "string" || !E164.test(raw.by) || raw.by === raw.line) return null;
  const participants = Array.isArray(raw.participants) ? raw.participants.filter((p): p is string => typeof p === "string" && p.length <= 320).slice(0, 64) : undefined;
  return { groupId: raw.groupId, line: raw.line, by: raw.by, ...(participants ? { participants } : {}) };
}

/** The hello's turn, as the chat's queue takes it: from whoever brought Tex in, threaded under nothing. */
export function joinedMessage(joined: Joined, now: number): GroupMessage {
  return {
    kind: "group-message",
    eventId: `joined:${joined.groupId}`,
    groupId: joined.groupId,
    line: joined.line,
    from: joined.by,
    participants: joined.participants ?? [],
    messageId: "",
    text: JOINED_TEXT,
    routine: { runId: `joined:${now}`, path: JOINED_PATH },
    event: JOINED_EVENT,
  };
}

/**
 * Queue the group's hello, once. "off" while the config has no node `joined`; "already" when this chat was introduced
 * (or its hello is queued); otherwise what the queue says. The mark goes in before the queue, so two events for one
 * join (the line's and the first message's) never queue two.
 */
export async function acceptJoined(storage: InboxStorage, joined: Joined, now: number, graph?: unknown): Promise<"off" | "already" | "queued" | "full"> {
  if (!joinedWired(graph)) return log("off"), "off";
  if ((await storage.get<number>(INTRO_KEY)) !== undefined) return log("already"), "already";
  await storage.put(INTRO_KEY, now);
  const outcome = await queueGroupByCode(storage, joinedMessage(joined, now), now);
  log(outcome);
  return outcome;
}

function log(outcome: string): void {
  console.log(JSON.stringify({ event: "group_joined", outcome }));
}
