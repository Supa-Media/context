/**
 * The Photon bridge's way in (Contract A): the `PhotonEvents` entrypoint, called over a service binding with one
 * `PhotonEvent` per call. No URL reaches it and no secret is read here, so nothing on the public address can send an
 * event: the binding is the trust, as it is for `TexRoutines` (`texRoutineDue.ts`).
 *
 * Answers: 200 once the event is queued (an edit or an unsend, to its chat's `edit` step), a duplicate, or ignored; 400 for an event
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
import { arrivalOf, providerTime } from "./providerTiming";
import { photonSendStatusOf } from "./photonSendStatus";
import { parsePhotonEvent, photonAttachmentGuids, photonGroupChange, photonGroupNameOf, type PhotonDropped, type PhotonEdit } from "./photonInbound";
import { sendGroupName } from "./sendblueGroups";
import { workerOrigin } from "./media";
import { MAX_REPLAY_MS } from "./replayWindow";

export class PhotonEvents extends WorkerEntrypoint<Env> {
  /** One `PhotonEvent` from the bridge; resolves its status, as the bridge reads it (see the module comment). */
  async event(body: unknown): Promise<{ status: number }> {
    return { status: await photonEvent(this.env, body) };
  }
}

/**
 * Whether an event is a catch-up replay that may not take a turn, or change a group (`replayWindow.ts`, 2026-11-19: a
 * container restart replayed ~744 events from a stuck frontier, and every one older than the inbox's dedupe window was
 * answered again). A replay is stale when Apple timed it more than MAX_REPLAY_MS ago, and a replay whose time is guessed
 * or unreadable cannot prove it is recent, so it is stale too. A live event keeps its time as it is: a guessed time is
 * the bridge's clock, so it is not aged.
 */
export function staleReplay(body: unknown): boolean {
  const event = (typeof body === "object" && body !== null ? body : {}) as { at?: unknown; replay?: unknown; atGuessed?: unknown };
  const at = providerTime(event.at);
  if (event.replay === true && (event.atGuessed === true || at === null)) return true;
  if (event.atGuessed === true || at === null) return false;
  return Date.now() - at > MAX_REPLAY_MS;
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
  // A group renamed, or somebody added, removed or left: noted for the group's home, never a message (`groupChange`).
  // A replayed group change is old news: it is not acted on (`staleReplay`), like a replayed text.
  const change = photonGroupChange(body);
  if (change !== null) {
    if (staleReplay(body)) {
      log("ignored", "stale_replay");
      return 200;
    }
    return await groupChange(env, change);
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
  // Apple's own time for the event (the bridge's `at`), for the chat's `text` step to show the provider's lag (`providerTiming.ts`).
  const provider = arrivalOf("photon", (body as { at?: unknown }).at, Date.now());
  if (parsed.kind === "ignored") {
    log("ignored", parsed.reason);
    // A message dropped in a chat it names is still a step of that chat: its history shows the drop and why (`dropped`).
    if ("chatId" in parsed || "groupId" in parsed) await noteDropped(env, parsed as PhotonDropped, provider);
    return 200;
  }
  // A catch-up replay that may not take a turn: noted on its chat as dropped, never handed over, 200 so the bridge moves on.
  if (staleReplay(body)) {
    log("ignored", "stale_replay");
    const named = parsed as { chatId?: string; groupId?: string; line?: string; from?: string };
    await noteDropped(env, { kind: "ignored", reason: "stale_replay", chatId: named.chatId, groupId: named.groupId, line: named.line, from: named.from }, provider);
    return 200;
  }
  const known = origin ?? undefined;
  // An edit or an unsend goes to its chat's `edit` step (node "edit", `editStep.ts`): kept beside the text it changes; an
  // edit that changed what they said takes a turn, and an unsent text still waiting is taken back out of the queue.
  if (parsed.kind === "edited" || parsed.kind === "unsent") return await photonEdit(env, parsed, provider);
  if (parsed.kind === "group-message") {
    // A group staff moved here from the old number is still that group (`groupMoves.ts`): filed under its old id and line.
    const chat = photonGroupGuid(parsed.groupId);
    const members = env.PHOTON && chat !== null ? () => photonGroupMembers(env.PHOTON as Fetcher, { line: parsed.line, chat }) : undefined;
    const arrival = await arrivedAs(env.SENDER_INBOX, { photonGroupId: parsed.groupId, photonLine: parsed.line, from: parsed.from, participants: parsed.participants }, members);
    if (arrival.matched !== undefined) return await finishGroupMove(env, parsed.line, parsed.groupId, arrival.matched);
    const message = arrival.from === null ? parsed : asOldGroup(parsed, arrival.from);
    // A group's message goes to the group's own queue, never a sender's (`groupWebhook`, `index.ts`).
    // The chat's name, as Sendblue's webhook gave it with every message: the app shows it as the chat's folder name.
    await sendGroupName((input, init) => fetch(input, init), env.CONTROL_PLANE_ORIGIN, env.AGENT_WORKER_SECRET, message, photonGroupNameOf(body));
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
 * A group's change, for the group as Tex files it (under its old id and line when staff moved it here,
 * `groupMoves.ts`): a new name goes to the app, as a message's name does; a change of people marks the group's kept
 * member list changed, so a sender-only line is not filed by a list that is behind (`groupMembers.ts`).
 */
async function groupChange(env: Env, change: NonNullable<ReturnType<typeof photonGroupChange>>): Promise<number> {
  // Only the alias is looked up: with no sender, no pending move can match, so a change (the old number adding Tex's
  // new one, mid-move) never ties the groups without the swap note that finishes the move.
  const arrival = await arrivedAs(env.SENDER_INBOX, { photonGroupId: change.groupId, photonLine: change.line, from: "", participants: [] });
  const place = arrival.from === null ? { groupId: change.groupId, line: change.line } : { groupId: arrival.from.groupId, line: arrival.from.line };
  if (change.change === "renamed") {
    await sendGroupName((input, init) => fetch(input, init), env.CONTROL_PLANE_ORIGIN, env.AGENT_WORKER_SECRET, place, change.name);
    log("accepted", "group_renamed");
    return 200;
  }
  const name = groupInboxName(place.groupId);
  const result = (await toChat(env, "members", name, null)) ?? (await inboxByName(env.SENDER_INBOX, name).fetch("https://inbox/group-members-changed", { method: "POST" }));
  log("accepted", "group_members");
  return result.ok ? 200 : 503;
}

/**
 * A message the line read and dropped, told to its chat's object so the chat's `text` step shows it (outcome "dropped"
 * and the reason, never the words). A group staff moved here is filed under its old id, as its messages are. Best effort:
 * the drop already answered 200, and a note that fails is only logged.
 */
async function noteDropped(env: Env, dropped: PhotonDropped, provider: unknown): Promise<void> {
  try {
    let chat = dropped.chatId;
    let name = dropped.from;
    if (dropped.groupId !== undefined) {
      // Only the moved group's alias is read: no sender is named, so a drop can never be taken for the old number's swap note.
      const arrival = await arrivedAs(env.SENDER_INBOX, { photonGroupId: dropped.groupId, photonLine: dropped.line ?? "", from: "", participants: [] });
      chat = arrival.from?.groupId ?? dropped.groupId;
      name = groupInboxName(chat);
    }
    if (chat === undefined || name === undefined) return;
    const result = await inboxByName(env.SENDER_INBOX, name).fetch("https://inbox/dropped", {
      method: "POST",
      body: JSON.stringify({ chat, kind: dropped.groupId !== undefined ? "group" : "one", reason: dropped.reason, provider }),
    });
    if (!result.ok) log("drop_unnoted", dropped.reason);
  } catch {
    log("drop_unnoted", dropped.reason);
  }
}

/** An edit or an unsend, to its chat's object: a group's, filed under its old id when staff moved it here (`groupMoves.ts`), or the sender's. */
async function photonEdit(env: Env, edit: PhotonEdit, provider: unknown): Promise<number> {
  let brought: PhotonEdit & { provider?: unknown } = { ...edit, provider };
  let name = edit.from;
  if (edit.groupId !== undefined) {
    const arrival = await arrivedAs(env.SENDER_INBOX, { photonGroupId: edit.groupId, photonLine: edit.line, from: edit.from, participants: edit.participants ?? [edit.from] });
    if (arrival.from !== null) brought = asOldGroup({ ...brought, groupId: edit.groupId, participants: edit.participants ?? [edit.from] }, arrival.from);
    name = groupInboxName(brought.groupId ?? edit.groupId);
  }
  const result = (await toChat(env, "edit", name, brought)) ?? (await inboxByName(env.SENDER_INBOX, name).fetch("https://inbox/edit", { method: "POST", body: JSON.stringify(brought) }));
  log("accepted", `${edit.groupId !== undefined ? "group_" : ""}${edit.kind === "unsent" ? "unsend" : "edit"}`);
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
