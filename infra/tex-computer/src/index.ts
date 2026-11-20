/**
 * TEX'S OWN COMPUTER (Dev2 picked Cloudflare Sandbox, 2026-11-20; docs/decisions/texting-assistant/computer.md).
 *
 * One Linux container per person or group chat, each behind its own Durable Object (`TexComputer`), named by the
 * owner tag the gateway makes (`routes.ts`). The gateway reaches this Worker only through a service binding: it has
 * no route and no workers.dev address, so it holds no secret. A request wakes the computer if it sleeps; it goes back
 * to sleep, and its disk is wiped, after ten minutes with no request (`setInactivityTimeout`).
 *
 * The container has no internet (`enableInternet: false`). Tex's web guard (`apps/mcp/src/agent/computer.js`) lets a
 * turn open only addresses the person gave or a page it opened showed, so what it read can never leave in an address
 * it chose. A shell with the internet would let a command carry what Tex read anywhere, so the computer gets none:
 * the browser stays the web's way in, behind that guard.
 */
import { DurableObject } from "cloudflare:workers";
import { objectName, parseAsk, type Op } from "./routes";

interface Env {
  TEX_COMPUTER: DurableObjectNamespace<TexComputer>;
}

const PORT = 8080;
/** Asleep after this long with no request: the container stops and its disk goes. */
export const IDLE_MS = 10 * 60_000;
const READY_TRIES = 150;
const READY_STEP_MS = 100;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const json = (value: unknown, status = 200) => Response.json(value, { status });
const log = (record: Record<string, unknown>) => console.log(JSON.stringify(record));

export class TexComputer extends DurableObject<Env> {
  private waking?: Promise<boolean>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      if (ctx.container) await ctx.container.setInactivityTimeout(IDLE_MS);
    });
  }

  private port() {
    return this.ctx.container!.getTcpPort(PORT);
  }

  /** Starts the container when it sleeps and waits until it answers; true when it was asleep. */
  private wake(): Promise<boolean> {
    this.waking ??= this.bringUp().finally(() => {
      this.waking = undefined;
    });
    return this.waking;
  }

  private async bringUp(): Promise<boolean> {
    const container = this.ctx.container;
    if (!container) throw new Error("no container on this object");
    const asleep = !container.running;
    if (asleep) container.start({ enableInternet: false });
    for (let i = 0; i < READY_TRIES; i++) {
      const ready = await this.port().fetch("http://computer/health").catch(() => undefined);
      if (ready?.ok) return asleep;
      await sleep(READY_STEP_MS);
    }
    throw new Error("the computer did not start");
  }

  /** One operation, as the gateway asked it (`routes.ts` checked it). */
  async ask(op: Op, input: Record<string, unknown>): Promise<{ status: number; value: Record<string, unknown> }> {
    const started = Date.now();
    if (op === "stop") {
      const running = this.ctx.container?.running === true;
      if (running) await this.ctx.container!.destroy();
      log({ event: "tex_computer", op, outcome: "ok", stopped: running });
      return { status: 200, value: { ok: true, stopped: running } };
    }
    let woke: boolean;
    try {
      woke = await this.wake();
    } catch {
      log({ event: "tex_computer", op, outcome: "no_start", ms: Date.now() - started });
      return { status: 503, value: { ok: false, error: "the computer did not start; try again shortly" } };
    }
    const response = await this.port()
      .fetch(`http://computer/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })
      .catch(() => undefined);
    const value = response ? ((await response.json().catch(() => null)) as Record<string, unknown> | null) : null;
    const status = response?.status ?? 502;
    log({ event: "tex_computer", op, outcome: response?.ok ? "ok" : "failed", status, woke, ms: Date.now() - started });
    return { status, value: { ...(value ?? { ok: false, error: "the computer did not answer" }), woke, ms: Date.now() - started } };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    const asked = parseAsk(request.method, url.pathname, body);
    if ("error" in asked) return json({ ok: false, error: asked.error }, asked.status);
    const stub = env.TEX_COMPUTER.get(env.TEX_COMPUTER.idFromName(objectName(asked.owner)), { locationHint: "enam" });
    const { status, value } = await stub.ask(asked.op, asked.input);
    return json(value, status);
  },
} satisfies ExportedHandler<Env>;
