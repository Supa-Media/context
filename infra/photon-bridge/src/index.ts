import { DurableObject } from "cloudflare:workers";
import {
  CHECKPOINT_PREFIX,
  pumpOnce,
  retryDelayMs,
  type AgentEvents,
  type CheckpointStore,
  type Fetchish,
  type Log,
} from "./pump";
import { isBridgeRoute } from "./routes";

interface Env {
  PHOTON_BRIDGE: DurableObjectNamespace<PhotonBridge>;
  /** The agent's PhotonEvents entrypoint (service binding; no URL, no secret). */
  AGENT: AgentEvents;
  PHOTON_PROJECT_ID?: string;
  PHOTON_PROJECT_SECRET?: string;
}

const PORT = 8080;
const ALARM_MS = 60_000;
const INACTIVITY_MS = 30 * 60_000;
const READY_ATTEMPTS = 100;
const READY_STEP_MS = 100;

class Unconfigured extends Error {
  constructor() {
    super("unconfigured");
    this.name = "Unconfigured";
  }
}

const log: Log = (record) => {
  console.log(JSON.stringify(record));
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function json(value: unknown, status: number): Response {
  return Response.json(value, { status });
}

/**
 * Holds the Photon container and its listeners. The container pulls nothing
 * and pushes nothing on its own: this object long-polls it for mapped events,
 * delivers each to the agent, acks it, and stores the contiguous frontier per
 * line here, in Durable Object storage.
 */
export class PhotonBridge extends DurableObject<Env> {
  private live = false;
  private starting?: Promise<void>;
  private pumping?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      if (ctx.container) await ctx.container.setInactivityTimeout(INACTIVITY_MS);
      if (!(await ctx.storage.getAlarm())) await ctx.storage.setAlarm(Date.now() + ALARM_MS);
    });
  }

  private get configured(): boolean {
    return Boolean(this.env.PHOTON_PROJECT_ID && this.env.PHOTON_PROJECT_SECRET);
  }

  private port(): Fetchish {
    return this.ctx.container!.getTcpPort(PORT);
  }

  private store(): CheckpointStore {
    return { put: (key, value) => this.ctx.storage.put(key, value) };
  }

  /** Starts the container if needed, pings it, and sends it the stored frontiers. */
  private ensure(): Promise<void> {
    if (!this.configured) return Promise.reject(new Unconfigured());
    this.starting ??= this.bringUp().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async bringUp(): Promise<void> {
    const container = this.ctx.container!;
    if (this.live && container.running) {
      const ready = await this.port().fetch("http://container/ready").catch(() => undefined);
      if (ready?.ok) return;
    }
    this.live = false;
    if (!container.running) {
      container.start({
        enableInternet: true,
        env: {
          PHOTON_PROJECT_ID: this.env.PHOTON_PROJECT_ID!,
          PHOTON_PROJECT_SECRET: this.env.PHOTON_PROJECT_SECRET!,
        },
      });
    }
    await this.waitReady();
    const response = await this.port().fetch("http://container/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkpoints: await this.checkpoints() }),
    });
    if (!response.ok) throw new Error(`start ${response.status}`);
    this.live = true;
  }

  private async waitReady(): Promise<void> {
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.port().fetch("http://container/ready");
        if (response.ok) return;
      } catch {
        // Not listening yet: the container is still booting.
      }
      await sleep(READY_STEP_MS);
    }
    throw new Error("container not ready");
  }

  private async checkpoints(): Promise<Record<string, number>> {
    const entries = await this.ctx.storage.list<number>({ prefix: CHECKPOINT_PREFIX });
    return Object.fromEntries(
      [...entries].map(([key, value]) => [key.slice(CHECKPOINT_PREFIX.length), value]),
    );
  }

  /** Keeps one delivery loop running; it ends only when the object does. */
  private startPump(): void {
    if (this.pumping || !this.configured) return;
    this.pumping = this.pumpForever().finally(() => {
      this.pumping = undefined;
    });
  }

  private async pumpForever(): Promise<void> {
    let failures = 0;
    for (;;) {
      try {
        await this.ensure();
        await pumpOnce({ port: this.port(), agent: this.env.AGENT, store: this.store(), sleep, log });
        failures = 0;
      } catch (error) {
        this.live = false;
        const delay = retryDelayMs(failures);
        failures += 1;
        log({ event: "pump.error", error: error instanceof Error ? error.name : "unknown", delay_ms: delay });
        await sleep(delay);
      }
    }
  }

  /** Brings the listener up and the loop going; called by the alarm, cron and requests. */
  private async wake(): Promise<void> {
    try {
      await this.ensure();
    } catch (error) {
      log({ event: "wake.failed", error: error instanceof Error ? error.name : "unknown" });
      return;
    }
    this.startPump();
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    await this.wake();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__wake") {
      await this.wake();
      return new Response(null, { status: 204 });
    }
    try {
      await this.ensure();
    } catch (error) {
      if (error instanceof Unconfigured) return json({ ok: false, status: 503, error: "unconfigured" }, 503);
      return json({ ok: false, status: 503, error: "container_unavailable" }, 503);
    }
    this.startPump();
    try {
      const target = new Request(`http://container${url.pathname}${url.search}`, request);
      return await this.port().fetch(target);
    } catch {
      this.live = false;
      return json({ ok: false, status: 503, error: "container_unavailable" }, 503);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!isBridgeRoute(request.method, url.pathname)) return new Response(null, { status: 404 });
    if (!env.PHOTON_PROJECT_ID || !env.PHOTON_PROJECT_SECRET) {
      return json({ ok: false, status: 503, error: "unconfigured" }, 503);
    }
    // Placed in eastern North America like every object of ours (decided by the owner, 2026-11-01).
    const stub = env.PHOTON_BRIDGE.getByName("photon-bridge", { locationHint: "enam" });
    return stub.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.PHOTON_PROJECT_ID || !env.PHOTON_PROJECT_SECRET) return;
    const stub = env.PHOTON_BRIDGE.getByName("photon-bridge", { locationHint: "enam" });
    ctx.waitUntil(stub.fetch(new Request("https://photon-bridge.internal/__wake", { method: "POST" })));
  },
} satisfies ExportedHandler<Env>;
