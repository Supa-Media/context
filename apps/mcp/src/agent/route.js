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
import { DEFAULT_TIME_ZONE, readTimeZone } from "./localNow.js";
import { readTexNotes } from "./jobs.js";
import { openTranscript } from "./transcript.js";
import { wireTraceEntry } from "./turnLog.js";
import { readProductionSetup, readProductionSkill } from "./production.js";
import { skillSession, withSkills } from "./skills.js";
import { searchSettingsOf } from "../search/settings.js";
import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { BUILTIN_PROVIDER, builtinModel, canRunBuiltin } from "./builtin.js";
import { aiGatewayConfig } from "./aiGateway.js";
import { mailCheckerFor } from "./mailChecker.js";
import { browserOwner } from "./browserProviders.js";
import { texViewerUrl } from "../http/texComputer.js";
import { computerFor, webSession } from "./computer.js";
import { searcherFor } from "./search.js";
import { decisionEngine } from "./decide.js";
import { ProviderError } from "./providers.js";
import { meterEach } from "./modelPlan.js";
import { attachmentsLine, hearVoiceMessages, turnAttachments, withAttachmentImages } from "./attachments.js";
import { grantedToolsFor } from "./sixTools.js";
import {
  SHOWN_HISTORY_TURNS,
  appendConversation,
  conversationPath,
  earlierTextsTool,
  historyIsTainted,
  readConversation,
  shownHistory,
} from "./conversation.js";
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
  finishOnce,
} from "./routine.js";
import { textingAwareCallTool, textingWriteTools } from "./textingWrites.js";
import { delegateSession, withDelegate } from "./delegate.js";
import { NO_MODEL, deliverSupervision, prepareSupervision, withMailAgent } from "./supervise.js";
import { LONG_MAX_ROUNDS, LONG_TOOL_BUDGET_MS, progressChannel } from "./progress.js";
import { markUntrusted, newLedger } from "../privacy/egress.js";
import { transcriptionForwarder } from "../ingestion/transcription.js";
import { outgoingPictures, sentPicturesLine } from "./outgoingPictures.js";
import { disarmTexting, withdrawPending } from "../tools/approvals.js";
import { askedWith, quotedOf } from "./quoted.js";
import { approvalVerdict, settleByText, textedAsk } from "./textedApprovals.js";

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

  // The routine is re-read now, before any model is opened: a paused or vanished one costs no turn.
  // A tool call through the client's own dispatcher, under this session.
  const dispatch = (name, args) => callToolForSession({ name, arguments: args }, store, session);
  let routine = null;
  let runs = [];
  // A delegated job's supervisor (`supervise.js`): what this run is for, decided before any model.
  let supervision = null;
  let question = typeof body.question === "string" ? body.question.trim() : "";
  if (runner) {
    try {
      routine = await loadRoutine(dispatch, routinePathFrom(body.routine));
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
    // A job going well, done or gone costs no model call (`supervise.js`); done or gone stops its supervisor.
    supervision = await prepareSupervision(dispatch, routine, { runs, handle: store.contexts.find((c) => c.current)?.name });
    if (supervision?.skip) {
      const { skip: outcome, answer = "" } = supervision;
      await keepRun(store, routine, runs, outcome, answer || NO_MODEL);
      if (outcome === "finished") await stopRoutine(dispatch, routine.path);
      if (supervision.task) await deliverSupervision(store, dispatch, supervision, { outcome, text: answer }, (work) => deferred(store, work));
      return json({ outcome, answer, skipped: answer === "", send: routine.settings.send, to: routine.settings.to });
    }
    if (supervision !== null) question = supervision.question;
  }
  // What came with the question (`attachments.js`). A routine's run has none.
  const { attachments: sent, refusal } = turnAttachments(body.attachments, runner);
  if (refusal) return json({ error: "invalid_request", error_description: refusal }, 400);
  if (question.length === 0 && sent.length === 0) {
    return json({ error: "invalid_request", error_description: "Ask a question." }, 400);
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return json({ error: "invalid_request", error_description: `A question is at most ${MAX_QUESTION_LENGTH} characters.` }, 400);
  }
  /*
    The words an inline reply answers (`quoted.js`). They are somebody else's
    — the message picked may be one Tex sent, carrying whatever Tex read — so
    they never join `question`, which is what the browser's addresses, the
    outgoing pictures, the sharing judge and the Mail checker all vouch from.
    Only `runTurn` sees the two together, and the quote is marked there.
  */
  const quoted = session.actorClientId === TEXTS_CLIENT_ID ? quotedOf(body.quoted) : "";

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
    const verdict = sent.length > 0 ? null : approvalVerdict(question); // a yes with a photo is about the photo
    if (verdict !== null) {
      const settled = await settleByText(store, session, verdict, question);
      if (settled !== null) {
        // The yes and what it released go in today's transcript too (`transcript.js`), after the reply.
        const noted = openTranscript(dispatch, { now: received, timeZone: readTimeZone(body.timeZone), question }).finish({ answer: settled });
        await deferred(store, noted);
        return json({ answer: settled, provider: "gateway", model: "none", steps: [] });
      }
    }
    /*
      A text that goes to the model is not the answer to an ask made before it:
      the person has moved on, and a bare "yes" to the model's next question
      must not release a call raised two texts ago. Disarmed here, before the
      model runs, so an ask this turn raises is the only one a yes can reach.
    */
    if ((await disarmTexting(store, { userId: session.actorUserId })) > 0) {
      // Still armed, a yes to the model's next question would release it.
      return json({ answer: "I couldn't clear what I asked you before. Reply NO to drop it, then send that again.", provider: "gateway", model: "none", steps: [] });
    }
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
  // Voice messages become their words only now, once the turn is allowed and counted.
  const attachments = await hearVoiceMessages(sent, transcriptionForwarder(env), session.workspaceId);

  const offered = await grantedToolsFor(session, store);

  /*
    THE EGRESS LEDGER FOR THIS TURN. `/agent` sees a turn whole — the
    question is the person's own words and every tool call passes through
    this gateway — so the ledger can say whether it took in anything from
    outside the workspace, and carry the asks it raised (`privacy/egress.js`).
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
  session.egress.turn = runner ? { note: routine?.body ?? "" } : { history, question }; // the sharing judge's

  /*
    The Mail checker reads this thread's texts and nothing else the turn read
    (`mailChecker.js`), so it is made here, from the person's own words, before
    the model runs. Only a texted turn has those words; any other client's
    email waits for the person in the app with no checker in front of it.
  */
  if (session.actorClientId === TEXTS_CLIENT_ID) {
    session.mailChecker = mailCheckerFor({
      history,
      question,
      config: aiGatewayConfig(env),
      metadata: { feature: "mail-checker", workspace: String(session.workspaceId) },
    });
  }

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
  // The person's browser tag lets a later text carry on in the same browser
  // (`browserProviders.js`); it is made from their id, never from the request.
  // A handoff texts their own `/tex/<handle>` page, never the browser's link.
  const computer = texting
    ? computerFor(env, { owner: await browserOwner(env, session.actorUserId), viewer: texViewerUrl(env, session) })
    : null;
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
  // Another agent's mail is someone else's words, like a page (`supervise.js`).
  if (supervision !== null) markUntrusted(ledger);
  const opened =
    computer === null && search === null
      ? null
      : webSession(computer, question, {
          decide: decisionEngine(env.AI),
          search,
          addresses: vouched,
          // A browser handed to the person is texted the moment it exists.
          say: channel !== null ? (text) => channel.say(text) : null,
          // The vault this turn's grant opens, for `fill_login`.
          store,
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
    turn, none otherwise. Its prompt replaces the built-in words, and
    its model is used only when this deployment can call it: an uncallable one
    falls back.
  */
  const production = await readProductionSetup(store, session, { texting });
  // What of the conversation this turn is shown: the setup's `history:`, else the default.
  const shown = shownHistory(history, production?.history ?? SHOWN_HISTORY_TURNS);
  // A previous answer written after a read from outside still carries it.
  if (historyIsTainted(shown)) markUntrusted(ledger);
  if (attachments.length > 0) markUntrusted(ledger); // a forwarded PDF is someone else's words, like a page
  // The rest is read on request, and carries its own mark when it is read.
  const earlier = conversation === null ? [] : [earlierTextsTool(history, () => markUntrusted(ledger))];
  // The setup's `search:` section, when it has one, over the deployment's
  // settings for this turn's searches, in this context and any it addresses
  // (`openContext` copies the store's settings at open time).
  if (production?.search) store.searchSettings = searchSettingsOf(store, production.search);
  // The setup's task skills (`skills.js`), read from the pinned workspace only when asked for.
  // A skill read this turn vouches for its own addresses and backticked values,
  // as the person's message does (`computer.js` `vouch`); nothing else can.
  const skills = skillSession(production?.skills ?? [], (path) => readProductionSkill(store, session, path), {
    onRead: (body) => opened?.vouch(body),
  });
  // A text that can write may hand a sub-project to another agent (`delegate.js`), as the person.
  const home = store.contexts.find((entry) => entry.current)?.name ?? null;
  const delegation =
    session.actorClientId === TEXTS_CLIENT_ID && textingWriting.length > 0 && home !== null
      ? delegateSession(dispatch, {
          handle: home,
          home,
          vouch: (url, message) => opened?.delegated(url, message),
          trusted: () => ledger.untrusted !== true,
          browser: opened?.browser != null,
        })
      : null;
  // The setup's trusted sites (`trustedSites.js`), openable without an address given.
  // With `open_web: yes`, any public https address (owner, 2026-10-11).
  opened?.trust(production?.trustedSites ?? [], { openWeb: production?.openWeb === true });
  const productionModel =
    production !== null && canRunBuiltin(production.model, env) ? production.model : null;
  const builtinUsed = productionModel ?? builtinModel(env);
  // The setup's router (`router.js`), when this deployment can run both the
  // decision model and the thinking model; otherwise every text runs on `main`.
  const router =
    productionModel !== null && production.router !== null && canRunBuiltin(production.router.think, env)
      ? { decide: decisionEngine(env.AI), think: production.router.think, routeAt: production.router.routeAt, thinkRounds: production.router.thinkRounds }
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
  const meter = async (usage, failed, model = builtinUsed, whole = true) => {
    try {
      await controlPlane.recordBuiltinUsage(session.accessToken, session.workspaceId, {
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        cacheRead: usage?.cacheRead ?? 0,
        cacheWrite: usage?.cacheWrite ?? 0,
        // The model that spent this: a planned turn reports each (`modelPlan.js`), its own counts on one.
        model: typeof model === "string" ? model : builtinUsed,
        decision: whole ? (web?.usage.decision ?? 0) + (usage?.decision ?? 0) : 0,
        failed,
        ms: whole ? Date.now() - started : 0,
      });
    } catch {
      // See above.
    }
  };

  // Ours, not the person's: after the answer has gone (`deferred`).
  const afterAnswer = (work) => deferred(store, work);

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

  // Their zone: a routine's own, else the one the texting Worker sent (`localNow.js`).
  const timeZone = runner ? routineTimeZone(routine.settings, body.routine.timeZone) : readTimeZone(body.timeZone) ?? DEFAULT_TIME_ZONE;
  // Today's transcript (`transcript.js`), under a ledger of its own: what it reads, the model never does.
  const unseen = { ...session, egress: { ...session.egress, ledger: newLedger() } };
  Object.defineProperty(unseen, "accessToken", { value: session.accessToken, enumerable: false }); // as `sessionForContext`
  const transcript = texting
    ? openTranscript((name, args) => callToolForSession({ name, arguments: args }, store, unseen), {
        now: received,
        timeZone,
        question,
        attachments,
        routine: runner ? routine.path : null,
      })
    : null;

  // Pictures a texted answer sends back (`outgoingPictures.js`): a text from their phone only.
  const outgoing = outgoingPictures({ enabled: session.actorClientId === TEXTS_CLIENT_ID, question });
  try {
    const turn = await runTurn({
      question: askedWith(question, quoted),
      place: body.place ?? null,
      // A turn that edits directly is not also handed proposals: they have no
      // screen on a phone, and two ways to change a note is one too many.
      tools: [
        ...agentTools(offered).filter((tool) => textingWriting.length === 0 || tool.name !== "propose_note"),
        ...textingWriting,
        ...(skills?.tools ?? []),
        ...(delegation?.tools ?? []),
        ...(supervision?.mail.tools ?? []),
      ],
      // THE ONE DISPATCHER, AND IT IS THE CLIENT'S (`callToolForSession`): its routing and every
      // per-call scope refusal. An agent that reached past it would be a second, untested authority.
      onModel: (model) => void (store.usageModel = model),
      callTool: outgoing.wrap(
        withAttachmentImages(
          attachments,
          withMailAgent(supervision?.mail ?? null, withDelegate(delegation, withSkills(skills, textingAwareCallTool(dispatch, textingWriting)))),
        ),
      ),
      pictures: session.actorClientId === TEXTS_CLIENT_ID,
      attachments,
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
      history: shown,
      local: earlier,
      // What Tex keeps about them and its open jobs, in their own workspace (`aboutMe.js`, `jobs.js`), on a texted turn.
      ...(texting ? await readTexNotes(dispatch) : {}),
      localNow: { now: Date.now(), timeZone },
      observe: transcript?.record ?? null,
      workspaces: contextsFor(session), // Where a new note goes (`workspaces.js`).
      texting,
      notes: production !== null ? { prompt: production.prompt } : null,
      builtinModelOverride: productionModel ?? undefined,
      router,
      efforts: production?.efforts ?? null,
      fallback,
      maxRounds: production?.maxSteps ?? undefined,
      // A browser call can open a page and settle it (`infra/site-shots`
      // budgets 17 s); the default would cut a slow one short and lose it.
      toolTimeouts: { browse: 30_000, fill_login: 30_000 },
      ...(channel !== null ? { progress: channel, roundCap: LONG_MAX_ROUNDS, toolBudgetMs: LONG_TOOL_BUDGET_MS } : {}),
    });
    // The question's browser, if it opened one, is not left running.
    if (opened !== null) await afterAnswer(opened.close());
    await afterAnswer(meterEach(turn, meter)); // one report per model it ran on, at its own price (`modelPlan.js`)
    await afterAnswer(logTurn(turn.exhausted ? "exhausted" : "answered", turn.model, turn.timing, turn.usage));

    if (runner) {
      const ran = turn.exhausted ? { outcome: "failed", text: "" } : runOutcome(turn.answer);
      await afterAnswer(transcript.finish({ answer: ran.text, outcome: ran.outcome }));
      await keepRun(store, routine, runs, ran.outcome, ran.text);
      /*
        A routine that texts the person is a message they may answer with a bare
        "ok" or "yes", and that answer is to it, not to an ask raised before it.
      */
      if (ran.text && routine.settings.send !== "note") await disarmTexting(store, { userId: session.actorUserId });
      // A routine whose `until:` came true stops itself, recoverably.
      if (ran.outcome === "finished" && routine.cadence.unit !== "once") {
        await stopRoutine(dispatch, routine.path);
      }
      // A one-off has run: it stays where it is, marked done (`finishOnce`).
      if (supervision !== null) await deliverSupervision(store, dispatch, supervision, ran, afterAnswer);
      if (routine.cadence.unit === "once" && ran.outcome !== "failed") {
        await finishOnce(dispatch, routine.path, {
          now: Date.now(),
          timeZone: routineTimeZone(routine.settings, body.routine.timeZone),
        });
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
    const { answer: told, pictures } = outgoing.take(turn.answer);
    // An email's ask is texted exactly as written (`apps/agent/src/reply.ts`), or withdrawn if it would not fit.
    const { ask, verbatim } = await textedAsk(store, session, ledger.asked);
    const answer = ask === null ? told : `${told}\n\n${ask}`;
    /*
      A browser handed to the person goes out as a link the gateway adds, so
      the model never holds it. The link is their own `/tex/<handle>` page,
      which only they can open, signed in; it still stays out of the saved
      conversation below, because the line is the gateway's and not an answer
      the model gave.
    */
    const handoff = opened?.browser?.handoffLine() ?? null;
    const sent = handoff === null ? answer : `${answer}\n\n${handoff}`;
    if (transcript !== null) await afterAnswer(transcript.finish({ answer, outcome: turn.exhausted ? "exhausted" : "answered" }));

    if (conversation !== null && !turn.exhausted) {
      try {
        const saved = [question, attachmentsLine(attachments)].filter(Boolean).join("\n"); // names only, never bytes
        await appendConversation(store, conversation, history, saved, [answer, sentPicturesLine(pictures)].filter(Boolean).join("\n"), {
          tainted: ledger.untrusted,
          tools: turn.steps.filter((step) => step.ok).map((step) => step.tool),
        });
      } catch {
        // The answer is still owed. A history that failed to save costs the
        // next turn some context, not this one its reply.
      }
    }

    return json({
      answer: sent,
      // How many held calls the answer's last line asks about, so a caller that
      // plays the person (the bench) knows a YES is awaited; zero on a clean turn.
      asked: ledger.asked.length,
      ...(verbatim.length > 0 ? { verbatim } : {}),
      ...(pictures.length > 0 ? { pictures } : {}),
      provider: turn.provider,
      model: turn.model,
      steps: turn.steps,
      ...(turn.exhausted ? { exhausted: true } : {}),
    });
  } catch (error) {
    if (opened !== null) await afterAnswer(opened.close());
    if (transcript !== null) await afterAnswer(transcript.finish({ answer: "", outcome: "the turn failed" }));
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
 * Work that is ours rather than the person's runs after the answer has gone,
 * where the host lets it, rather than before.
 */
async function deferred(store, work) {
  try {
    if (typeof store.defer !== "function") throw new Error("no defer");
    store.defer(work);
  } catch {
    await work;
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
