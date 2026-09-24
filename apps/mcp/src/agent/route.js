/**
 * `/agent` — one question answered by a model that calls tools through the
 * very dispatcher an MCP client's calls go through (`callToolForSession`).
 */

import { actorFor, contextsFor } from "../context/identity.js";
import {
  AgentRefusal,
  agentTools,
  MAX_QUESTION_LENGTH,
  openProvider,
  runTurn,
} from "./turn.js";
import { callToolForSession } from "../tools/session.js";
import { json } from "../http/responses.js";
import { ProviderError } from "./providers.js";
import { toolsForSession } from "../tools/advertised.js";

/**
 * One agent turn over HTTP.
 *
 * ## Why it is a route here rather than a tool, or a server of its own
 *
 * It is here because it must spend the *same* session, the same scope clamp and
 * the same store as `/mcp`. A second service would need a second answer to "may
 * this caller read that note", and the second answer is the one that drifts —
 * this worker has one privacy engine and one authority decision, and the agent
 * is a caller of them rather than a peer.
 *
 * It is not a tool because a tool is something a *model* invokes, and this is
 * the thing that invokes models.
 *
 * ## What comes back
 *
 * Whole turns, not a stream. A turn that finishes is worth more than a turn
 * that renders prettily, and adding SSE later changes `turn.js` and this
 * function without touching the authority above them. `steps` names the tools
 * that ran, in order, so the app can show what the agent did — names only, no
 * arguments: a path or a query is a fact about what somebody is looking for in
 * their own notes.
 *
 * ## Every refusal is the client's to read, and none of them is a reason
 *
 * A provider that errored is `model_unavailable` with no detail. The reason
 * lives in this deployment's own logs, because a provider's error body quotes
 * the request that produced it — the customer's question, and on some shapes a
 * fragment of the key.
 */
export async function handleAgent(request, env, store, session, controlPlane) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request", error_description: "Expected a JSON body." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid_request", error_description: "Expected a JSON body." }, 400);
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (question.length === 0) {
    return json({ error: "invalid_request", error_description: "Ask a question." }, 400);
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return json(
      {
        error: "invalid_request",
        error_description: `A question is at most ${MAX_QUESTION_LENGTH} characters.`,
      },
      400,
    );
  }

  let credential;
  try {
    credential = await openProvider(controlPlane, session, body.provider);
  } catch (error) {
    if (error instanceof AgentRefusal) {
      return json(
        {
          error: error.code,
          error_description:
            "Connect an Anthropic or OpenAI account in the app, and ask me again.",
        },
        409,
      );
    }
    // A control plane that could not be reached is not a missing provider, and
    // telling somebody to connect an account they already connected is worse
    // than telling them nothing.
    return json({ error: "model_unavailable" }, 503);
  }

  store.actor = actorFor(session);
  store.contexts = contextsFor(session);

  const offered = await toolsForSession(session, store);

  try {
    const turn = await runTurn({
      question,
      place: body.place ?? null,
      credential,
      tools: agentTools(offered),
      /*
        THE ONE DISPATCHER, AND IT IS THE CLIENT'S. Not a copy, not a subset
        assembled here — `callToolForSession` is what an MCP client's tool call
        goes through, including the cross-context routing and every per-call
        scope refusal. An agent that reached past it would be a second authority
        decision with no tests behind it.
      */
      callTool: (name, args) =>
        callToolForSession({ name, arguments: args }, store, session),
      env,
      model: typeof body.model === "string" ? body.model : undefined,
    });

    return json({
      answer: turn.answer,
      provider: turn.provider,
      model: turn.model,
      steps: turn.steps,
      ...(turn.exhausted ? { exhausted: true } : {}),
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      // Logged for an operator, opaque to the caller. `reason` is a phrase this
      // worker wrote and a status; `providers.js` never puts a response body in
      // it, for the reason its `readJson` gives.
      console.log(
        JSON.stringify({
          event: "agent_provider_error",
          workspace: session.workspaceId,
          grant: session.grantId,
          provider: credential.provider,
          reason: error.reason,
          status: error.status,
        }),
      );
      return json({ error: "model_unavailable" }, 502);
    }
    throw error;
  }
}
