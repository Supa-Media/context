import { WorkerEntrypoint } from "cloudflare:workers";
import { Refused, verify, githubKeys, type Door, type KeySource } from "./oidc";
import type { Attempts, Conversation } from "./rules";
import type { SearchCase, SearchResult } from "./searchRules";
import { TestSet } from "./testSet";

export { TestSet };

/**
 * Tex's eval service (docs/decisions/testing/test-set-service.md). The Test Set's conversations live only in the
 * `TestSet` object here. Two ways in, both through the gateway's service bindings, none from the internet:
 *
 *  - HTTP (`/tex-eval/*` on the gateway, passed here untouched): main's Test Set workflows only, by GitHub OIDC.
 *      GET  /counts             counts, no words (the Lab's ratio bar, the ratio guard in CI)
 *      POST /v1/runs            { pr, sha, base, change? } -> { run, conversations } within the caps, else 429 { error }
 *      POST /v1/runs/result     { run, branch, main } -> { verdict } (pass/fail, counts by node); branch and main are each
 *                               Result[] (one attempt) or Result[][] (attempts, the same count on both sides, at most 5)
 *      POST /v1/seed            { conversations } -> { kept, skipped } (the held-out cases moved in; never overwrites)
 *      GET  /search/counts      the Search Test's counts, no words
 *      POST /v1/search/runs     { pr, sha, base, change? } -> { run, cases } within the caps, else 429 { error }
 *      POST /v1/search/runs/result  { run, branch: SearchResult[], main: SearchResult[] } -> { verdict } (search-run door)
 *      POST /v1/search/seed     { cases } -> { kept, skipped, counts } (search-seed door; never overwrites)
 *  - `PeopleDoor` (RPC): the Lab's people, checked by the gateway (the app's own client, an @context-lc editor).
 */

export interface Env {
  TEST_SET: DurableObjectNamespace<TestSet>;
  /** "off" on staging: no workflow runs there, so its HTTP doors answer nothing but counts. */
  RUNS?: string;
}

const one = (env: Env) => env.TEST_SET.get(env.TEST_SET.idFromName("test-set"));
/** Which GitHub workflow door each HTTP path takes. */
const DOORS = new Map<string, Door>([
  ["/v1/runs", "run"],
  ["/v1/runs/result", "run"],
  ["/v1/seed", "seed"],
  ["/v1/search/runs", "search-run"],
  ["/v1/search/runs/result", "search-run"],
  ["/v1/search/seed", "search-seed"],
]);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

async function body<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

/** The HTTP side, with GitHub's keys passed in so tests can sign their own. */
export async function handle(request: Request, env: Env, keys: KeySource = githubKeys): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/^\/tex-eval(?=\/)/, "");
  if (path === "/counts" && request.method === "GET") return json(await one(env).counts());
  if (path === "/search/counts" && request.method === "GET") return json(await one(env).searchCounts());
  const door = DOORS.get(path);
  if (!door) return json({ error: "not_found" }, 404);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (env.RUNS === "off") return json({ error: "this deployment runs no Test Set" }, 404);
  let claims;
  try {
    claims = await verify(request.headers.get("authorization"), door, keys);
  } catch (error) {
    if (error instanceof Refused) return json({ error: error.message }, 401);
    throw error;
  }
  const ghRun = String(claims.run_id);
  const actor = typeof claims.actor === "string" ? claims.actor : undefined;
  if (path === "/v1/search/runs") {
    const b = await body<{ pr?: number; sha?: string; base?: string; change?: string }>(request);
    const started = await one(env).startSearchRun({ pr: Number(b?.pr), sha: String(b?.sha ?? ""), base: String(b?.base ?? ""), change: typeof b?.change === "string" ? b.change : undefined, ghRun, actor });
    return started.ok ? json({ run: started.run, cases: started.cases }) : json({ error: started.why }, 429);
  }
  if (path === "/v1/search/runs/result") {
    const b = await body<{ run?: string; branch?: SearchResult[]; main?: SearchResult[] }>(request);
    const done = await one(env).finishSearchRun(String(b?.run ?? ""), ghRun, b?.branch ?? [], b?.main ?? []);
    return done.ok ? json({ verdict: done.verdict }) : json({ error: done.why }, 404);
  }
  if (path === "/v1/search/seed") {
    const b = await body<{ cases?: unknown[] }>(request);
    return json(await one(env).seedSearch(b?.cases ?? [], ghRun));
  }
  if (path === "/v1/runs") {
    const b = await body<{ pr?: number; sha?: string; base?: string; change?: string }>(request);
    const started = await one(env).startRun({ pr: Number(b?.pr), sha: String(b?.sha ?? ""), base: String(b?.base ?? ""), change: typeof b?.change === "string" ? b.change : undefined, ghRun, actor });
    return started.ok ? json({ run: started.run, conversations: started.conversations }) : json({ error: started.why }, 429);
  }
  if (path === "/v1/runs/result") {
    const b = await body<{ run?: string; branch?: Attempts; main?: Attempts }>(request);
    const done = await one(env).finishRun(String(b?.run ?? ""), ghRun, b?.branch ?? [], b?.main ?? []);
    if (done.ok) return json({ verdict: done.verdict });
    return json({ error: done.why }, /attempts/.test(done.why) ? 400 : 404);
  }
  const b = await body<{ conversations?: Conversation[] }>(request);
  return json(await one(env).seed(b?.conversations ?? [], ghRun));
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
} satisfies ExportedHandler<Env>;

/**
 * The Lab's people. Reachable only through the gateway's `TEX_EVAL` binding, which answers only the app's own
 * client for someone who edits @context-lc (`apps/mcp/src/http/texTestSet.js`); `who` is their user id, for audit.
 */
export class PeopleDoor extends WorkerEntrypoint<Env> {
  list() {
    return one(this.env).list();
  }
  get(id: string) {
    return one(this.env).get(String(id));
  }
  put(conversation: Conversation, who: string) {
    return one(this.env).put(conversation, String(who));
  }
  remove(id: string, who: string) {
    return one(this.env).remove(String(id), String(who));
  }
  allow(pr: number, who: string) {
    return one(this.env).allow(Number(pr), String(who));
  }
  searchList() {
    return one(this.env).searchList();
  }
  searchGet(id: string) {
    return one(this.env).searchGet(String(id));
  }
  searchPut(search: SearchCase, who: string) {
    return one(this.env).searchPut(search, String(who));
  }
  searchRemove(id: string, who: string) {
    return one(this.env).searchRemove(String(id), String(who));
  }
  /** Search counts and the last ten search runs: no words. */
  searchSummary() {
    const set = one(this.env);
    return Promise.all([set.searchCounts(), set.searchRuns(10)]).then(([counts, runs]) => ({ counts, runs }));
  }
  /** Counts and runs only: what tex_dev may show an agent. */
  summary() {
    const set = one(this.env);
    return Promise.all([set.counts(), set.runs(10)]).then(([counts, runs]) => ({ counts, runs }));
  }
  runs(limit = 20) {
    return one(this.env).runs(Number(limit));
  }
}
