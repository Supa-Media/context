import { Refused, verify, githubKeys, type KeySource } from "../../tex-eval/src/oidc";
import { GitHubFailed, labelFor, register, remove, status, type Fetch } from "./github";

/** Who this service is, as a workflow names it when it asks GitHub for a token. */
export const AUDIENCE = "context-tex-runner";
/** How long a runner may wait to come online before the run goes to GitHub's runners instead. */
export const ONLINE_WITHIN_MS = 150_000;
const POLL_MS = 5_000;

export interface Runners {
  /** Starts the container for this label with its configuration; false when one is already running there. */
  start(label: string, runnerId: number, jitconfig: string): Promise<boolean>;
  stop(label: string): Promise<void>;
}

export interface Deps {
  token: string | undefined;
  runners: Runners;
  keys?: KeySource;
  fetcher?: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const log = (record: Record<string, unknown>) => console.log(JSON.stringify({ event: "tex_runner", ...record }));

/**
 * POST /v1/start: main's tex-lab-run.yml, by its OIDC token, asks for one runner for its run's `run` job. The answer
 * is the label that job runs on, once the runner is online; anything else is a refusal the workflow answers by running
 * the job on GitHub's runners, as before.
 */
export async function handle(request: Request, deps: Deps): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path !== "/v1/start") return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let claims;
  try {
    claims = await verify(request.headers.get("authorization"), "lab-runner", deps.keys ?? githubKeys, (deps.now ?? Date.now)(), AUDIENCE);
  } catch (error) {
    if (error instanceof Refused) return json({ error: error.message }, 401);
    throw error;
  }
  if (!deps.token) return json({ error: "this runner has no GitHub token" }, 503);
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  let label: string;
  try {
    label = labelFor(String(claims.run_id), String(claims.run_attempt ?? "1"));
  } catch {
    return json({ error: "no run named" }, 400);
  }
  let runner;
  try {
    runner = await register(deps.token, label, fetcher);
  } catch (error) {
    log({ label, outcome: "not_registered", why: error instanceof GitHubFailed ? error.message : "unknown" });
    return json({ error: error instanceof GitHubFailed ? error.message : "GitHub could not be reached" }, 502);
  }
  const fresh = await deps.runners.start(label, runner.id, runner.jitconfig);
  if (!fresh) {
    await remove(deps.token, runner.id, fetcher).catch(() => undefined);
    log({ label, outcome: "already_running" });
    return json({ error: "this run already has a runner" }, 409);
  }
  while (now() - started < ONLINE_WITHIN_MS) {
    const seen = await status(deps.token, runner.id, fetcher).catch(() => "offline" as const);
    if (seen === "online") {
      log({ label, outcome: "online", ms: now() - started });
      return json({ label });
    }
    await sleep(POLL_MS);
  }
  await deps.runners.stop(label).catch(() => undefined);
  await remove(deps.token, runner.id, fetcher).catch(() => undefined);
  log({ label, outcome: "not_online", ms: now() - started });
  return json({ error: "the runner did not come online" }, 504);
}
