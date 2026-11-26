/**
 * WHAT CODE DID FOR A CHAT GOES TO TEX AS DATA, AND TEX WRITES THE TEXT (Dev2, 2026-11-25: "Tex's code never writes
 * what Tex says", a hard rule; docs/decisions/texting-assistant/no-scripted-wording.md).
 *
 * When this Worker runs something a person in a group asked for (adding everyone to a workspace, first), it used to
 * text a fixed line ("Done. I invited 1 person here…"), which Tex never wrote and, until #4238, never saw. Now it
 * queues one turn of the chat's own, as a saved login's turn is (`vaultWatch.ts`): `event: "did"`, asked by the same
 * person, with what happened as facts (`Did`). The gateway's node `did` (`packages/tex/gateway/agent/did.js`) hands
 * the facts to the Front door as data, and Tex says what happened in its own words, taught by Training conversations.
 *
 * Nothing changes until the config (or a Lab draft's) has node `did`, on: until then the old line is sent, as before.
 * A turn that can't be queued (the chat's queue is full) is never silent either: the old line goes, logged.
 * The action has already run when the turn is queued, so a retried turn only says it again, never does it again.
 */

import { TEX_CONFIG as bundled } from "../../../packages/tex/src/texConfig.cjs";
import type { GroupDeps } from "./groupInbox";
import { queueGroupByCode } from "./groupInbox";
import { say } from "./groupSay";
import type { InboxStorage } from "./inbox";
import type { GroupMessage } from "./sendblueGroups";
import { didOf, type Did } from "./factsOf";

/** The node's id in the config. */
export const DID_NODE = "did";
/** The event the chat's turn names, read by the gateway's node of the same name. */
export const DID_EVENT = "did";
/** The routine path its turn runs under, as a saved login's does: no note. */
export const DID_PATH = "(did)";
/** What the turn's own row reads as in the chat's queue; the gateway hands the model the facts, never this. */
export const DID_TEXT = "(did)";

export { didOf, type Did } from "./factsOf";

/** Whether the config (or a Lab draft's) has node `did`, on: else the old fixed line is sent. */
export function didWired(graph?: unknown): boolean {
  const config = (graph ?? bundled) as { nodes?: { id?: unknown; on?: unknown }[] };
  return Array.isArray(config.nodes) && config.nodes.some((node) => node?.id === DID_NODE && node.on !== false);
}

/** The chat's turn for `did`: asked by whoever asked for the action, under the text that asked for it. */
export function didMessage(message: GroupMessage, did: Did, now: number, fallback: string): GroupMessage {
  return {
    kind: "group-message",
    eventId: `did:${message.eventId}:${did.action}:${did.status}`,
    groupId: message.groupId,
    line: message.line,
    from: message.from,
    participants: message.participants,
    messageId: message.messageId,
    text: DID_TEXT,
    routine: { runId: `did:${now}`, path: DID_PATH },
    event: DID_EVENT,
    did,
    didFallback: fallback,
  };
}

/**
 * Tell the chat what code did: a turn of its own when node `did` is wired, else `fallback` (the old fixed line, until
 * each is retired). "queued", "sent" (the fallback went) or "dropped" (facts unreadable, nothing to say).
 */
export async function tellTex(storage: InboxStorage, deps: GroupDeps, message: GroupMessage, did: Did, fallback: string): Promise<"queued" | "sent" | "dropped"> {
  const facts = didOf(did);
  if (facts === null) return log("unreadable", did), "dropped";
  // A did turn never starts another: what it set off is said in its old line, so nothing loops.
  if (!didWired(deps.texGraph) || message.event === DID_EVENT) {
    await say(storage, deps, message, fallback, { system: true });
    return log("off", facts), "sent";
  }
  const outcome = await queueGroupByCode(storage, didMessage(message, facts, deps.now(), fallback), deps.now());
  if (outcome === "queued") return log("queued", facts), "queued";
  // Never silent: a full queue sends the old line, and says so in the log.
  await say(storage, deps, message, fallback, { system: true });
  return log("unqueued", facts), "sent";
}

/**
 * A `did` turn that could not run (the chat can't run one now, the model was out, or every try failed) is never
 * silent: what it carried goes as the old line, logged with why. True when `message` was such a turn.
 */
export async function didUnsaid(storage: InboxStorage, deps: GroupDeps, message: GroupMessage, why: string): Promise<boolean> {
  if (message.event !== DID_EVENT) return false;
  log(`unsaid_${why}`, message.did ?? {});
  if (message.didFallback) await say(storage, deps, message, message.didFallback, { system: true, reason: "failed" }).catch(() => log("unsent", message.did ?? {}));
  return true;
}

function log(outcome: string, did: Partial<Did>): void {
  console.log(JSON.stringify({ event: "group_did", outcome, action: did.action ?? null, status: did.status ?? null }));
}
