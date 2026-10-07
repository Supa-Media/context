/**
 * context-agent: the Worker behind the texting assistant (it calls itself "your Context").
 *
 *     Linq ──POST /linq──▶ this Worker ──▶ SenderInbox (one per phone number)
 *                                             │  alarm
 *                                             ▼
 *                     control plane: whose phone is this? → short-lived grant
 *                     gateway /agent: answer with that grant
 *                     Linq: send the reply
 *
 * This Worker decides nothing about who may read what. It proves a webhook
 * came from Linq, and it asks the control plane for the grant of whoever
 * linked the sending phone; the gateway does every access decision with that
 * grant, exactly as it does for any other connected client.
 */

import { parseInbound } from "./inbound";
import { accept, drain, type InboxDeps } from "./inbox";
import type { Message } from "./reply";
import { verifyLinqSignature } from "./signature";
import { handleSimulator, SIMULATOR_PATH, simulatorEnabled, simulatorInbox } from "./simulator";
import { SIMULATOR_PAGE } from "./simulatorPage";

export interface Env {
  SENDER_INBOX: DurableObjectNamespace;
  /** Linq's `whsec_…` webhook signing secret. */
  LINQ_WEBHOOK_SECRET: string;
  /** Linq Partner API key, used to send replies. */
  LINQ_API_KEY: string;
  /** Opens the control plane's /agent-texts/* routes and nothing else. */
  AGENT_WORKER_SECRET: string;
  /** The Convex HTTP origin (…convex.site). */
  CONTROL_PLANE_ORIGIN: string;
  /** The gateway origin, e.g. https://mcp.context.lc */
  GATEWAY_ORIGIN: string;
  /** "on" serves the texts simulator (simulator.ts). Only staging sets it. */
  SIMULATOR?: string;
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
    if (url.pathname !== "/linq") return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405 });

    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return new Response(null, { status: 413 });
    }
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });

    const now = Math.floor(Date.now() / 1000);
    if (!(await verifyLinqSignature(env.LINQ_WEBHOOK_SECRET ?? "", request.headers, raw, now))) {
      return new Response(null, { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return new Response(null, { status: 400 });
    }
    const inbound = parseInbound(payload);
    if (inbound.kind === "invalid") return new Response(null, { status: 400 });
    // Signed, but nothing we act on: 200 so Linq does not retry it.
    if (inbound.kind === "ignored") return new Response(null, { status: 200 });

    const stub = env.SENDER_INBOX.get(env.SENDER_INBOX.idFromName(inbound.from));
    const result = await stub.fetch("https://inbox/accept", {
      method: "POST",
      body: JSON.stringify(inbound),
    });
    return new Response(null, { status: result.ok ? 200 : 503 });
  },
};

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
    const message = (await request.json()) as Message;
    const outcome = await accept(this.state.storage, message, Date.now());
    return Response.json({ outcome });
  }

  async alarm(): Promise<void> {
    await drain(this.state.storage, this.deps());
  }

  private deps(): InboxDeps {
    return {
      fetch: (input, init) => fetch(input, init),
      controlPlaneOrigin: this.env.CONTROL_PLANE_ORIGIN,
      workerSecret: this.env.AGENT_WORKER_SECRET,
      gatewayOrigin: this.env.GATEWAY_ORIGIN,
      linqApiKey: this.env.LINQ_API_KEY,
      now: () => Date.now(),
    };
  }
}
