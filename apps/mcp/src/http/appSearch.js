/**
 * `POST /app/search` — the app's search bar, answered by the same search an AI client's `search_notes` runs
 * (`tools/search.js` `findNotes`): the workspace objects' word and meaning indexes, the same ranking and the same
 * live privacy check, in one list (the search revamp, 2026-11-04: "one search path for the bar and the AIs").
 *
 * Before this, the app asked the control plane, which searched each workspace's search database and Vectorize over
 * HTTP and never the object, so the bar and an assistant answered the same words differently and at different speeds.
 *
 * First-party only, as `/approvals` is: the console's own client, whose grant the control plane mints for a signed-in
 * person. Read only. Nothing about the query is kept or logged.
 *
 *  - Body: `{ query, workspaces?: ["@slug", ...], prefix? }`. `workspaces` narrows to those the person picked; a name
 *    they cannot reach is not searched. Without it, every workspace the person can reach, as for an AI client
 *    with the `everywhere` setting.
 *  - Answer: `{ hits: [{ workspace: "@slug", path, title, snippet, meaningOnly?, loose? }], matchCount,
 *    matchCountIsFloor, incomplete }`, best first.
 */

import { contextNameFor, contextsFor } from "../context/identity.js";
import { normalizePath } from "../notes/paths.js";
import { loadPrivacyState } from "../privacy/state.js";
import { findNotes } from "../tools/search.js";
import { json } from "./responses.js";

export const APP_SEARCH_PATH = "/app/search";

/** The console's client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
const CONSOLE_CLIENT_ID = "context_console";

/** Longest query taken, as `search_notes` is asked in practice; a longer one is refused, not cut. */
const MAX_QUERY = 500;
/** Most workspaces one request may name. */
const MAX_WORKSPACES = 50;

export async function handleAppSearch(request, store, session) {
  if (session.actorClientId !== CONSOLE_CLIENT_ID) {
    return json({ error: "forbidden", error_description: "Only the Context app searches here." }, 403);
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request", error_description: "Expected a JSON body." }, 400);
  }
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  if (query === "" || query.length > MAX_QUERY) return json({ error: "invalid_request", error_description: "query required" }, 400);
  const only = body.workspaces === undefined || body.workspaces === null ? null : body.workspaces;
  if (only !== null && (!Array.isArray(only) || only.length > MAX_WORKSPACES || !only.every((name) => typeof name === "string"))) {
    return json({ error: "invalid_request", error_description: "workspaces is a list of @names" }, 400);
  }
  const prefix = typeof body.prefix === "string" && body.prefix !== "" ? normalizePath(body.prefix) : "";
  if (prefix === null) return json({ error: "invalid_request", error_description: "invalid prefix" }, 400);

  store.contexts = contextsFor(session);
  const privacy = await loadPrivacyState(store);
  // Fail closed, as a tool call does: the app then asks the control plane as before.
  if (privacy.error) return json({ error: "unavailable" }, 503);
  const found = await findNotes(store, session.scope, privacy.rules, privacy.overrides, query, prefix, { only });
  const here = contextNameFor(session);
  return json({
    hits: found.hits.map((hit) => {
      const elsewhere = /^(@[^/]+)\/(.*)$/.exec(hit.key);
      return {
        workspace: elsewhere ? elsewhere[1] : here,
        path: elsewhere ? elsewhere[2] : hit.key,
        title: typeof hit.title === "string" ? hit.title : "",
        snippet: Array.isArray(hit.snippets) && typeof hit.snippets[0] === "string" ? hit.snippets[0] : "",
        ...(hit.meaningOnly ? { meaningOnly: true } : {}),
        ...(hit.loose ? { loose: true } : {}),
      };
    }),
    matchCount: Number(found.matchCount) || 0,
    matchCountIsFloor: found.matchCountIsFloor === true,
    incomplete: found.indexIncomplete === true,
  });
}
