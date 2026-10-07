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
import { hasScope, SCOPE_WRITE } from "../session.js";
import { BUILTIN_PROVIDER } from "./builtin.js";
import { computerFor, webSession } from "./computer.js";
import { decisionEngine } from "./decide.js";
import { ProviderError } from "./providers.js";
import { toolsForSession } from "../tools/advertised.js";
import { appendConversation, conversationPath, readConversation } from "./conversation.js";
import {
  loadRoutine,
  readRuns,
  recordRun,
  RoutineRefusal,
  ROUTINES_CLIENT_ID,
  routinePathFrom,
  routineQuestion,
  routineTimeZone,
  runOutcome,
} from "./routine.js";

/** The texting assistant's first-party client (`apps/convex/functions/textLinks.ts`). */
const TEXTS_CLIENT_ID = "context_texts";

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
  const received = Date.now();
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request", error_description: "Expected a JSON body." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid_request", error_description: "Expected a JSON body." }, 400);
  }

  /*
    A routine's connection runs routines and nothing else, and nothing else runs
    one: both decided by the grant's client, never by the body. A routine grant
    that answered free questions would be a second texting grant nobody linked.
  */
  const runner = session.actorClientId === ROUTINES_CLIENT_ID;
  if (runner !== (body.routine !== undefined)) {
    return json(
      {
        error: "invalid_request",
        error_description: runner ? "This connection only runs routines." : "Only a routine's own connection runs one.",
      },
      runner ? 400 : 403,
    );
  }

  store.actor = actorFor(session);
  store.contexts = contextsFor(session);

  /*
    The routine is re-read now, before any model is opened, so a paused or
    vanished one costs nobody a turn from their daily allowance.
  */
  let routine = null;
  let runs = [];
  let question = typeof body.question === "string" ? body.question.trim() : "";
  if (runner) {
    try {
      routine = await loadRoutine(
        (name, args) => callToolForSession({ name, arguments: args }, store, session),
        routinePathFrom(body.routine),
      );
    } catch (error) {
      if (!(error instanceof RoutineRefusal)) throw error;
      return json({ error: error.code, error_description: error.message }, error.code === "routine_gone" ? 404 : 400);
    }
    if (routine.settings.paused) return json({ outcome: "paused", skipped: true });
    runs = await readRuns(store, routine.path);
    question = routineQuestion(routine, {
      now: Date.now(),
      timeZone: routineTimeZone(routine.settings, body.routine.timeZone),
      lastRun: runs.findLast((run) => run.outcome === "answered" || run.outcome === "finished"),
    });
  }
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
    credential = await openProvider(controlPlane, session, body.provider, env);
  } catch (error) {
    if (runner) await keepRun(store, routine, runs, error instanceof AgentRefusal ? error.code : "failed", "");
    if (error instanceof AgentRefusal && error.code === "daily_limit") {
      return json(
        { error: "daily_limit", error_description: "That's all the questions for today. Ask me again tomorrow." },
        429,
      );
    }
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

  const offered = await toolsForSession(session, store);

  /*
    A named conversation carries its recent turns into this one. Only a name
    from `conversation.js`'s fixed list, never a path, and only on a grant that
    can write: the history is a file in the bucket, and a read-only grant writes
    nothing, so it gets a turn with no memory rather than a write it does not
    hold. Kept in the default context, the one this grant was approved against.
  */
  const conversation =
    !runner && conversationPath(body.conversation) !== null && hasScope(session, SCOPE_WRITE)
      ? body.conversation
      : null;
  const history = conversation === null ? [] : await readConversation(store, conversation);

  /*
    The computer is the texting assistant's for now (the owner's decision is
    about texting), behind the address guard in `computer.js`. Widening it to
    the app's agent panel is one condition here.
  */
  const builtin = credential.provider === BUILTIN_PROVIDER;
  // Decided by the grant, never by the request body: only the texting client's
  // answers go out as iMessages, and only they are written for one. A
  // routine's answer is a text too, when it says anything.
  const texting = session.actorClientId === TEXTS_CLIENT_ID || runner;
  const computer = texting ? computerFor(env) : null;
  // Clef only on a built-in turn: that is the turn the meter covers.
  const web =
    computer === null ? null : webSession(computer, question, { decide: builtin ? decisionEngine(env.AI) : null });

  const started = Date.now();
  /*
    The built-in turn was counted when it was allowed; this adds what it spent.
    Counts only, best effort: a meter that could not be reached costs us a
    report, not the person their answer.
  */
  const meter = async (usage, failed) => {
    if (!builtin) return;
    try {
      await controlPlane.recordBuiltinUsage(session.accessToken, session.workspaceId, {
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        decision: web?.usage.decision ?? 0,
        failed,
        ms: Date.now() - started,
      });
    } catch {
      // See above.
    }
  };

  /*
    Work that is ours rather than the person's runs after the answer has gone,
    where the host lets it, rather than before.
  */
  const afterAnswer = async (work) => {
    try {
      if (typeof store.defer !== "function") throw new Error("no defer");
      store.defer(work);
    } catch {
      await work;
    }
  };

  /*
    Every turn goes to the turn log (`apps/convex/functions/agentTurns.ts`) and
    to this deployment's logs: where its time went, by model round and tool
    name, so the agent can be audited and made faster. Never text. Best effort
    like the meter: a log that could not be reached costs us a row, not the
    person their answer.
  */
  const logTurn = (outcome, model, timing, usage) => {
    const report = {
      provider: credential.provider,
      model: typeof model === "string" ? model : "unknown",
      outcome,
      ms: Date.now() - received,
      modelMs: timing?.modelMs ?? 0,
      toolMs: timing?.toolMs ?? 0,
      rounds: timing?.rounds ?? 0,
      inputTokens: usage?.input ?? 0,
      outputTokens: usage?.output ?? 0,
      trace: Array.isArray(timing?.trace) ? timing.trace : [],
    };
    console.log(
      JSON.stringify({
        event: "agent_turn",
        workspace: session.workspaceId,
        grant: session.grantId,
        texting,
        ...report,
        trace: undefined,
        tools: report.trace.filter((entry) => entry.kind === "tool").map((entry) => entry.tool),
      }),
    );
    return (async () => {
      try {
        await controlPlane.recordAgentTurn(session.accessToken, session.workspaceId, report);
      } catch {
        // See above.
      }
    })();
  };

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
      providerOptions: builtin ? { ai: env.AI } : undefined,
      web,
      history,
      texting,
    });
    await afterAnswer(meter(turn.usage, false));
    await afterAnswer(logTurn(turn.exhausted ? "exhausted" : "answered", turn.model, turn.timing, turn.usage));

    if (runner) {
      const ran = turn.exhausted ? { outcome: "failed", text: "" } : runOutcome(turn.answer);
      await keepRun(store, routine, runs, ran.outcome, ran.text);
      return json({
        outcome: ran.outcome,
        answer: ran.text,
        skipped: ran.outcome !== "answered" && ran.outcome !== "finished",
        send: routine.settings.send,
        to: routine.settings.to,
        provider: turn.provider,
        model: turn.model,
        steps: turn.steps,
      });
    }

    if (conversation !== null && !turn.exhausted) {
      try {
        await appendConversation(store, conversation, history, question, turn.answer);
      } catch {
        // The answer is still owed. A history that failed to save costs the
        // next turn some context, not this one its reply.
      }
    }

    return json({
      answer: turn.answer,
      provider: turn.provider,
      model: turn.model,
      steps: turn.steps,
      ...(turn.exhausted ? { exhausted: true } : {}),
    });
  } catch (error) {
    await meter(null, true);
    if (runner) await keepRun(store, routine, runs, "failed", "");
    if (error instanceof ProviderError) {
      await afterAnswer(logTurn("failed", error.model, error.timing, null));
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

/**
 * A run goes in the routine's history whatever became of it. Best effort: a
 * history that failed to save costs the next run its "last time", not this
 * one its answer.
 */
async function keepRun(store, routine, runs, outcome, text) {
  try {
    await recordRun(store, routine.path, runs, { at: Date.now(), outcome, text });
  } catch {
    // See above.
  }
}
