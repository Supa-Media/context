/**
 * THE LAB'S RUNNER (Dev, 2026-11-28: the evals move off GitHub's runners into a Cloudflare Sandbox;
 * docs/decisions/testing/lab-runner.md).
 *
 * The long `run` job of tex-lab-run.yml spends nearly all its time waiting on models. Here it runs on a GitHub Actions
 * runner of our own: one container per run (`LabRunner`, named by the run's label), started with GitHub's
 * just-in-time configuration for exactly one job. The workflow, its secrets, its sealing and its artifacts are the
 * same as on GitHub's runners; only where the job runs changes. When the job ends the runner exits and the container
 * stops. A cancelled run asks `/v1/stop` to stop it at once (`release`); otherwise an alarm stops it at the job's own
 * timeout anyway, and removes a runner that never took its job.
 */
import { DurableObject } from "cloudflare:workers";
import { remove } from "./github";
import { handle, type Runners } from "./start";

interface Env {
  LAB_RUNNER: DurableObjectNamespace<LabRunner>;
  GH_RUNNER_TOKEN?: string;
}

/** tex-lab-run.yml's `run` job times out at 180 minutes; the container never outlives it by more than this margin. */
export const DEADLINE_MS = 200 * 60_000;

export class LabRunner extends DurableObject<Env> {
  async start(runnerId: number, jitconfig: string): Promise<boolean> {
    const container = this.ctx.container;
    if (!container) throw new Error("no container on this object");
    if (container.running) return false;
    // A run that was cancelled while its runner was still being asked for stays released: nothing starts after.
    if (await this.ctx.storage.get("released")) return false;
    await container.setInactivityTimeout(DEADLINE_MS);
    container.start({ enableInternet: true, env: { RUNNER_JITCONFIG: jitconfig } });
    await this.ctx.storage.put("runner", runnerId);
    await this.ctx.storage.setAlarm(Date.now() + DEADLINE_MS);
    return true;
  }

  async stop(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }

  /**
   * The run is over (cancelled, or done): stop the container, remove a runner that never took its job, and remember
   * the label is released until the deadline, so a start still in flight for it does not bring the runner back.
   * True when a container was running.
   */
  async release(): Promise<boolean> {
    const running = Boolean(this.ctx.container?.running);
    await this.stop();
    const id = await this.ctx.storage.get<number>("runner");
    if (id && this.env.GH_RUNNER_TOKEN) await remove(this.env.GH_RUNNER_TOKEN, id).catch(() => undefined);
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put("released", true);
    await this.ctx.storage.setAlarm(Date.now() + DEADLINE_MS);
    return running;
  }

  async alarm(): Promise<void> {
    await this.stop();
    const id = await this.ctx.storage.get<number>("runner");
    if (id && this.env.GH_RUNNER_TOKEN) await remove(this.env.GH_RUNNER_TOKEN, id).catch(() => undefined);
    await this.ctx.storage.deleteAll();
  }
}

const runnersOf = (env: Env): Runners => {
  const stub = (label: string) => env.LAB_RUNNER.get(env.LAB_RUNNER.idFromName(label), { locationHint: "enam" });
  return {
    start: (label, runnerId, jitconfig) => stub(label).start(runnerId, jitconfig),
    stop: (label) => stub(label).stop(),
    release: (label) => stub(label).release(),
  };
};

export default {
  fetch: (request: Request, env: Env) => handle(request, { token: env.GH_RUNNER_TOKEN, runners: runnersOf(env) }),
} satisfies ExportedHandler<Env>;
