/**
 * The Test Set's two doors in the gateway (docs/decisions/testing/test-set-service.md; Dev2, 2026-11-15: the Test
 * Set is people only, "write and read by hand", and the only thing CI gates on). Its conversations live only in the
 * eval service (`infra/tex-eval`), reached by service binding; nothing here keeps or logs a word of them.
 *
 *  - `/tex-test-set`, the Lab's: first-party only. The caller must be the app's own client (`context_console`,
 *    minted by the control plane for a signed-in person and never registrable, as `/approvals` requires), so no MCP
 *    client, tex_dev or agent token reaches it, and the person must edit @context-lc.
 *      GET                 { chats: [{ id, title, kind, members, msgs, stars, labels }], counts, runs }
 *      GET ?id=<id>        { conversation }
 *      POST { put: <conversation> }  checked against Tex's live config (texSets.cjs `check`), set "test" -> { kept, counts }
 *      POST { remove: <id> }          -> { removed, counts }
 *      POST { allow: <pr number> }    one more Test Set run for a pull request past its cap -> { pr, left }
 *    (GET and POST only, the two methods the gateway's CORS answer names.)
 *  - `/tex-eval/*`: passed to the service untouched. It answers counts to anyone, and runs only to main's Test Set
 *    workflow, whose GitHub OIDC token it checks itself (`infra/tex-eval/src/oidc.ts`).
 */

import sets from "../../../../packages/shared/src/texSets.cjs";
import decide from "../../../../packages/shared/src/textDecide.cjs";
import { TEX_CONFIG } from "../agent/texConfig.js";
import { editsPinnedContext } from "../context/identity.js";
import { json } from "./responses.js";

export const TEX_TEST_SET_PATH = "/tex-test-set";
export const TEX_EVAL_PREFIX = "/tex-eval/";
/** The console's client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
const CONSOLE_CLIENT_ID = "context_console";
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const WHY = Object.keys(decide.WHY ?? {});

const refuse = (message) => json({ error: "forbidden", error_description: message }, 403);
const unreachable = () => json({ error: "unavailable", error_description: "The Test Set could not be reached just now." }, 503);

/** The problems with a Test conversation, against the config Tex runs now. */
export function testSetProblems(conversation, config = TEX_CONFIG) {
  if (!conversation || typeof conversation !== "object") return ["not a conversation"];
  if (conversation.set !== "test") return ['only Test conversations are kept here: set must be "test"'];
  return sets.check(conversation, config, { why: WHY });
}

/** `/tex-eval/*`: the service's own HTTP door, through the binding. */
export async function handleTexEval(request, env) {
  if (!env.TEX_EVAL_HTTP) return json({ error: "not_found" }, 404);
  return await env.TEX_EVAL_HTTP.fetch(request);
}

/** `/tex-test-set`, for the Lab's people only. */
export async function handleTexTestSet(request, env, session) {
  if (session.actorClientId !== CONSOLE_CLIENT_ID) return refuse("The Test Set is read and written by people, in the Lab, and never by an AI client.");
  if (!editsPinnedContext(session)) return refuse("The Test Set is for people who edit @context-lc's AI setup.");
  const door = env.TEX_EVAL;
  if (!door) return unreachable();
  const who = String(session.actorUserId ?? "");
  const id = new URL(request.url).searchParams.get("id");
  try {
    if (request.method === "GET") {
      if (id !== null) {
        if (!ID.test(id)) return json({ error: "invalid_request", error_description: "Name a conversation by its id." }, 400);
        const conversation = await door.get(id);
        return conversation ? json({ conversation }) : json({ error: "not_found" }, 404);
      }
      const [listed, runs] = await Promise.all([door.list(), door.runs(20)]);
      return json({ chats: listed.chats, counts: listed.counts, runs });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_request", error_description: "Expected a JSON body." }, 400);
    }
    if (body && "put" in body) {
      const problems = testSetProblems(body.put);
      if (problems.length) return json({ error: "invalid_request", problems }, 400);
      const kept = await door.put(body.put, who);
      return kept.ok ? json({ kept: kept.kept, counts: kept.counts }) : json({ error: "invalid_request", problems: kept.problems }, 400);
    }
    if (body && "remove" in body) {
      if (typeof body.remove !== "string" || !ID.test(body.remove)) return json({ error: "invalid_request", error_description: "Name a conversation by its id." }, 400);
      return json(await door.remove(body.remove, who));
    }
    if (body && "allow" in body) {
      const allowed = await door.allow(Number(body.allow), who);
      return allowed.ok ? json({ pr: allowed.pr, left: allowed.left }) : json({ error: "invalid_request", error_description: allowed.why }, 400);
    }
    return json({ error: "invalid_request", error_description: "Send put, remove or allow." }, 400);
  } catch {
    return unreachable();
  }
}

/** What tex_dev may show an agent: counts and run results, never a word, a title or an id. */
export async function testSetSummary(env) {
  if (!env.TEX_EVAL) return null;
  try {
    const { counts, runs } = await env.TEX_EVAL.summary();
    return {
      counts,
      runs: runs.map((r) => ({ pr: r.pr, sha: r.sha, at: new Date(r.at).toISOString(), pass: r.verdict ? r.verdict.pass : null, total: r.verdict?.total ?? null, right: r.verdict?.right ?? null, main: r.verdict?.main ?? null, byNode: r.verdict?.byNode ?? null })),
    };
  } catch {
    return null;
  }
}
