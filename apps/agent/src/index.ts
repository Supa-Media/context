/**
 * context-agent: the Worker behind Tex, the texting assistant.
 *
 *     Sendblue ──POST /sendblue──▶ this Worker ──▶ SenderInbox (one per phone number)
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

import { parseInbound } from "./inbound";
import { accept, drain, type InboxDeps } from "./inbox";
import { checkReady } from "./ready";
import type { Message } from "./reply";
import { runDueRoutines, textRoutine, type PhoneTexted } from "./routines";
import { runDueDreams } from "./dreams";
import { runDueHeartbeats } from "./heartbeats";
import { runDueHousekeeping } from "./housekeeping";
import type { Picture } from "./line";
import { hostPicture, OBJECT_ID, ORIGIN_KEY, serveMedia, workerOrigin } from "./media";
import { bearerMatches, parseTellRequest, tellEveryone, tellNewLine, type Told } from "./newLine";
import { parseSendblueInbound, repliedToText, sendblueKeys, verifySendblueSecret } from "./sendblue";
import { verifyLinqSignature } from "./signature";
import { handleSimulator, SIMULATOR_PATH, simulatorEnabled, simulatorInbox } from "./simulator";
import { SIMULATOR_PAGE } from "./simulatorPage";

export interface Env {
  SENDER_INBOX: DurableObjectNamespace;
  /** Linq's `whsec_…` webhook signing secret. */
  LINQ_WEBHOOK_SECRET: string;
  /** Linq Partner API key, used to send replies. */
  LINQ_API_KEY: string;
  /** Sendblue's API key id and secret, used to send replies on Tex's dedicated line. */
  SENDBLUE_API_KEY_ID?: string;
  SENDBLUE_API_SECRET?: string;
  /** The secret set on Sendblue's receive webhook; it arrives verbatim in `sb-signing-secret`. */
  SENDBLUE_WEBHOOK_SECRET?: string;
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
    workerSecret: set(env.AGENT_WORKER_SECRET),
    controlPlane: set(env.CONTROL_PLANE_ORIGIN),
    gatewayOrigin: set(env.GATEWAY_ORIGIN) ? env.GATEWAY_ORIGIN : null,
    simulator: simulatorEnabled(env.SIMULATOR),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return Response.json(health(env));
    if (url.pathname === SIMULATOR_PATH || url.pathname.startsWith(`${SIMULATOR_PATH}/`)) {
      if (!simulatorEnabled(env.SIMULATOR)) return new Response(null, { status: 404 });
      return handleSimulator(request, env, SIMULATOR_PAGE);
    }
    if (url.pathname.startsWith("/media/")) return media(request, env, url);
    if (url.pathname === "/new-line") return newLine(request, env);
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

    // An inline reply carries the words it answers, read from Sendblue now, before it waits in the queue.
    // It is answered inside the same thread, and the turn is told it was a reply even when the words can't be read.
    const { replyTo, ...message } = inbound;
    const keys = sendblueKeys(env.SENDBLUE_API_KEY_ID, env.SENDBLUE_API_SECRET);
    if (replyTo !== undefined) {
      message.threaded = true;
      const quoted = keys === null ? null : await repliedToText((input, init) => fetch(input, init), keys, replyTo, message.chatId);
      if (quoted !== null) message.quoted = quoted;
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
function logWebhook(line: "linq" | "sendblue", outcome: "unsigned" | "invalid" | "ignored" | "accepted", reason?: string): void {
  console.log(JSON.stringify({ event: `${line}_webhook`, outcome, ...(reason ? { reason } : {}) }));
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
        now: () => Date.now(),
      });
      return Response.json({ told });
    }
    if (path.startsWith("/media/")) {
      if (request.method !== "GET") return new Response(null, { status: 405 });
      return serveMedia(this.state.storage, path.slice("/media/".length), Date.now());
    }
    const origin = workerOrigin(new URL(request.url).searchParams.get("origin"));
    if (origin !== null && (await this.state.storage.get<string>(ORIGIN_KEY)) !== origin) {
      await this.state.storage.put(ORIGIN_KEY, origin);
    }
    const message = (await request.json()) as Message;
    const outcome = await accept(this.state.storage, message, Date.now());
    return Response.json({ outcome });
  }

  async alarm(): Promise<void> {
    await drain(this.state.storage, this.deps());
    await checkReady(this.state.storage, this.deps());
  }

  private deps(): InboxDeps {
    return {
      fetch: (input, init) => fetch(input, init),
      controlPlaneOrigin: this.env.CONTROL_PLANE_ORIGIN,
      workerSecret: this.env.AGENT_WORKER_SECRET,
      gatewayOrigin: this.env.GATEWAY_ORIGIN,
      linqApiKey: this.env.LINQ_API_KEY,
      sendblue: sendblueKeys(this.env.SENDBLUE_API_KEY_ID, this.env.SENDBLUE_API_SECRET),
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
    };
  }
}
