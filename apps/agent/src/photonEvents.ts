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
import { toChat } from "./handOver";
import { inboxByName } from "./objectPlace";
import { photonAttachmentUrl } from "./photon";
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
  if (parsed.kind === "group-message") {
    // A group's message goes to the group's own queue, never a sender's (`groupWebhook`, `index.ts`).
    await sendGroupName((input, init) => fetch(input, init), env.CONTROL_PLANE_ORIGIN, env.AGENT_WORKER_SECRET, parsed, null);
    const name = groupInboxName(parsed.groupId);
    const result =
      (await toChat(env, "group", name, parsed, known)) ??
      (await inboxByName(env.SENDER_INBOX, name).fetch(`https://inbox/group-accept?origin=${encodeURIComponent(known ?? "")}`, { method: "POST", body: JSON.stringify(parsed) }));
    log("accepted", "group");
    return result.ok ? 200 : 503;
  }
  if (parsed.kind === "reaction") {
    const result =
      (await toChat(env, "react", parsed.from, parsed)) ??
      (await inboxByName(env.SENDER_INBOX, parsed.from).fetch("https://inbox/react", { method: "POST", body: JSON.stringify(parsed) }));
    log("accepted", "reaction");
    return result.ok ? 200 : 503;
  }
  if (parsed.kind !== "message") return 400;
  log("accepted");
  const result =
    (await toChat(env, "one", parsed.from, parsed, known)) ??
    (await inboxByName(env.SENDER_INBOX, parsed.from).fetch(`https://inbox/accept?origin=${encodeURIComponent(known ?? "")}`, { method: "POST", body: JSON.stringify(parsed) }));
  return result.ok ? 200 : 503;
}
