import { DurableObject } from "cloudflare:workers";
import { forwardContainerLogs, type LogCursor, type ReportedHealth } from "./containerLogs";
import {
  CHECKPOINT_PREFIX,
  Pump,
  retryDelayMs,
  type Parked,
  type ParkStore,
  type AgentEvents,
  type CheckpointStore,
  type Fetchish,
  type Log,
} from "./pump";
import { checkpointWrites } from "./frontiers";
import { lineOn } from "./lineSwitch";
import { isBridgeRoute } from "./routes";
import { shouldRestartContainer } from "../container/readHealth.mjs";
import {
  ALARM_MS,
  containerErrorDetail,
  containerGapDelayMs,
  errorClass,
  isMissingContainer,
  nextAlarmDelay,
  retryWake,
  WAKE_AGAIN_MS,
  type WakeOutcome,
} from "./wake";

interface Env {
  PHOTON_BRIDGE: DurableObjectNamespace<PhotonBridge>;
  /** The agent's PhotonEvents entrypoint (service binding; no URL, no secret). */
  AGENT: AgentEvents;
  PHOTON_PROJECT_ID?: string;
  PHOTON_PROJECT_SECRET?: string;
  /** "off" keeps this deployment off the line (`lineSwitch.ts`); staging sets it. */
  PHOTON_LINE?: string;
}

const PORT = 8080;
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
/** Where the container's log forwarding got to (`forwardLogs`). */
const LOG_CURSOR_KEY = "logcursor";

export class PhotonBridge extends DurableObject<Env> {
  private live = false;
  private starting?: Promise<void>;
  private pumping?: Promise<void>;
  private pump?: Pump;
  private logCursor?: LogCursor;
  private forwarding?: Promise<void>;
  private lastHealth: ReportedHealth | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      if (ctx.container) await ctx.container.setInactivityTimeout(INACTIVITY_MS);
      if (!(await ctx.storage.getAlarm())) await ctx.storage.setAlarm(Date.now() + ALARM_MS);
    });
  }

  private get configured(): boolean {
    return lineOn(this.env);
  }

  private port(): Fetchish {
    return this.ctx.container!.getTcpPort(PORT);
  }

  private store(): CheckpointStore {
    return { put: (key, value) => this.ctx.storage.put(key, value) };
  }

  private parkStore(): ParkStore {
    return {
      put: (key, value) => this.ctx.storage.put(key, value),
      list: (prefix) => this.ctx.storage.list<Parked>({ prefix }),
      delete: (key) => this.ctx.storage.delete(key),
    };
  }

  /** The delivery loop's state (the chats being retried), kept for the object's life. */
  private pumpState(): Pump {
    this.pump ??= new Pump({
      port: { fetch: (input, init) => this.port().fetch(input, init) },
      agent: this.env.AGENT,
      store: this.store(),
      parked: this.parkStore(),
      log,
    });
    return this.pump;
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
      this.watchExit(container);
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

  /**
   * One watch per start: when the container exits, its reason goes to the
   * Worker's logs (the container's own stdout is not there). Success or failure only; no message.
   */
  private watchExit(container: NonNullable<DurableObjectState["container"]>): void {
    if (typeof container.monitor !== "function") return;
    container.monitor().then(
      () => log({ event: "container.exited", ok: true }),
      (error: unknown) => {
        const detail = containerErrorDetail(error);
        log({ event: "container.exited", ok: false, error: errorClass(error), ...(detail ? { detail } : {}) });
      },
    );
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
    while (this.configured) {
      try {
        await this.ensure();
        const pump = this.pumpState();
        const outcome = await pump.step();
        if (outcome === "blocked") await sleep(Math.max(pump.waitMs(), 250));
        failures = 0;
      } catch (error) {
        this.live = false;
        const missing = isMissingContainer(error);
        const delay = missing ? containerGapDelayMs(failures) : retryDelayMs(failures);
        failures += 1;
        const detail = containerErrorDetail(error);
        log({ event: "pump.error", error: errorClass(error), ...(detail ? { detail } : {}), delay_ms: delay });
        if (missing) await this.pullAlarmForward();
        await sleep(delay);
      }
    }
  }

  /**
   * Brings the listener up and the loop going; called by the alarm, cron and requests.
   * `watch` is false when this wake is the restart itself, so a container that is
   * still stale cannot restart again inside the same alarm.
   */
  private async wake(watch = true): Promise<WakeOutcome> {
    let outcome: WakeOutcome;
    try {
      outcome = await retryWake(() => this.ensure(), {
        sleep,
        log,
        isFatal: (error) => error instanceof Unconfigured,
      });
    } catch (error) {
      if (error instanceof Unconfigured) return "down";
      throw error;
    }
    if (outcome !== "up") return outcome;
    this.startPump();
    await this.forwardLogs();
    if (watch) await this.watchdog();
    return "up";
  }

  /** The next alarm was a minute away. A missing container should not wait that out. */
  private async pullAlarmForward(): Promise<void> {
    const sooner = Date.now() + WAKE_AGAIN_MS;
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > sooner) await this.ctx.storage.setAlarm(sooner);
  }

  /**
   * The container says it is up, and no Photon read has succeeded for three
   * minutes. Start it again. A process that only answers `/health` is how
   * the 2026-11-17 stall stayed invisible.
   */
  private async watchdog(): Promise<void> {
    if (!shouldRestartContainer(this.lastHealth)) return;
    log({ event: "bridge.watchdog", read: this.lastHealth?.read, read_age_ms: this.lastHealth?.readAgeMs ?? null, action: "restart" });
    this.live = false;
    this.lastHealth = null;
    try {
      if (this.ctx.container?.running) await this.ctx.container.destroy();
    } catch (error) {
      const detail = containerErrorDetail(error);
      log({ event: "bridge.watchdog", ok: false, error: errorClass(error), ...(detail ? { detail } : {}) });
    }
    const outcome = await this.wake(false);
    if (outcome === "missing") await this.pullAlarmForward();
  }

  /**
   * The container's log lines since the last read, once each: the alarm and the cron wake can land together, and a
   * read already running is joined rather than run again from the same cursor (each line was logged twice, 2026-11-17:
   * 367 send lines for 279 sends). The cursor is stored, so an object that was evicted does not read it all again.
   */
  private forwardLogs(): Promise<void> {
    this.forwarding ??= (async () => {
      const cursor = this.logCursor ?? (await this.ctx.storage.get<LogCursor>(LOG_CURSOR_KEY)) ?? { boot: "", next: 0 };
      const forwarded = await forwardContainerLogs(this.port(), cursor, log);
      this.logCursor = forwarded.cursor;
      this.lastHealth = forwarded.health;
      await this.ctx.storage.put(LOG_CURSOR_KEY, this.logCursor);
      await this.storeFrontiers();
    })().finally(() => {
      this.forwarding = undefined;
    });
    return this.forwarding;
  }

  /**
   * Stores the container's frontiers where they are ahead of the stored
   * checkpoints, so a skipped gap or a dropped replay is not replayed after a
   * restart. A checkpoint never moves backwards (`frontiers.ts`).
   */
  private async storeFrontiers(): Promise<void> {
    try {
      const response = await this.port().fetch("http://container/frontiers");
      if (!response.ok) throw new Error(`frontiers ${response.status}`);
      const body = (await response.json()) as { checkpoints?: unknown };
      const writes = checkpointWrites(await this.checkpoints(), body.checkpoints);
      for (const [line, seq] of Object.entries(writes)) {
        await this.ctx.storage.put(`${CHECKPOINT_PREFIX}${line}`, seq);
      }
    } catch (error) {
      log({ event: "bridge.frontiers_failed", error: errorClass(error) });
    }
  }

  async alarm(): Promise<void> {
    if (!this.configured) {
      // Off the line: a container still running from before stops, and the object stops waking itself.
      if (this.ctx.container?.running) {
        await this.ctx.container.destroy();
        log({ event: "bridge.off", ok: true });
      }
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    const outcome = await this.wake();
    const delay = nextAlarmDelay(outcome);
    if (delay !== ALARM_MS) await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__wake") {
      const outcome = await this.wake();
      if (outcome === "missing") await this.pullAlarmForward();
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
    if (!lineOn(env)) return json({ ok: false, status: 503, error: "unconfigured" }, 503);
    // Placed in eastern North America like every object of ours (decided by the owner, 2026-11-01).
    const stub = env.PHOTON_BRIDGE.getByName("photon-bridge", { locationHint: "enam" });
    return stub.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!lineOn(env)) return;
    const stub = env.PHOTON_BRIDGE.getByName("photon-bridge", { locationHint: "enam" });
    ctx.waitUntil(stub.fetch(new Request("https://photon-bridge.internal/__wake", { method: "POST" })));
  },
} satisfies ExportedHandler<Env>;
