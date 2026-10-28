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
import { parseInbound, type Inbound } from "./inbound";
import { accept, carryOnAfterSave, drain, react, type InboxDeps } from "./inbox";
import { checkReady } from "./ready";
import { checkGmail } from "./gmailWatch";
import type { Message } from "./reply";
import { runDueRoutines, textRoutine, type PhoneTexted } from "./routines";
import { runDueDreams } from "./dreams";
import { runDueHeartbeats } from "./heartbeats";
import { runDueHousekeeping } from "./housekeeping";
import type { Picture } from "./line";
import { hostPicture, OBJECT_ID, ORIGIN_KEY, serveMedia, workerOrigin } from "./media";
import { bearerMatches, parseTellRequest, tellEveryone, tellNewLine, type Told } from "./newLine";
import { parseSendblueInbound, repliedToText, sendblueKeys, threadContext, verifySendblueSecret } from "./sendblue";
import { parseSendblueGroup, type GroupMessage } from "./sendblueGroups";
import { acceptGroup, acceptGroupRoutine, askControlPlane, drainGroup, groupInboxName } from "./groupInbox";
import { CHAT_WHERE_KEY, chatDirectoryName, chatRoutineRunOf, chatWhereOf, WHERE_KEPT_KEY } from "./groupRoutines";
import { sha256Hex } from "./groupChat";
import { syncGuestPeople } from "./groupGuestPeople";
import type { DueRoutine } from "./clients";
import { checkReview } from "./reviewWatch";
import { verifyLinqSignature } from "./signature";
import { readJobSteer, readJobUpdate, type JobRun, type JobSteer, type JobUpdate } from "./jobs";
import { acceptJob, armJobNext, failJob, runJob, steerJob } from "./jobRun";
import { handOverJob, startJobFlow, type JobRunParams } from "./jobWorkflow";
import { jobUpdate } from "./jobTexts";
import { handleSimulator, SIMULATOR_PATH, simulatorEnabled, simulatorInbox } from "./simulator";
import { SIMULATOR_PAGE } from "./simulatorPage";
import { appCardConfig } from "./appCards";
import { phoneOfJid, readWhapiMessage, verifyWhapiSecret, whapiKeys, type WhapiKeys } from "./whapi";
import { parseWhapiWebhook } from "./whapiInbound";
import { groupLineFor } from "./groupLine";
import { noteCardDrawer } from "./noteCards";
import { holdsAsYes, takesBackYes } from "./thumbs";
import { answerHanded, failHanded } from "./groupTurnRun";
import type { GroupTurnParams } from "./groupTurnWorkflow";
export { GroupTurnWorkflow } from "./groupTurnWorkflow";
export { JobRunWorkflow } from "./jobWorkflow";

export interface Env {
  SENDER_INBOX: DurableObjectNamespace;
  /** Sees each group turn through, with retries (`groupTurnWorkflow.ts`); absent, group turns are answered in their object. */
  GROUP_TURN?: Workflow<GroupTurnParams>;
  JOB_RUN?: Workflow<JobRunParams>;
  /** Linq's `whsec_…` webhook signing secret. */
  LINQ_WEBHOOK_SECRET: string;
  /** Linq Partner API key, used to send replies. */
  LINQ_API_KEY: string;
  /** Sendblue's API key id and secret, used to send replies on Tex's dedicated line. */
  SENDBLUE_API_KEY_ID?: string;
  SENDBLUE_API_SECRET?: string;
  /** The secret set on Sendblue's receive webhook; it arrives verbatim in `sb-signing-secret`. */
  SENDBLUE_WEBHOOK_SECRET?: string;
  /** Tex's WhatsApp line (`whapi.ts`): the Whapi channel's token and the line's own number (E.164). */
  WHAPI_TOKEN?: string;
  WHAPI_LINE?: string;
  /** The value Whapi's webhook settings send in `x-tex-webhook-secret`. Absent, every WhatsApp delivery is refused. */
  WHAPI_WEBHOOK_SECRET?: string;
  /** Opens the control plane's /agent-texts/* routes and nothing else. */
  AGENT_WORKER_SECRET: string;
  /** The Convex HTTP origin (…convex.site). */
  CONTROL_PLANE_ORIGIN: string;
  /** The gateway origin, e.g. https://mcp.context.lc */
  GATEWAY_ORIGIN: string;
  /** "on" serves the texts simulator (simulator.ts). Only staging sets it. */
  SIMULATOR?: string;
  /** Turns a texted photo the model cannot read (HEIC) into a JPEG (`attachments.ts`). */
  IMAGES?: ImagesBinding;
  /** "on" sends Context cards to every chat, "app" only to chats that have shown the app (`appCards.ts`, `cardChats.ts`). */
  APP_CARDS?: string;
  APP_CARD_EXTENSION_ID?: string;
  APPLE_TEAM_ID?: string;
  APP_STORE_ID?: string;
}

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
    if (url.pathname === "/new-line") return newLine(request, env);
    if (url.pathname === "/whapi") return whapiWebhook(request, env, url.origin);
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
      return new Response(null, { status: 400 });
    }
    // A group message goes to the group's own queue, never a sender's (`groupInbox.ts`).
    const grouped = line === "sendblue" ? parseSendblueGroup(payload) : null;
    if (grouped !== null) return groupWebhook(env, grouped, url.origin);
    const inbound = line === "sendblue" ? parseSendblueInbound(payload) : parseInbound(payload);
    if (inbound.kind === "invalid") {
      logWebhook(line, "invalid");
      return new Response(null, { status: 400 });
    }
    // Signed, but nothing we act on: 200 so the line does not retry it.
    if (inbound.kind === "ignored") {
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
      const stub = env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName(inbound.from));
      const result = await stub.fetch("https://inbox/react", { method: "POST", body: JSON.stringify(inbound) });
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

    const stub = env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName(inbound.from));
    // The Worker's own address goes along, for pictures served back to Sendblue (`media.ts`).
    const result = await stub.fetch(`https://inbox/accept?origin=${encodeURIComponent(url.origin)}`, {
      method: "POST",
      body: JSON.stringify(message),
    });
    return new Response(null, { status: result.ok ? 200 : 503 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runDueRoutines({
        fetch: (input, init) => fetch(input, init),
        controlPlaneOrigin: env.CONTROL_PLANE_ORIGIN,
        workerSecret: env.AGENT_WORKER_SECRET,
        gatewayOrigin: env.GATEWAY_ORIGIN,
        textPhone: (phone, text, idempotencyKey) => textPhone(env, phone, text, idempotencyKey),
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
        textPhone: (phone, text, idempotencyKey, continues) => textPhone(env, phone, text, idempotencyKey, continues),
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
async function groupWebhook(env: Env, grouped: NonNullable<ReturnType<typeof parseSendblueGroup>>, origin: string, line: "sendblue" | "whapi" = "sendblue"): Promise<Response> {
  if (grouped.kind === "invalid") {
    logWebhook(line, "invalid");
    return new Response(null, { status: 400 });
  }
  if (grouped.kind === "ignored") {
    logWebhook(line, "ignored", `group_${grouped.reason}`);
    return new Response(null, { status: 200 });
  }
  const stub = env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName(groupInboxName(grouped.groupId)));
  // The Worker's own address goes along, as for a 1:1 text: without it the group's pictures had nowhere to be
  // served from, and every answer with a card failed after its words went out (2026-10-26).
  const result = await stub.fetch(`https://inbox/group-accept?origin=${encodeURIComponent(origin)}`, { method: "POST", body: JSON.stringify(grouped) });
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
    return new Response(null, { status: 400 });
  }
  let failed = false;
  for (const event of parseWhapiWebhook(payload, keys.line)) {
    const response = await whapiEvent(env, keys, event, origin);
    if (response.status >= 500) failed = true;
  }
  // A queue that could not take one asks Whapi to deliver again; the inbox and the group queue drop what they already have.
  return new Response(null, { status: failed ? 503 : 200 });
}

async function whapiEvent(env: Env, keys: WhapiKeys, event: ReturnType<typeof parseWhapiWebhook>[number], origin: string): Promise<Response> {
  if (event.kind === "group-message") {
    if (event.reactionOn !== undefined && event.reaction !== undefined) {
      // A reaction counts only on a text Tex sent in this same group, and only as a yes held or taken back (`thumbs.ts`).
      const words = await groupLineFor({ fetch: (input, init) => fetch(input, init), whapi: keys }, event.groupId).readOwnMessage(
        { line: event.line, groupId: event.groupId },
        event.reactionOn,
      );
      const reaction = { ...event.reaction, words: (words ?? "").slice(0, 500) };
      if (words === null || !(holdsAsYes(reaction) || takesBackYes(reaction))) return groupWebhook(env, { kind: "ignored", reason: "reaction" }, origin, "whapi");
      const { reactionOn: _on, ...message } = event;
      return groupWebhook(env, { ...message, reaction }, origin, "whapi");
    }
    return groupWebhook(env, event, origin, "whapi");
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
      event.reaction = { ...event.reaction, words: own ? read.text.slice(0, 500) : "" };
      delete event.on;
    }
    logWebhook("whapi", "accepted", "reaction");
    const stub = env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName(event.from));
    const result = await stub.fetch("https://inbox/react", { method: "POST", body: JSON.stringify(event) });
    return new Response(null, { status: result.ok ? 200 : 503 });
  }
  logWebhook("whapi", "accepted");
  const { replyTo: _reply, threadRoot: _root, ...message } = event;
  const stub = env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName(event.from));
  const result = await stub.fetch(`https://inbox/accept?origin=${encodeURIComponent(origin)}`, { method: "POST", body: JSON.stringify(message) });
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
  let id: DurableObjectId;
  try {
    id = env.SENDER_INBOX.idFromString(match[1]);
  } catch {
    return new Response(null, { status: 404 });
  }
  return env.SENDER_INBOX.get(id).fetch(`https://inbox/media/${match[2]}`);
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
        const stub = env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName(phone));
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

/** Ask one phone's inbox to text it a routine's answer, or a check-in under the text it `continues`. */
async function textPhone(env: Env, phone: string, text: string, idempotencyKey: string, continues?: string): Promise<PhoneTexted> {
  const stub = env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName(phone));
  const response = await stub.fetch(ROUTINE_TEXT_URL, {
    method: "POST",
    body: JSON.stringify({ text, idempotencyKey, ...(continues !== undefined ? { continues } : {}) }),
  });
  if (!response.ok) return "failed";
  const { status } = (await response.json()) as { status?: unknown };
  return status === "texted" || status === "no_chat" ? status : "failed";
}

/** A chat routine's run, into its chat's own queue, found by the chat's key (`groupRoutines.ts`). */
async function runInChat(env: Env, run: DueRoutine): Promise<"queued" | "no_chat" | "failed"> {
  const phone = run.phones[0];
  if (run.chat === undefined || phone === undefined) return "no_chat";
  const directory = env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName(chatDirectoryName(run.chat)));
  const found = await directory.fetch("https://inbox/chat-where", { method: "GET" });
  const where = found.ok ? chatWhereOf(await found.json()) : null;
  if (where === null) return "no_chat";
  const stub = env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName(groupInboxName(where.groupId)));
  const body = { ...where, runId: run.runId, path: run.path, phone, timeZone: run.timeZone, ...(run.since !== undefined ? { since: run.since } : {}) };
  const response = await stub.fetch("https://inbox/group-routine", { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) return "failed";
  return ((await response.json()) as { outcome?: unknown }).outcome === "queued" ? "queued" : "failed";
}

/** The inbox's internal route for a routine's text. Only this Worker reaches it. */
const ROUTINE_TEXT_URL = "https://inbox/routine-text";

export class SenderInbox implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/sim/")) {
      // The Worker routes here only while the simulator is on; checked again
      // so the object never serves it on its own say-so.
      if (!simulatorEnabled(this.env.SIMULATOR)) return new Response(null, { status: 404 });
      const body = (await request.json()) as { keyHash: string; phone: string; text: string };
      return simulatorInbox(this.state.storage, path.slice("/sim/".length), body, Date.now(), (message) =>
        accept(this.state.storage, message, Date.now()),
      );
    }
    if (path === "/routine-text") {
      const body = (await request.json()) as { text?: unknown; idempotencyKey?: unknown; continues?: unknown };
      if (typeof body.text !== "string" || typeof body.idempotencyKey !== "string") {
        return new Response(null, { status: 400 });
      }
      const status = await textRoutine(
        this.state.storage,
        { text: body.text, idempotencyKey: body.idempotencyKey, ...(typeof body.continues === "string" ? { continues: body.continues } : {}) },
        {
          fetch: (input, init) => fetch(input, init),
          linqApiKey: this.env.LINQ_API_KEY,
          sendblue: sendblueKeys(this.env.SENDBLUE_API_KEY_ID, this.env.SENDBLUE_API_SECRET),
          whapi: whapiKeys(this.env.WHAPI_TOKEN, this.env.WHAPI_LINE),
          now: () => Date.now(),
          simulator: simulatorEnabled(this.env.SIMULATOR),
        },
      );
      return Response.json({ status });
    }
    if (path === "/new-line") {
      const body = (await request.json()) as { text?: unknown; dryRun?: unknown };
      if (typeof body.text !== "string" || typeof body.dryRun !== "boolean") return new Response(null, { status: 400 });
      const told = await tellNewLine(this.state.storage, { text: body.text, dryRun: body.dryRun }, {
        fetch: (input, init) => fetch(input, init),
        linqApiKey: this.env.LINQ_API_KEY,
        sendblue: sendblueKeys(this.env.SENDBLUE_API_KEY_ID, this.env.SENDBLUE_API_SECRET),
        whapi: whapiKeys(this.env.WHAPI_TOKEN, this.env.WHAPI_LINE),
        now: () => Date.now(),
      });
      return Response.json({ told });
    }
    if (path === "/group-accept") {
      await this.keepOrigin(request);
      // Only this Worker's cron queues a routine's run (`/group-routine`); a webhook's message never names one.
      const { routine: _routine, ...message } = (await request.json()) as GroupMessage;
      await this.keepWhere(message);
      const outcome = await acceptGroup(this.state.storage, message, Date.now());
      // People who joined or left a guest chat are added or removed without anyone tagging Tex.
      await syncGuestPeople(this.state.storage, this.deps(), message);
      return Response.json({ outcome });
    }
    // A group turn's workflow (`groupTurnWorkflow.ts`): only this Worker's workflow reaches these.
    if (path === "/group-answer" || path === "/group-failed") {
      const { turn } = (await request.json()) as { turn?: unknown };
      if (typeof turn !== "string") return new Response(null, { status: 400 });
      const deps = this.deps();
      return Response.json({ outcome: await (path === "/group-answer" ? answerHanded : failHanded)(this.state.storage, deps, turn) });
    }
    if (path === "/group-routine") {
      const run = chatRoutineRunOf(await request.json());
      if (run === null) return new Response(null, { status: 400 });
      return Response.json({ outcome: await acceptGroupRoutine(this.state.storage, run, Date.now()) });
    }
    // A chat's directory entry (`groupRoutines.ts`): where the chat with this object's key is.
    if (path === "/chat-where") {
      if (request.method === "GET") return Response.json((await this.state.storage.get(CHAT_WHERE_KEY)) ?? null);
      const where = chatWhereOf(await request.json());
      if (where === null) return new Response(null, { status: 400 });
      await this.state.storage.put(CHAT_WHERE_KEY, where);
      return Response.json({ ok: true });
    }
    // A background job's own object is started here, and reports to its chat's inbox here (`jobs.ts`).
    if (path === "/job-start") {
      const run = (await request.json()) as JobRun;
      const flow = this.env.JOB_RUN;
      await acceptJob(this.state.storage, run, Date.now(), flow ? () => startJobFlow(flow, run.id) : undefined);
      return Response.json({ ok: true });
    }
    // The job's workflow runs each pass here, and ends it here when every try failed (`jobWorkflow.ts`).
    if (path === "/job-pass") return Response.json({ next: await runJob(this.state.storage, this.jobDeps()) });
    if (path === "/job-failed") return Response.json({ next: await failJob(this.state.storage, this.jobDeps()) });
    if (path === "/job-steer") {
      const steer = readJobSteer(await request.json());
      if (steer === null) return new Response(null, { status: 400 });
      return Response.json({ taken: await steerJob(this.state.storage, steer) });
    }
    if (path === "/job-update") {
      const update = readJobUpdate(await request.json());
      if (update === null) return new Response(null, { status: 400 });
      return Response.json({ known: await jobUpdate(this.state.storage, this.deps(), update) });
    }
    if (path === "/react") {
      const inbound = (await request.json()) as Extract<Inbound, { kind: "reaction" }>;
      return Response.json({ outcome: await react(this.state.storage, inbound, Date.now()) });
    }
    if (path.startsWith("/media/")) {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      return serveMedia(this.state.storage, path.slice("/media/".length), Date.now());
    }
    await this.keepOrigin(request);
    const message = (await request.json()) as Message;
    const outcome = await accept(this.state.storage, message, Date.now());
    return Response.json({ outcome });
  }

  async alarm(): Promise<void> {
    // A group's object has only `gpending:` keys, a phone's only `pending:`; each drain finds the other's empty.
    await drainGroup(this.state.storage, this.deps());
    await drain(this.state.storage, this.deps());
    await checkReady(this.state.storage, this.deps());
    await checkGmail(this.state.storage, this.deps());
    await carryOnAfterSave(this.state.storage, this.deps());
    // A chat quiet long enough has its conversation scored (`reviewWatch.ts`).
    await checkReview(this.state.storage, { ...this.deps(), mintGroup: (message, people) => this.mintGroup(message, people) });
    // A job's object has only `jobrun`; every other object finds nothing to run. With Workflows, an alarm
    // set before they ran jobs (one release) hands its job to its workflow and sets no alarm of its own.
    const flow = this.env.JOB_RUN;
    if (!(flow && (await handOverJob(this.state.storage, flow)))) {
      await armJobNext(this.state.storage, await runJob(this.state.storage, this.jobDeps()), Date.now());
    }
  }

  private jobDeps() {
    return { ...this.deps(), report: (inbox: string, update: JobUpdate) => this.reportJob(inbox, update) };
  }

  /** A group's token for its review, minted as a tagged turn's is; null unless the chat is ready. */
  private async mintGroup(message: GroupMessage, people: string[]) {
    const asked = await askControlPlane(this.deps(), message, people, null);
    if (asked.status !== "ready" || asked.accessToken === undefined) return null;
    return { accessToken: asked.accessToken, ...(asked.handle ? { handle: asked.handle } : {}), names: asked.names ?? [] };
  }

  /** A job's word to the inbox it belongs to: taken once it answers 200. */
  private async reportJob(inbox: string, update: JobUpdate): Promise<boolean> {
    const stub = this.env.SENDER_INBOX.get(this.env.SENDER_INBOX.idFromName(inbox));
    const response = await stub.fetch("https://inbox/job-update", { method: "POST", body: JSON.stringify(update) });
    return response.ok;
  }

  /** Tell the chat's directory entry where this chat is, once, so its routines can find it (`groupRoutines.ts`). */
  private async keepWhere(message: GroupMessage): Promise<void> {
    if (message.sms || (await this.state.storage.get(WHERE_KEPT_KEY)) !== undefined) return;
    const key = await sha256Hex(`${message.line}:${message.groupId}`);
    const directory = this.env.SENDER_INBOX.get(this.env.SENDER_INBOX.idFromName(chatDirectoryName(key)));
    const where = { line: message.line, groupId: message.groupId };
    const response = await directory.fetch("https://inbox/chat-where", { method: "POST", body: JSON.stringify(where) });
    if (response.ok) await this.state.storage.put(WHERE_KEPT_KEY, true);
  }

  /** The Worker's own address, kept for pictures served back to Sendblue (`media.ts`). */
  private async keepOrigin(request: Request): Promise<void> {
    const origin = workerOrigin(new URL(request.url).searchParams.get("origin"));
    if (origin !== null && (await this.state.storage.get<string>(ORIGIN_KEY)) !== origin) {
      await this.state.storage.put(ORIGIN_KEY, origin);
    }
  }

  private deps(): InboxDeps & { startTurn?: (turn: string) => Promise<void> } {
    const workflow = this.env.GROUP_TURN;
    return {
      ...(workflow ? { startTurn: (turn: string) => startGroupTurn(workflow, this.state.id.toString(), turn) } : {}),
      fetch: (input, init) => fetch(input, init),
      controlPlaneOrigin: this.env.CONTROL_PLANE_ORIGIN,
      workerSecret: this.env.AGENT_WORKER_SECRET,
      gatewayOrigin: this.env.GATEWAY_ORIGIN,
      linqApiKey: this.env.LINQ_API_KEY,
      sendblue: sendblueKeys(this.env.SENDBLUE_API_KEY_ID, this.env.SENDBLUE_API_SECRET),
      whapi: whapiKeys(this.env.WHAPI_TOKEN, this.env.WHAPI_LINE),
      appCard: appCardConfig(this.env),
      noteCardPicture: noteCardDrawer((input, init) => fetch(input, init), this.env.CONTROL_PLANE_ORIGIN, this.env.AGENT_WORKER_SECRET),
      hostPicture: async (picture: Picture) =>
        hostPicture(
          this.state.storage,
          await this.state.storage.get<string>(ORIGIN_KEY),
          this.state.id.toString(),
          picture,
          Date.now(),
        ),
      images: this.env.IMAGES,
      now: () => Date.now(),
      spawnJob: async (id: string, run: JobRun) => {
        const stub = this.env.SENDER_INBOX.get(this.env.SENDER_INBOX.idFromName(`job:${id}`));
        const response = await stub.fetch("https://inbox/job-start", { method: "POST", body: JSON.stringify(run) });
        if (!response.ok) throw new Error("job not started");
      },
      steerJob: async (id: string, steer: JobSteer) => {
        const stub = this.env.SENDER_INBOX.get(this.env.SENDER_INBOX.idFromName(`job:${id}`));
        const response = await stub.fetch("https://inbox/job-steer", { method: "POST", body: JSON.stringify(steer) });
        return response.ok && ((await response.json()) as { taken?: unknown }).taken === true;
      },
    };
  }
}

/** Start the workflow for one group turn; one already started under this id counts as started. */
async function startGroupTurn(workflow: Workflow<GroupTurnParams>, inbox: string, turn: string): Promise<void> {
  try {
    await workflow.create({ id: turn, params: { inbox, turn } });
  } catch (error) {
    await workflow.get(turn).catch(() => {
      throw error;
    });
  }
}
