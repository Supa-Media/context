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
import { readProductionSetup } from "./production.js";
import { searchSettingsOf } from "../search/settings.js";
import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { BUILTIN_PROVIDER, builtinModel, canRunBuiltin } from "./builtin.js";
import { aiGatewayConfig } from "./aiGateway.js";
import { computerFor, webSession } from "./computer.js";
import { searcherFor } from "./search.js";
import { decisionEngine } from "./decide.js";
import { ProviderError } from "./providers.js";
import { toolsForSession } from "../tools/advertised.js";
import { appendConversation, conversationPath, historyIsTainted, readConversation } from "./conversation.js";
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
  stopRoutine,
} from "./routine.js";
import { textingAwareCallTool, textingWriteTools } from "./textingWrites.js";
import { LONG_MAX_ROUNDS, LONG_TOOL_BUDGET_MS, progressChannel } from "./progress.js";
import { markUntrusted, newLedger } from "../privacy/egress.js";
import { disarmTexting, listPending, replayAsAsked, settlePending, withdrawPending } from "../tools/approvals.js";

/**
 * What a turn that may not run says. Nothing in the app can change this any
 * more (people's own model keys were deleted, the owner, 2026-10-10): the
 * built-in model answers texts and routines where the control plane allows
 * it, and every
 * other `no_provider` — another client, another plan, the assistant switched
 * off, a deployment with no built-in model, a request naming a provider — is
 * the same sentence, so none of them is told apart from the outside.
 */
const NO_MODEL_HERE = "The assistant isn't available here yet.";

/** The texting assistant's first-party client (`apps/convex/functions/textLinks.ts`). */
const TEXTS_CLIENT_ID = "context_texts";
/** The app's own client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
const CONSOLE_CLIENT_ID = "context_console";

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
 * the request that produced it — the customer's question and their notes.
 */
export async function handleAgent(request, env, store, session, controlPlane, { progress = null } = {}) {
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

  /*
    A TEXTED YES OR NO SETTLES A PENDING APPROVAL BEFORE ANY MODEL RUNS.

    The egress gate (`privacy/egress.js`) held a widening call until the
    person says so, and the person says so here: a text that is nothing but
    yes or no, from the linked phone, is matched by this code and never shown
    to a model. The call then runs through the same dispatcher under this
    session, marked approved, and the result is the reply. Only the texting
    client: a routine's run has no person on the line, and the app approves
    through `/approvals`.
  */
  if (session.actorClientId === TEXTS_CLIENT_ID) {
    const verdict = approvalVerdict(question);
    if (verdict !== null) {
      const settled = await settleByText(store, session, verdict);
      if (settled !== null) return json({ answer: settled, provider: "gateway", model: "none", steps: [] });
    }
    /*
      A text that goes to the model is not the answer to an ask made before it:
      the person has moved on, and a bare "yes" to the model's next question
      must not release a call raised two texts ago. Disarmed here, before the
      model runs, so an ask this turn raises is the only one a yes can reach.
    */
    await disarmTexting(store, { userId: session.actorUserId });
  }

  try {
    await openProvider(controlPlane, session, body.provider, env);
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
          error_description: NO_MODEL_HERE,
        },
        409,
      );
    }
    // A control plane that could not be reached is not a refusal, and telling
    // somebody the assistant is not theirs when it is is worse than telling
    // them nothing.
    return json({ error: "model_unavailable" }, 503);
  }

  const offered = await toolsForSession(session, store);

  /*
    THE EGRESS LEDGER FOR THIS TURN. `/agent` sees a turn whole — the
    question is the person's own words and every tool call passes through
    this gateway — so the gate can ask only when the turn read something the
    new audience could not see (`privacy/egress.js`). An MCP client gets no
    ledger and is always asked.
  */
  const ledger = newLedger();
  /*
    "Seen whole" is a claim about who wrote the question, and only the clients
    that are ours can make it: the texting thread's question is the person's
    own message, the app's panel is their own hand, a routine is their own
    note. Any other connected client could put anything in `question`, so its
    turn is held like its tool calls are.
  */
  const firstParty =
    session.actorClientId === TEXTS_CLIENT_ID ||
    session.actorClientId === CONSOLE_CLIENT_ID ||
    session.actorClientId === ROUTINES_CLIENT_ID;
  session.egress = { complete: firstParty, ledger, texting: session.actorClientId === TEXTS_CLIENT_ID };

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
  // A previous answer written after a read from outside still carries it.
  if (historyIsTainted(history)) markUntrusted(ledger);

  /*
    The computer is the texting assistant's for now (the owner's decision is
    about texting), behind the address guard in `computer.js`. Widening it to
    the app's agent panel is one condition here.
  */
  // Decided by the grant, never by the request body: only the texting client's
  // answers go out as iMessages, and only they are written for one. A
  // routine's answer is a text too, when it says anything.
  const texting = session.actorClientId === TEXTS_CLIENT_ID || runner;
  // A text has the MCP's own write tools (`textingWrites.js`, the owner,
  // 2026-10-08); a routine's own run never may.
  const textingWriting = textingWriteTools(offered, { texting: session.actorClientId === TEXTS_CLIENT_ID });
  const computer = texting ? computerFor(env) : null;
  // Web search is the texting assistant's too, and runs on its own (the
  // owner's decision, 2026-10-07); `search.js` says why that is accepted.
  const search = texting ? searcherFor(env) : null;
  /*
    A long task texts its progress (`progress.js`): only a person's own texted
    turn, asked for as a stream by the texting Worker. A routine runs
    unattended and texts once, so it never gets one.
  */
  const channel =
    typeof progress === "function" && session.actorClientId === TEXTS_CLIENT_ID ? progressChannel(progress) : null;
  // Clef is metered with the turn (`meter` below).
  /*
    AN ADDRESS IS VOUCHED FOR BY THE PERSON, NEVER BY A PREVIOUS ANSWER.

    A texted turn's `question` is the person's own message, so it is both the
    prompt and the allow-list's source. A routine's is not: `routineQuestion`
    frames the note with the schedule and **the last run's answer**, which the
    model wrote. Seeding the guard from it would let a page read on one run
    plant an address in the answer and the next run fetch it — unattended,
    every run — which is the exfiltration `computer.js`'s guard exists to
    prevent, laundered through the bucket. So a routine vouches for the
    addresses in its own body and nothing else. The routine's *path* is not in
    the body either, which keeps `watch.md` from reading as a hostname.
  */
  const vouched = runner ? routine?.body ?? "" : question;
  const opened =
    computer === null && search === null
      ? null
      : webSession(computer, question, {
          decide: decisionEngine(env.AI),
          search,
          addresses: vouched,
        });
  // A page or a search result is text from outside the workspace: once one
  // is read, every widening in this turn asks (`privacy/egress.js`).
  const web =
    opened === null
      ? null
      : {
          tools: opened.tools,
          usage: opened.usage,
          call: (name, args) => {
            markUntrusted(ledger);
            return opened.call(name, args);
          },
        };

  /*
    THE PRODUCTION SETUP (`production.js`): the texting job's file on a texted
    turn, the app job's otherwise. Its prompt replaces the built-in words, and
    its model is used only when this deployment can call it: an uncallable one
    falls back.
  */
  const production = await readProductionSetup(store, session, { texting });
  // The setup's `search:` section, when it has one, over the deployment's
  // settings for this turn's searches, in this context and any it addresses
  // (`openContext` copies the store's settings at open time).
  if (production?.search) store.searchSettings = searchSettingsOf(store, production.search);
  const productionModel =
    production !== null && canRunBuiltin(production.model, env) ? production.model : null;
  const builtinUsed = productionModel ?? builtinModel(env);
  // The setup's router (`router.js`), when this deployment can run both the
  // decision model and the thinking model; otherwise every text runs on `main`.
  const router =
    productionModel !== null && production.router !== null && canRunBuiltin(production.router.think, env)
      ? { decide: decisionEngine(env.AI), think: production.router.think, routeAt: production.router.routeAt }
      : null;
  // The setup's fallback model (`production.js`), when this deployment can call it.
  const fallback =
    productionModel !== null && production.fallback !== null && canRunBuiltin(production.fallback, env) ? production.fallback : null;

  const started = Date.now();
  /*
    The built-in turn was counted when it was allowed; this adds what it spent.
    Counts only, best effort: a meter that could not be reached costs us a
    report, not the person their answer.
  */
  const meter = async (usage, failed, model = builtinUsed) => {
    try {
      await controlPlane.recordBuiltinUsage(session.accessToken, session.workspaceId, {
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        cacheRead: usage?.cacheRead ?? 0,
        cacheWrite: usage?.cacheWrite ?? 0,
        // The model that answered: the router may have sent this text to `think`.
        model: typeof model === "string" ? model : builtinUsed,
        decision: (web?.usage.decision ?? 0) + (usage?.decision ?? 0),
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
      provider: BUILTIN_PROVIDER,
      model: typeof model === "string" ? model : "unknown",
      outcome,
      ms: Date.now() - received,
      modelMs: timing?.modelMs ?? 0,
      toolMs: timing?.toolMs ?? 0,
      rounds: timing?.rounds ?? 0,
      inputTokens: usage?.input ?? 0,
      outputTokens: usage?.output ?? 0,
      trace: Array.isArray(timing?.trace) ? timing.trace.map(wireTraceEntry) : [],
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
      // A turn that edits directly is not also handed proposals: they have no
      // screen on a phone, and two ways to change a note is one too many.
      tools: [
        ...agentTools(offered).filter((tool) => textingWriting.length === 0 || tool.name !== "propose_note"),
        ...textingWriting,
      ],
      /*
        THE ONE DISPATCHER, AND IT IS THE CLIENT'S. Not a copy, not a subset
        assembled here — `callToolForSession` is what an MCP client's tool call
        goes through, including the cross-context routing and every per-call
        scope refusal. An agent that reached past it would be a second authority
        decision with no tests behind it.
      */
      callTool: textingAwareCallTool(
        (name, args) => callToolForSession({ name, arguments: args }, store, session),
        textingWriting,
      ),
      env,
      providerOptions: {
        ai: env.AI,
        gateway: aiGatewayConfig(env),
        // Ids only: what the AI costs tab files this call's spend under.
        metadata: {
          feature: "assistant",
          workspace: String(session.workspaceId),
          client: texting ? "texts" : "app",
          // The setup that answered, when one did: which note a cost is for.
          ...(production !== null ? { setup: production.version } : {}),
        },
      },
      web,
      history,
      texting,
      notes: production !== null ? { prompt: production.prompt } : null,
      builtinModelOverride: productionModel ?? undefined,
      router,
      fallback,
      maxRounds: production?.maxSteps ?? undefined,
      ...(channel !== null ? { progress: channel, roundCap: LONG_MAX_ROUNDS, toolBudgetMs: LONG_TOOL_BUDGET_MS } : {}),
    });
    await afterAnswer(meter(turn.usage, false, turn.model));
    await afterAnswer(logTurn(turn.exhausted ? "exhausted" : "answered", turn.model, turn.timing, turn.usage));

    if (runner) {
      const ran = turn.exhausted ? { outcome: "failed", text: "" } : runOutcome(turn.answer);
      await keepRun(store, routine, runs, ran.outcome, ran.text);
      /*
        A routine that texts the person is a message they may answer with a bare
        "ok" or "yes", and that answer is to it, not to an ask raised before it.
      */
      if (ran.text && routine.settings.send !== "note") await disarmTexting(store, { userId: session.actorUserId });
      // A routine whose `until:` came true stops itself, recoverably.
      if (ran.outcome === "finished") {
        await stopRoutine((name, args) => callToolForSession({ name, arguments: args }, store, session), routine.path);
      }
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

    // The ask goes out in the gateway's own words, after whatever the model
    // said: a person can allow only what they were told about, and the model
    // relaying it is a courtesy rather than the mechanism.
    const answer = ledger.asked.length === 0 ? turn.answer : `${turn.answer}\n\n${askLine(ledger.asked)}`;

    if (conversation !== null && !turn.exhausted) {
      try {
        await appendConversation(store, conversation, history, question, answer, { tainted: ledger.untrusted });
      } catch {
        // The answer is still owed. A history that failed to save costs the
        // next turn some context, not this one its reply.
      }
    }

    return json({
      answer,
      // How many held calls the answer's last line asks about, so a caller that
      // plays the person (the bench) knows a YES is awaited; zero on a clean turn.
      asked: ledger.asked.length,
      provider: turn.provider,
      model: turn.model,
      steps: turn.steps,
      ...(turn.exhausted ? { exhausted: true } : {}),
    });
  } catch (error) {
    await meter(null, true);
    /*
      An ask the person was never told about (the turn failed before its ask
      line went out) is withdrawn: left waiting, it would be released by the
      next bare "yes", which is about something else.
    */
    await withdrawPending(store, { userId: session.actorUserId, ids: ledger.asked.map((asked) => asked.id) }).catch(() => {});
    if (runner) await keepRun(store, routine, runs, "failed", "");
    if (error instanceof ProviderError) {
      await afterAnswer(logTurn("failed", error.model, error.timing, null));
      // Logged for an operator, opaque to the caller. `reason` is a phrase this
      // worker wrote and a status; `builtin.js` and `aiGateway.js` never put a
      // response body in it, because a provider's error body quotes the request.
      console.log(
        JSON.stringify({
          event: "agent_provider_error",
          workspace: session.workspaceId,
          grant: session.grantId,
          provider: BUILTIN_PROVIDER,
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
 * A trace entry as the turn log takes it (`apps/convex/functions/agentTurns.ts`):
 * kinds, names, numbers and flags, never a word the router or a provider
 * wrote. The router's own word (`pick`) and a fallback's `from` stay in this
 * worker's log line; the status a provider answered is a number and goes, as
 * does the router's confidence in a think pick (a number from 0 to 1).
 */
/** The router's confidence as the turn log takes it: 0 to 1, or nothing. A number Clef got wrong never costs the turn its log. */
function confidenceOf(entry) {
  const value = entry.confidence;
  if (typeof value !== "number" || !Number.isFinite(value)) return {};
  return { confidence: Math.min(1, Math.max(0, value)) };
}

function wireTraceEntry(entry) {
  const base = { kind: entry.kind, ok: entry.ok !== false, ms: entry.ms ?? 0 };
  if (entry.kind === "tool") return { ...base, tool: entry.tool, ...(entry.held ? { held: true } : {}) };
  if (entry.kind === "router") return { ...base, tier: entry.tier, model: entry.model, ...confidenceOf(entry) };
  if (entry.kind === "fallback") return { ...base, model: entry.model, ...(typeof entry.status === "number" ? { status: entry.status } : {}) };
  return {
    ...base,
    ...(entry.retried ? { retried: true } : {}),
    ...(typeof entry.status === "number" ? { status: entry.status } : {}),
  };
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

/** A text that is nothing but yes, or nothing but no; anything else goes to the model. */
const YES = /^\s*(?:yes|yes please|yep|yeah|yup|ok|okay|sure|do it|go ahead|go for it|confirm|confirmed|approve|approved|allow|y)\s*[.!]*\s*$/i;
const NO = /^\s*(?:no|nope|no thanks|don'?t|cancel|stop|deny|denied|never ?mind|forget it|drop it|n)\s*[.!]*\s*$/i;

export function approvalVerdict(text) {
  if (typeof text !== "string") return null;
  if (YES.test(text)) return "approve";
  if (NO.test(text)) return "deny";
  return null;
}

/** The line a texted answer ends with when the turn held something for the person. */
export function askLine(asked) {
  const what = asked.map((record) => record.summary).join("; ");
  return `Before I ${asked.length === 1 ? "do that" : "do those"}, I need your OK: ${what}. Reply YES to go ahead, or NO to drop it.`;
}

/**
 * Settle what this thread's latest ask put to the person, as their text said.
 * Returns the reply, or null when nothing was waiting — in which case the text
 * is an ordinary one and the model answers it.
 */
async function settleByText(store, session, verdict) {
  // Only what this thread asked about, lately, and not since moved on from: a
  // yes here never releases a call some other client raised that the person was
  // not told of. Every record left armed was asked in the thread's latest ask,
  // and the ask line named all of them, so one yes answers all of them.
  const waiting = await listPending(store, { userId: session.actorUserId, texting: true });
  if (waiting.length === 0) return null;
  const replies = [];
  for (const { record } of [...waiting].reverse()) {
    const settled = await settlePending(store, record.id, {
      userId: session.actorUserId,
      action: verdict,
      actorScope: session.scope,
      run: (held) =>
        replayAsAsked(store, session, held, (approver) =>
          callToolForSession({ name: held.tool, arguments: held.args }, store, approver),
        ),
    });
    if (settled.status === "denied") {
      replies.push(`OK, dropped: ${record.summary}.`);
      continue;
    }
    if (settled.status !== "approved") continue;
    const text = settled.result?.content?.[0]?.text;
    const said = typeof text === "string" && text.trim() ? text.trim() : "done.";
    // A tool's own text is for a model: an etag, a visibility line. The person
    // texted yes to a one-line summary and gets that summary back (the first
    // Action round, 2026-10-10: "Done: write projects/x.md into @woodshop.
    // written: projects/x.md (etag c2.doc-…) visibility: team" failed every
    // voice line the judge has). What went wrong still says what the tool said.
    replies.push(settled.result?.isError === true ? `I tried to ${record.summary}, but: ${said}` : `Done: ${record.summary}.`);
  }
  return replies.length === 0 ? null : replies.join("\n");
}
