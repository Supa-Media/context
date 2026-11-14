/**
 * context-agent: the Worker behind Tex, the texting assistant.
 *
 *     Sendblue ──POST /sendblue──▶ this Worker ──▶ SenderInbox (one per phone number)
 *     Whapi (WhatsApp) ──POST /whapi──▶ the same inboxes and group queues (`whapi.ts`)
 *     (Linq ──POST /linq──▶, the old shared line, until it is retired)
 *                                             │  alarm
 *                                             ▼
 *                     control plane: whose phone is this? → short-lived grant
 *                     gateway /agent: answer with that grant
 *                     the line it came in on: send the reply
 *
 * And once a minute, a Cron Trigger runs whatever routines, nightly dreams,
 * daytime check-ins and daily housekeeping are due (routines.ts, dreams.ts,
 * heartbeats.ts, housekeeping.ts). For a
 * routine or a check-in: the control plane names the runs, the gateway runs each with
 * its own grant, and the answer is texted through each phone's SenderInbox to
 * the chat that phone last texted from. The control plane hears only an
 * outcome and a count.
 *
 * This Worker decides nothing about who may read what. It proves a webhook
 * came from Linq, and it asks the control plane for the grant of whoever
 * linked the sending phone; the gateway does every access decision with that
 * grant, exactly as it does for any other connected client.
 */

import { plainHttpResponse } from "./httpsOnly";
import { parseInbound } from "./inbound";
import { runDueRoutines, textPhone } from "./routines";
export { TexRoutines } from "./texRoutineDue";
import { runDueDreams } from "./dreams";
import { runDueHeartbeats } from "./heartbeats";
import { runDueHousekeeping } from "./housekeeping";
import { OBJECT_ID } from "./media";
import { bearerMatches, parseTellRequest, tellEveryone, type Told } from "./newLine";
import { parseSendblueInbound, repliedToText, sendblueKeys, statusPath, threadContext, verifySendblueSecret } from "./sendblue";
import { logInboundLag, sendblueStatus } from "./sendblueStatus";
import { groupNameOf, parseSendblueGroup, sendGroupName } from "./sendblueGroups";
import { groupInboxName } from "./groupInbox";
import { chatDirectoryName, chatWhereOf } from "./groupRoutines";
import type { DueRoutine } from "./routineClients";
import { toChat } from "./handOver";
import { verifyLinqSignature } from "./signature";
import { handleSimulator, SIMULATOR_PATH, simulatorEnabled } from "./simulator";
import { SIMULATOR_PAGE } from "./simulatorPage";
import { phoneOfJid, readWhapiMessage, verifyWhapiSecret, whapiKeys, type WhapiKeys } from "./whapi";
import { parseWhapiWebhook, whapiGroupChanges, whapiGroupNames } from "./whapiInbound";
import { logEventShape, logSendblueShape } from "./webhookShape";
import { groupLineFor } from "./groupLine";
import { inboxByName, objectById } from "./objectPlace";
export { GroupTurnWorkflow } from "./groupTurnWorkflow";
export { JobRunWorkflow } from "./jobWorkflow";

export type { Env } from "./env";
import type { Env } from "./env";

/** Linq's payloads are small; anything this big is not one of them. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * What the deploy needs to know without a secret: which settings are present.
 * Booleans only, never a value. The gateway origin is printed because it is
 * already public (the gateway's own config names it), and the deploy job
 * calls `/agent` there to prove it reaches the gateway and not the web app.
 */
function health(env: Env): Record<string, unknown> {
  const set = (value: string | undefined) => typeof value === "string" && value.trim() !== "";
  return {
    ok: true,
    webhook: set(env.LINQ_WEBHOOK_SECRET),
    replies: set(env.LINQ_API_KEY),
    sendblueWebhook: set(env.SENDBLUE_WEBHOOK_SECRET),
    sendblueReplies: sendblueKeys(env.SENDBLUE_API_KEY_ID, env.SENDBLUE_API_SECRET) !== null,
    sendblueReceipts: statusPath(env.SENDBLUE_STATUS_URL) !== null,
    whapiWebhook: set(env.WHAPI_WEBHOOK_SECRET),
    whapiReplies: whapiKeys(env.WHAPI_TOKEN, env.WHAPI_LINE) !== null,
    workerSecret: set(env.AGENT_WORKER_SECRET),
    controlPlane: set(env.CONTROL_PLANE_ORIGIN),
    gatewayOrigin: set(env.GATEWAY_ORIGIN) ? env.GATEWAY_ORIGIN : null,
    simulator: simulatorEnabled(env.SIMULATOR),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // First, before any route reads a header, a secret or a body (httpsOnly.ts).
    const plain = plainHttpResponse(request, url);
    if (plain !== null) return plain;
    if (url.pathname === "/health" && request.method === "GET") return Response.json(health(env));
    if (url.pathname === SIMULATOR_PATH || url.pathname.startsWith(`${SIMULATOR_PATH}/`)) {
      if (!simulatorEnabled(env.SIMULATOR)) return new Response(null, { status: 404 });
      return handleSimulator(request, env, SIMULATOR_PAGE);
    }
    if (url.pathname.startsWith("/media/")) return media(request, env, url);
    if (url.pathname.startsWith("/threads/")) return threads(request, env, url);
    if (url.pathname === "/new-line") return newLine(request, env);
    if (url.pathname === "/whapi") return whapiWebhook(request, env, url.origin);
    if (url.pathname.startsWith("/sendblue/status/")) return sendblueStatus(request, env.SENDER_INBOX, env.SENDBLUE_STATUS_URL, url);
    const line = url.pathname === "/sendblue" ? "sendblue" : url.pathname === "/linq" ? "linq" : null;
    if (line === null) return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405 });

    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return new Response(null, { status: 413 });
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });

    const now = Math.floor(Date.now() / 1000);
    const signed =
      line === "sendblue"
        ? await verifySendblueSecret(env.SENDBLUE_WEBHOOK_SECRET ?? "", request.headers)
        : await verifyLinqSignature(env.LINQ_WEBHOOK_SECRET ?? "", request.headers, raw, now);
    if (!signed) {
      logWebhook(line, "unsigned");
      return new Response(null, { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      if (line === "linq") return new Response(null, { status: 400 });
      return logSendblueShape(null, "not_json");
    }
    // A group message goes to the group's own queue, never a sender's (`groupInbox.ts`).
    const grouped = line === "sendblue" ? parseSendblueGroup(payload) : null;
    // How late Sendblue handed it over, by its own sent time (`sendblueStatus.ts`).
    if (line === "sendblue") logInboundLag(payload, Date.now(), grouped !== null);
    if (grouped?.kind === "invalid") logSendblueShape(payload, "group_invalid");
    if (grouped !== null) return groupWebhook(env, grouped, url.origin, "sendblue", groupNameOf(payload));
    // Sendblue retries a 400, so only Linq gets one; typing, calls, statuses and the rest are described by shape.
    const inbound = line === "sendblue" ? parseSendblueInbound(payload) : parseInbound(payload);
    if (inbound.kind === "invalid") {
      logWebhook(line, "invalid");
      if (line === "linq") return new Response(null, { status: 400 });
      return logSendblueShape(payload, "invalid");
    }
    // Signed, but nothing we act on, or a shape not yet known (`logSendblueShape`): 200 so the line does not retry it.
    if (inbound.kind === "ignored") {
      if (line === "sendblue" && inbound.reason === "event_type") logSendblueShape(payload, "ignored");
      logWebhook(line, "ignored", inbound.reason);
      return new Response(null, { status: 200 });
    }
    logWebhook(line, "accepted");

    // A tapback is answered or noted by the sender's queue (`reactions.ts`), never read from Sendblue.
    if (inbound.kind === "reaction") {
      // Named rather than quoted: the words it was on are read from Sendblue, as an inline reply's are.
      if (inbound.on !== undefined) {
        const keys = sendblueKeys(env.SENDBLUE_API_KEY_ID, env.SENDBLUE_API_SECRET);
        const words = keys === null ? null : await repliedToText((input, init) => fetch(input, init), keys, inbound.on, inbound.chatId);
        inbound.reaction = { ...inbound.reaction, words: (words ?? "").slice(0, 500) };
        delete inbound.on;
      }
      const stub = inboxByName(env.SENDER_INBOX, inbound.from);
      const result = (await toChat(env, "react", inbound.from, inbound)) ?? (await stub.fetch("https://inbox/react", { method: "POST", body: JSON.stringify(inbound) }));
      return new Response(null, { status: result.ok ? 200 : 503 });
    }

    // An inline reply carries the words it answers, read from Sendblue now, before it waits in the queue.
    // It is answered inside the same thread, and the turn is told it was a reply even when the words can't be read.
    const { replyTo, threadRoot, ...message } = inbound;
    const keys = sendblueKeys(env.SENDBLUE_API_KEY_ID, env.SENDBLUE_API_SECRET);
    if (replyTo !== undefined) {
      message.threaded = true;
      if (keys !== null) Object.assign(message, await threadContext((input, init) => fetch(input, init), keys, replyTo, threadRoot, message.chatId));
    }

    const stub = inboxByName(env.SENDER_INBOX, inbound.from);
    // The Worker's own address goes along, for pictures served back to Sendblue (`media.ts`).
    const result =
      (await toChat(env, "one", inbound.from, message, url.origin)) ??
      (await stub.fetch(`https://inbox/accept?origin=${encodeURIComponent(url.origin)}`, { method: "POST", body: JSON.stringify(message) }));
    return new Response(null, { status: result.ok ? 200 : 503 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runDueRoutines({
        fetch: (input, init) => fetch(input, init),
        controlPlaneOrigin: env.CONTROL_PLANE_ORIGIN,
        workerSecret: env.AGENT_WORKER_SECRET,
        gatewayOrigin: env.GATEWAY_ORIGIN,
        textPhone: (phone, text, idempotencyKey, continues, beside) => textPhone(env, phone, text, idempotencyKey, continues, beside),
        runInChat: (run) => runInChat(env, run),
        log: (entry) => console.log(JSON.stringify(entry)),
      }),
    );
    // Tex's daytime check-in (`heartbeats.ts`): looks at what changed, and texts only the person's own phone, only when worth it.
    ctx.waitUntil(
      runDueHeartbeats({
        fetch: (input, init) => fetch(input, init),
        controlPlaneOrigin: env.CONTROL_PLANE_ORIGIN,
        workerSecret: env.AGENT_WORKER_SECRET,
        gatewayOrigin: env.GATEWAY_ORIGIN,
        textPhone: (phone, text, idempotencyKey, continues, beside) => textPhone(env, phone, text, idempotencyKey, continues, beside),
        log: (entry) => console.log(JSON.stringify(entry)),
      }),
    );
    // Tex's nightly dream (`dreams.ts`): texts nobody, writes only in the person's own `tex/`.
    ctx.waitUntil(
      runDueDreams({
        fetch: (input, init) => fetch(input, init),
        controlPlaneOrigin: env.CONTROL_PLANE_ORIGIN,
        workerSecret: env.AGENT_WORKER_SECRET,
        gatewayOrigin: env.GATEWAY_ORIGIN,
        log: (entry) => console.log(JSON.stringify(entry)),
      }),
    );
    // Tex's daily housekeeping (`housekeeping.ts`): texts nobody, logs every change in the person's own `tex/housekeeping/`.
    ctx.waitUntil(
      runDueHousekeeping({
        fetch: (input, init) => fetch(input, init),
        controlPlaneOrigin: env.CONTROL_PLANE_ORIGIN,
        workerSecret: env.AGENT_WORKER_SECRET,
        gatewayOrigin: env.GATEWAY_ORIGIN,
        log: (entry) => console.log(JSON.stringify(entry)),
      }),
    );
  },
};

/**
 * One line per webhook, so "they texted and nothing came back" can be told
 * apart from "nothing ever arrived": an outcome and, for a dropped event, why.
 * Never the sender's number, never the text (see `inbox.ts` on what is kept).
 */
function logWebhook(line: "linq" | "sendblue" | "whapi", outcome: "unsigned" | "invalid" | "ignored" | "accepted", reason?: string): void {
  console.log(JSON.stringify({ event: `${line}_webhook`, outcome, ...(reason ? { reason } : {}) }));
}

/** A group message: dropped, or handed to the group's own queue, keyed on the group alone. */
async function groupWebhook(env: Env, grouped: NonNullable<ReturnType<typeof parseSendblueGroup>>, origin: string, line: "sendblue" | "whapi" = "sendblue", name: string | null = null): Promise<Response> {
  if (grouped.kind === "invalid") {
    logWebhook(line, "invalid");
    return new Response(null, { status: 200 });
  }
  if (grouped.kind === "ignored") {
    logWebhook(line, "ignored", `group_${grouped.reason}`);
    return new Response(null, { status: 200 });
  }
  await sendGroupName((input, init) => fetch(input, init), env.CONTROL_PLANE_ORIGIN, env.AGENT_WORKER_SECRET, grouped, name); // its folder's name, never in the message
  const stub = inboxByName(env.SENDER_INBOX, groupInboxName(grouped.groupId));
  // The Worker's own address goes along, as for a 1:1 text: without it the group's pictures had nowhere to be
  // served from, and every answer with a card failed after its words went out (2026-10-26).
  const result =
    (await toChat(env, "group", groupInboxName(grouped.groupId), grouped, origin)) ??
    (await stub.fetch(`https://inbox/group-accept?origin=${encodeURIComponent(origin)}`, { method: "POST", body: JSON.stringify(grouped) }));
  logWebhook(line, "accepted", "group");
  return new Response(null, { status: result.ok ? 200 : 503 });
}

/**
 * `POST /whapi`: Tex's WhatsApp line (`whapi.ts`). One delivery can carry
 * several messages; each goes where a Sendblue one would: a group's message
 * to the group's queue, a person's text or reaction to their inbox. Proven by
 * the header secret set in Whapi's webhook settings, and answered 200 once
 * read, so Whapi never retries what was taken or dropped on purpose.
 */
async function whapiWebhook(request: Request, env: Env, origin: string): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  if (!(await verifyWhapiSecret(env.WHAPI_WEBHOOK_SECRET ?? "", request.headers))) {
    logWebhook("whapi", "unsigned");
    return new Response(null, { status: 401 });
  }
  const keys = whapiKeys(env.WHAPI_TOKEN, env.WHAPI_LINE);
  // A signed delivery with no line to answer from: taken and dropped, never retried into a line that isn't there.
  if (keys === null) {
    logWebhook("whapi", "ignored", "no_line");
    return new Response(null, { status: 200 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    logEventShape("whapi", undefined, undefined, null, "not_json");
    return new Response(null, { status: 200 });
  }
  let failed = false;
  // A group's people changed: its kept member list is read from the app before its next answer goes out (`groupMembers.ts`).
  const changed = whapiGroupChanges(payload);
  for (const groupId of changed) {
    const result =
      (await toChat(env, "members", groupInboxName(groupId), null)) ??
      (await inboxByName(env.SENDER_INBOX, groupInboxName(groupId)).fetch("https://inbox/group-members-changed", { method: "POST" }));
    if (!result.ok) failed = true;
  }
  if (changed.length > 0) console.log(JSON.stringify({ event: "whapi_group_change", groups: changed.length, outcome: failed ? "failed" : "marked" }));
  for (const event of parseWhapiWebhook(payload, keys.line)) {
    const response = await whapiEvent(env, keys, event, origin, whapiGroupNames(payload)); // names beside, never in, messages
    if (response.status >= 500) failed = true;
  }
  // A queue that could not take one asks Whapi to deliver again; the inbox and the group queue drop what they already have.
  return new Response(null, { status: failed ? 503 : 200 });
}

async function whapiEvent(env: Env, keys: WhapiKeys, event: ReturnType<typeof parseWhapiWebhook>[number], origin: string, names: Map<string, string>): Promise<Response> {
  if (event.kind === "group-message") {
    if (event.reactionOn !== undefined && event.reaction !== undefined) {
      // Every reaction is read (Dev2, 2026-11-01); the words come only from a text Tex sent in this same group, so a
      // reaction elsewhere is context on "a message", and only one on Tex's own text can answer or be a yes (`thumbs.ts`).
      const words = await groupLineFor({ fetch: (input, init) => fetch(input, init), whapi: keys }, event.groupId).readOwnMessage(
        { line: event.line, groupId: event.groupId },
        event.reactionOn,
      );
      const reaction = { ...event.reaction, words: (words ?? "").slice(0, 500), ...(words === null ? { onOther: true as const } : { onTex: true as const }) };
      const { reactionOn: _on, ...message } = event;
      return groupWebhook(env, { ...message, reaction }, origin, "whapi", names.get(event.groupId) ?? null);
    }
    return groupWebhook(env, event, origin, "whapi", names.get(event.groupId) ?? null);
  }
  // One message that can't be read, or is not one we answer, leaves the rest of the delivery to be read.
  if (event.kind === "invalid" || event.kind === "ignored") {
    logWebhook("whapi", event.kind, event.kind === "ignored" ? event.reason : undefined);
    return new Response(null, { status: 200 });
  }
  if (event.kind === "reaction") {
    if (event.on !== undefined) {
      // Named, not quoted: the words are read now, and only from Tex's own text in this person's chat.
      const read = await readWhapiMessage((input, init) => fetch(input, init), keys, event.on);
      const own = read !== null && read.fromMe && phoneOfJid(read.chatId) === event.from;
      // Read and not Tex's is not the same as unread: only the second may be taken for the ask (`thumbs.ts`).
      event.reaction = { ...event.reaction, words: own ? read.text.slice(0, 500) : "", ...(read !== null && !own ? { onOther: true as const } : {}) };
      delete event.on;
    }
    logWebhook("whapi", "accepted", "reaction");
    const stub = inboxByName(env.SENDER_INBOX, event.from);
    const result = (await toChat(env, "react", event.from, event)) ?? (await stub.fetch("https://inbox/react", { method: "POST", body: JSON.stringify(event) }));
    return new Response(null, { status: result.ok ? 200 : 503 });
  }
  logWebhook("whapi", "accepted");
  const { replyTo: _reply, threadRoot: _root, ...message } = event;
  const stub = inboxByName(env.SENDER_INBOX, event.from);
  const result =
    (await toChat(env, "one", event.from, message, origin)) ??
    (await stub.fetch(`https://inbox/accept?origin=${encodeURIComponent(origin)}`, { method: "POST", body: JSON.stringify(message) }));
  return new Response(null, { status: result.ok ? 200 : 503 });
}

/**
 * `GET /media/<object id>/<token>.<ext>`: a picture from someone's notes,
 * fetched by Sendblue to send it (`media.ts`). Every miss is the same 404.
 */
async function media(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const match = /^\/media\/([0-9a-f]{64})\/([0-9a-f]{64})\.[a-z]{3,4}$/.exec(url.pathname);
  if (!match || !OBJECT_ID.test(match[1])) return new Response(null, { status: 404 });
  const stub = objectById(env.SENDER_INBOX, match[1]);
  if (stub === null) return new Response(null, { status: 404 });
  return stub.fetch(`https://inbox/media/${match[2]}`);
}

/**
 * `GET /threads/<object id>/<token>`: a chat's live view of its jobs, as JSON,
 * read by the router's page through its binding to this Worker (`jobs.ts`
 * `serveThreads`). Every miss is the same 404.
 */
async function threads(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const match = /^\/threads\/([0-9a-f]{64})\/([0-9a-f]{64})$/.exec(url.pathname);
  if (!match || !OBJECT_ID.test(match[1])) return new Response(null, { status: 404 });
  const stub = objectById(env.SENDER_INBOX, match[1]);
  if (stub === null) return new Response(null, { status: 404 });
  return stub.fetch(`https://inbox/threads/${match[2]}`);
}

/**
 * `POST /new-line` `{ number, send }`: tell everyone whose last chat is on the
 * old line that Tex has a new number (`newLine.ts`). Behind the Worker's own
 * secret; without `send: true` it is a dry run that texts nobody.
 */
async function newLine(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!(await bearerMatches(env.AGENT_WORKER_SECRET, request.headers.get("authorization")))) {
    return new Response(null, { status: 401 });
  }
  const asked = parseTellRequest(await request.json().catch(() => null));
  if (asked === null || !env.CONTROL_PLANE_ORIGIN) return new Response(null, { status: 400 });
  const counts = await tellEveryone(
    {
      fetch: (input, init) => fetch(input, init),
      controlPlaneOrigin: env.CONTROL_PLANE_ORIGIN,
      workerSecret: env.AGENT_WORKER_SECRET,
      tellPhone: async (phone, body) => {
        const stub = inboxByName(env.SENDER_INBOX, phone);
        const response = await stub.fetch("https://inbox/new-line", { method: "POST", body: JSON.stringify(body) });
        if (!response.ok) return "failed";
        return ((await response.json()) as { told: Told }).told;
      },
    },
    asked,
  ).catch(() => null);
  console.log(JSON.stringify({ event: "new_line", dryRun: asked.dryRun, ...(counts ?? { error: "unreachable" }) }));
  return counts === null ? new Response(null, { status: 502 }) : Response.json({ dryRun: asked.dryRun, ...counts });
}

/** A chat routine's run, into its chat's own queue, found by the chat's key (`groupRoutines.ts`). */
async function runInChat(env: Env, run: DueRoutine): Promise<"queued" | "no_chat" | "failed"> {
  const phone = run.phones[0];
  if (run.chat === undefined || phone === undefined) return "no_chat";
  const directory = inboxByName(env.SENDER_INBOX, chatDirectoryName(run.chat));
  const found = await directory.fetch("https://inbox/chat-where", { method: "GET" });
  const where = found.ok ? chatWhereOf(await found.json()) : null;
  if (where === null) return "no_chat";
  const stub = inboxByName(env.SENDER_INBOX, groupInboxName(where.groupId));
  const body = { ...where, runId: run.runId, path: run.path, phone, timeZone: run.timeZone, ...(run.since !== undefined ? { since: run.since } : {}) };
  const response = await stub.fetch("https://inbox/group-routine", { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) return "failed";
  return ((await response.json()) as { outcome?: unknown }).outcome === "queued" ? "queued" : "failed";
}

export { SenderInbox } from "./chatObject";
