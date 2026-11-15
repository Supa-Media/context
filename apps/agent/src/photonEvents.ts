/**
 * The Photon bridge's way in (Contract A): the `PhotonEvents` entrypoint, called over a service binding with one
 * `PhotonEvent` per call. No URL reaches it and no secret is read here, so nothing on the public address can send an
 * event: the binding is the trust, as it is for `TexRoutines` (`texRoutineDue.ts`).
 *
 * Answers: 200 once the event is queued, a duplicate, ignored, or an edit or unsend (counted only); 400 for an event
 * that cannot be read (the bridge drops it); 503 when the chat's queue could not take it (the bridge retries).
 *
 * A picture's address is signed under this Worker's own public origin, `AGENT_ORIGIN`, which the deploy works out
 * from the Worker's name (`deploy-agent-worker.yml`); an RPC call has no URL to learn it from. Unset, pictures are
 * dropped and logged as `no_origin`.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { groupInboxName } from "./groupInbox";
import { arrivedAs, asOldGroup, removeOldNumber, type Matched } from "./groupMoves";
import { post } from "./clients";
import { toChat } from "./handOver";
import { inboxByName } from "./objectPlace";
import { photonAttachmentUrl, photonGroupGuid } from "./photon";
import { photonGroupMembers } from "./photonClient";
import { arrivalOf } from "./providerTiming";
import { photonSendStatusOf } from "./photonSendStatus";
import { parsePhotonEvent, photonAttachmentGuids } from "./photonInbound";
import { sendGroupName } from "./sendblueGroups";
import { workerOrigin } from "./media";

export class PhotonEvents extends WorkerEntrypoint<Env> {
  /** One `PhotonEvent` from the bridge; resolves its status, as the bridge reads it (see the module comment). */
  async event(body: unknown): Promise<{ status: number }> {
    return { status: await photonEvent(this.env, body) };
  }
}

function log(outcome: string, reason?: string): void {
  console.log(JSON.stringify({ event: "photon_webhook", outcome, ...(reason ? { reason } : {}) }));
}

/** One event, read and handed over. See the module comment for what each status means. */
export async function photonEvent(env: Env, body: unknown): Promise<number> {
  // Tex's own text reaching Apple, or the person reading it: the chat's `send` step, as Sendblue's status callback is.
  const sendStatus = photonSendStatusOf(body);
  if (sendStatus !== null) {
    // A moved group's sends are reported to the old group's object, where the group lives (`groupMoves.ts`).
    const group = sendStatus.object.kind === "group" ? sendStatus.object.groupId : null;
    const old = group === null ? null : (await arrivedAs(env.SENDER_INBOX, { photonGroupId: group, photonLine: "", from: "", participants: [] })).from;
    const name = group === null ? (sendStatus.object as { phone: string }).phone : groupInboxName(old?.groupId ?? group);
    const result = await inboxByName(env.SENDER_INBOX, name).fetch("https://inbox/send-status", { method: "POST", body: JSON.stringify(sendStatus) });
    console.log(JSON.stringify({ event: "photon_send_status", status: sendStatus.report?.status, outcome: result.ok ? "noted" : "failed" }));
    return result.ok ? 200 : 503;
  }
  // A read receipt is the one kind Tex never acts on, and the most frequent: counted, not read.
  if (typeof body === "object" && body !== null && (body as { type?: unknown }).type === "message.read") {
    console.log(JSON.stringify({ event: "photon_read", outcome: "ignored" }));
    return 200;
  }
  const guids = photonAttachmentGuids(body);
  const origin = guids.length > 0 && env.AGENT_ORIGIN ? workerOrigin(env.AGENT_ORIGIN) : null;
  if (guids.length > 0 && origin === null) log("ignored", "no_origin");
  const addresses = new Map<string, string>();
  if (origin !== null) {
    for (const guid of guids) {
      const address = await photonAttachmentUrl(origin, env.AGENT_WORKER_SECRET, guid);
      if (address !== null) addresses.set(guid, address);
    }
  }
  const parsed = parsePhotonEvent(body, { attachmentUrl: (guid) => addresses.get(guid) });
  if (parsed.kind === "invalid") {
    log("invalid");
    return 400;
  }
  if (parsed.kind === "ignored") {
    log("ignored", parsed.reason);
    return 200;
  }
  // An edit or an unsend is counted only: the ledger write waits for the integration phase (plan.md).
  if (parsed.kind === "edited" || parsed.kind === "unsent") {
    console.log(JSON.stringify({ event: "photon_side", kind: parsed.kind, outcome: "not_recorded" }));
    return 200;
  }
  const known = origin ?? undefined;
  // Apple's own time for the event (the bridge's `at`), for the chat's `text` step to show the provider's lag (`providerTiming.ts`).
  const provider = arrivalOf("photon", (body as { at?: unknown }).at, Date.now());
  if (parsed.kind === "group-message") {
    // A group staff moved here from the old number is still that group (`groupMoves.ts`): filed under its old id and line.
    const chat = photonGroupGuid(parsed.groupId);
    const members = env.PHOTON && chat !== null ? () => photonGroupMembers(env.PHOTON as Fetcher, { line: parsed.line, chat }) : undefined;
    const arrival = await arrivedAs(env.SENDER_INBOX, { photonGroupId: parsed.groupId, photonLine: parsed.line, from: parsed.from, participants: parsed.participants }, members);
    if (arrival.matched !== undefined) return await finishGroupMove(env, parsed.line, parsed.groupId, arrival.matched);
    const message = arrival.from === null ? parsed : asOldGroup(parsed, arrival.from);
    // A group's message goes to the group's own queue, never a sender's (`groupWebhook`, `index.ts`).
    await sendGroupName((input, init) => fetch(input, init), env.CONTROL_PLANE_ORIGIN, env.AGENT_WORKER_SECRET, message, null);
    const name = groupInboxName(message.groupId);
    const brought = { ...message, provider };
    const result =
      (await toChat(env, "group", name, brought, known)) ??
      (await inboxByName(env.SENDER_INBOX, name).fetch(`https://inbox/group-accept?origin=${encodeURIComponent(known ?? "")}`, { method: "POST", body: JSON.stringify(brought) }));
    log("accepted", "group");
    return result.ok ? 200 : 503;
  }
  if (parsed.kind === "reaction") {
    const reacted = { ...parsed, provider };
    const result =
      (await toChat(env, "react", parsed.from, reacted)) ??
      (await inboxByName(env.SENDER_INBOX, parsed.from).fetch("https://inbox/react", { method: "POST", body: JSON.stringify(reacted) }));
    log("accepted", "reaction");
    return result.ok ? 200 : 503;
  }
  if (parsed.kind !== "message") return 400;
  log("accepted");
  const brought = { ...parsed, provider };
  const result =
    (await toChat(env, "one", parsed.from, brought, known)) ??
    (await inboxByName(env.SENDER_INBOX, parsed.from).fetch(`https://inbox/accept?origin=${encodeURIComponent(known ?? "")}`, { method: "POST", body: JSON.stringify(brought) }));
  return result.ok ? 200 : 503;
}

/**
 * The old number's swap note, heard by the new line in a group staff moved (`groupMoves.ts` step 3): the two groups are
 * tied now; the new line takes the old number out of the group and the control plane hears how that went. The note
 * itself is Tex's own words and takes no turn.
 */
async function finishGroupMove(env: Env, photonLine: string, photonGroupId: string, matched: Matched): Promise<number> {
  const removed = await removeOldNumber(env.PHOTON, photonLine, photonGroupId, matched.line);
  const report = removed ? { status: "moved" } : { status: "failed", detail: "remove_failed", askedAt: matched.askedAt };
  let noted = "unsent";
  try {
    const { status } = await post((input, init) => fetch(input, init), "control_plane", `${env.CONTROL_PLANE_ORIGIN}/agent-texts/move-report`, env.AGENT_WORKER_SECRET, { kind: "group", key: matched.groupKey, ...report });
    noted = status === 200 ? "noted" : `status_${status}`;
  } catch {
    noted = "unreachable";
  }
  console.log(JSON.stringify({ event: "chat_move", kind: "group", outcome: removed ? "moved" : "remove_failed", report: noted }));
  return 200;
}
