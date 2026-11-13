/**
 * One agent turn: a question, the tools this connection already holds, and the
 * built-in model (`builtin.js`).
 *
 * ## What this is, in one line
 *
 * The same authority as `/mcp`, driven by a model instead of by a client. The
 * session, the store, the scope clamp and the tool dispatcher are the ones
 * `index.js` built for the request — so there is no second answer anywhere to
 * "may this caller do that", which is the property that matters most here.
 *
 * ## Writes are the client's own, except in a routine
 *
 * A texting turn edits notes directly (the owner, 2026-10-08, "Edit
 * directly"), and so does the app's own assistant since proposals were
 * removed (the owner, 2026-11-03): `textingWrites.js` adds the connection's
 * own MCP write tools and fields. A group chat has its narrower set
 * (`groupTurn.js`), and a routine's own run has none.
 *
 * Beyond those, the agent is offered only the read tools, and the list is
 * enforced at the call as well as in the prompt, so a model that names
 * another tool anyway reaches nothing. It has to be both: what comes back from
 * the provider is a name the *model* wrote, and a note it read can have told
 * it what to write there.
 *
 * ## The ambient place carries references, never content
 *
 * The app tells the agent where the person is — a route, the note open in front
 * of them, whether a meeting is running. `apps/mobile/features/agent/page.ts`
 * decided the shape and the rule: a path, an etag and a visibility, never the
 * text. If the agent wants the note it calls `read_note` and the same privacy
 * engine decides, rather than being handed something the clamp never saw.
 */

import { datedTurns, stamped } from "./localNow.js";
import { attachmentsLine } from "./attachments.js";
import { BUILTIN_PROVIDER, builtinModel, hasBuiltinModel, liveTurn, requestBuiltin, systemText } from "./builtin.js";
import { ProviderError, THINKING_REFUSED } from "./providers.js";
import { BROWSE_TIMED_OUT, BROWSE_TOOL } from "./computer.js";
import { turnPrompt } from "./turnPrompt.js";
import { pickTier } from "./router.js";
import { isPlainNoteWrite, settleNoteWrite, ToolTimeout, withinTime } from "./noteWriteRetry.js";
import { isMove, MOVE_TIMED_OUT, MOVE_TIMEOUTS } from "./slowMoves.js";
import { addModelUsage, failedCall, modelForRound, thinkRoundsFor, whyFailed } from "./modelPlan.js";
import { PROGRESS_TOOL } from "./progress.js";
import { turnLedger } from "./sendBack.js";
import { SIX_TOOLS, sixToolsOver } from "./sixTools.js";
import { resultInV2Names } from "../tools/v2/speak.js";
import { goalsIn } from "./aboutMe.js";
import { pushbackNudge } from "./pushback.js";
import { causeOf, failureRecorder } from "./toolFailures.js";
import { exhaustedAnswer, roundNotice } from "./lastRound.js";
import { traceNames } from "./turnLog.js";
import { SAID_NOTHING, SAY_NOTHING_TOOL, sayNothingLocal, sayNothingRefused, typedCallNotice, typedCallOf, withSayNothing } from "./sayNothing.js";

export { describePlace, systemPrompt } from "./prompt.js";
export { toolResultImages, toolResultText } from "./toolResults.js";
import { toolResultImages, toolResultText } from "./toolResults.js";

/**
 * How many times the model may call tools before the turn ends.
 *
 * A bound on the bill as much as on latency: each round is a model call
 * somebody pays for. Eight is enough for orient → search → read a few notes →
 * answer, which is the shape of almost every real question, and a turn that
 * needs more is one the person is better off steering.
 */
const MAX_ROUNDS = 8;

/**
 * The round bound for one turn: a production setup's `max_steps` (`production.js`)
 * when it names one, clamped to 1..MAX_ROUNDS so a setup can only tighten it.
 */
function roundsFor(maxRounds, cap = MAX_ROUNDS) {
  return Number.isInteger(maxRounds) ? Math.min(cap, Math.max(1, maxRounds)) : cap;
}

/**
 * Tools a model is never offered, whatever their annotations say.
 *
 * `readOnlyHint` answers "does this change anything?", which is not the same
 * question as "is this safe to hand a model". The gateway no longer has a key
 * export (the owner removed it on 2026-10-08), so the one name left is
 * `rotate_encryption_keys`: `readOnlyHint: false` already keeps it out of the
 * read tools, and naming it says that automating the key material is a ruling
 * made here, not an accident of a flag.
 */
// `search` and `fetch` are ChatGPT's two required tools: `search_notes` and
// `read_note` in OpenAI's shape, without the `context` argument. A model that
// has the real pair reaches for `search` by its name, passes `context`, and is
// refused: 215 times in one benchmark run (2026-10-09).
const WITHHELD_FROM_AGENT = new Set(["rotate_encryption_keys", "search", "fetch"]);

/** The longest question this route accepts: above a text the log keeps whole (`log.js` `MAX_EVENT_TEXT`), with room for what the Worker adds. */
export const MAX_QUESTION_LENGTH = 24_000;

/**
 * How long one tool call may take before the model is told it failed.
 *
 * The texting Worker gives the whole turn two minutes (`apps/agent`), and a
 * person's slow search used to spend all of it: the turn died, and the text
 * that went back was "Something went wrong" instead of an answer (the owner,
 * 2026-10-08: "the assistant is literally useless right now"). A call that
 * runs past this is answered in band like any failed call, so the model can
 * say what it could not check rather than the turn saying nothing.
 */
export const TOOL_TIMEOUT_MS = 20_000;

/**
 * How long a turn may keep calling tools. Past it, a tool call is refused in
 * band with "answer now", so the next round is the answer. Leaves the last
 * tool call and two model rounds inside the texting Worker's two minutes.
 */
export const TURN_TOOL_BUDGET_MS = 70_000;

/** What the model reads when a call ran past `TOOL_TIMEOUT_MS`. */
const TOOL_TIMED_OUT =
  "That call took too long and was stopped. Don't retry it. Answer with what you already have, " +
  "and say plainly what you could not check.";

/** What the model reads for a call asked for after `TURN_TOOL_BUDGET_MS`. */
const OUT_OF_TIME =
  "Out of time: no more tool calls this turn. Answer now with what you already have, " +
  "and say plainly what you could not check.";

export class AgentRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgentRefusal";
    this.code = code;
  }
}

/**
 * The tools the agent is offered.
 *
 * Filtered from what `toolsForSession` already returned, never assembled
 * independently — so a tool the context's owner turned off stays off.
 * One authority decision, taken upstream, narrowed here.
 */
export function agentTools(offered) {
  return offered.filter(
    (tool) =>
      !WITHHELD_FROM_AGENT.has(tool.name) &&
      tool.annotations?.readOnlyHint === true,
  );
}

/** The one refusal for "there is no model this turn may spend". */
function noModel() {
  return new AgentRefusal("no_provider", "No model is available for this turn.");
}

/**
 * Open the model this turn will spend: the built-in one, always.
 *
 * People's own Anthropic and OpenAI keys were deleted and are no longer used
 * (decided by the owner, 2026-10-10), so there is nothing of theirs to look
 * up. A request that still names a provider gets the refusal it got when that
 * provider was not connected, rather than being quietly answered by a model it
 * did not ask for: an older client that asked for "anthropic" learns it has
 * none, and its person is not billed against a cap they did not choose.
 *
 * The control plane says whether this grant may (a texting or routine grant
 * under the daily cap). That answer also counts the turn,
 * so it is asked once, here, and never per round.
 */
export async function openProvider(controlPlane, session, requested, env = {}, { background = false } = {}) {
  if (requested !== undefined && requested !== null) throw noModel();
  if (!hasBuiltinModel(env)) throw noModel();
  // A background job's part or report is never counted against the cap (`apps/convex/functions/builtinModel.ts`).
  const verdict = await controlPlane.startBuiltinTurn(session.accessToken, session.workspaceId, background ? { background: true } : undefined);
  if (verdict?.allowed === true) return { provider: BUILTIN_PROVIDER };
  if (verdict?.reason === "daily_cap") {
    throw new AgentRefusal("daily_limit", "Today's questions are used up.");
  }
  throw noModel();
}

/**
 * Run one turn to completion.
 *
 * @param {object} options
 * @param {string} options.question what the person asked
 * @param {object|null} options.place the ambient context; references only
 * @param {Array} options.tools the offered tool definitions, already clamped
 * @param {(name: string, args: object) => Promise<object>} options.callTool
 * @param {object} options.env the Worker environment, for the model default
 * @param {Array<{role: "user"|"assistant", text: string}>} [options.history]
 *   earlier turns of the same conversation, oldest first — words only, never
 *   a tool's result (see `conversation.js`)
 * @param {{ai?: object, gateway?: object, metadata?: object, fetchImpl?: Function}} [options.providerOptions]
 *   what `requestBuiltin` needs: the Workers AI binding, the AI gateway, and
 *   the labels its cost is filed under
 * @param {boolean} [options.texting] the answer goes out as a text message
 * @param {{prompt: ?string}} [options.notes]
 *   the production setup's prompt from `@context-lc` (`production.js`), or
 *   null for the built-in words
 * @param {string} [options.builtinModelOverride] the built-in model to run
 *   instead of `builtinModel(env)`; `texEntryPoint.js` checks it can be called
 * @param {number} [options.maxRounds] the most model rounds this turn may take,
 *   clamped to 1..MAX_ROUNDS
 * @param {{decide: Function|null, think: string, routeAt?: number, thinkRounds?: number, jobsOnly?: boolean}} [options.router] the setup's
 *   model router (`router.js`): the decision engine that picks a tier for this
 *   text, and the model a `think` text runs on; `texEntryPoint.js` checks it can be called.
 *   With `thinkRounds`, a `think` text plans on `think` and drives on `main` (`modelPlan.js`);
 *   `jobsOnly` (a planner, no router) plans a `planned` turn and leaves every other on `main`
 * @param {() => number} [options.clock] milliseconds, for `timing`
 * @param {{write?: string[], manage?: string[], send?: string[]}|null} [options.grants]
 *   the actions a surface allows by name, where it narrows further than the
 *   tools it holds (`sixTools.js`); null allows every action they carry
 * @param {Array<{tool: object, call: Function}>} [options.local] tools this
 *   turn answers itself rather than through the MCP
 * @param {string|null} [options.aboutMe] `tex/about.md`'s text on a texted
 *   turn (`aboutMe.js`), `""` when it doesn't exist; null says nothing about it
 * @returns {Promise<{answer: string, provider: string, model: string, steps: Array, usage: object, usageByModel: object}>}
 *   `model` is the model that wrote the final answer (on an exhausted turn, the
 *   last one that ran); `usage` is the whole turn's, `usageByModel` the same
 *   counts split by the model that spent them, which is what a turn that
 *   changed model mid-way is priced by (`modelPlan.js` `meterParts`)
 */
export async function runTurn(options) {
  const {
    question,
    place = null,
    callTool,
    env,
    providerOptions = {},
    history = [],
    // Gateway words saying the history is one iMessage thread's (`threadView.js`).
    threadNote = "",
    turnNote = "", // per-text words said in their turn, never the system prompt (`turnPrompt.js`)
    // Texts sent while it works, taken after each tool round (`steer.js`).
    steer = null,
    web = null,
    texting = false,
    // Whether its answer can text pictures back (`outgoingPictures.js`): a text from their phone.
    pictures = false,
    notes = null,
    builtinModelOverride = null,
    router = null,
    fallback = null,
    maxRounds,
    clock = Date.now,
    toolTimeoutMs = TOOL_TIMEOUT_MS,
    toolBudgetMs = TURN_TOOL_BUDGET_MS,
    roundCap = MAX_ROUNDS,
    progress = null,
    toolTimeouts = {},
    grants = null,
    local: localTools = [],
    aboutMe = null, identity = null, // who they are by their account (`identity.js`), told beside it
    jobs = null, // `tex/jobs.md`'s text on a texted turn (`jobs.js`); null says nothing about jobs.
    voice = null, calendar = null, // `tex/voice.md`'s text on a texted turn (`personVoice.js`); null says nothing about it.
    answerCheck = null, // reads a final answer and the turn's messages, and may send one more round (`claimCheck.js`, `replyJudge.js`)
    endsTurn = null, // `(name, result) => string|null`: a call that settles the turn, answered with its line at once (`background.js`)
    sayNothing = false, mustAnswer = false, // offers `say_nothing`: a call ends the turn with nothing texted, or with `mustAnswer` (a literal @Tex tag) is refused (`sayNothing.js`)
    scheduled = false, // a routine's run or a check-in, nobody waiting on it: its last steps end quiet, and its last answer is still reviewed (`lastRound.js`)
    roundNote = null, // `(round, elapsedMs) => string|null`: a line told before a round (`background.js`)
    // `{ now, timeZone }`: the person's own clock, told every round (`localNow.js`).
    localNow = null,
    // The workspaces they can reach (`contextsFor`), so a new note goes where its project is (`workspaces.js`).
    workspaces = null,
    // How hard each model thinks, by model name (`production.js`); absent: the model's own default.
    efforts = null,
    // What the person sent with the question, checked (`attachments.js`): shown to the model with it.
    attachments = [],
    // Told each step as it happens (`transcript.js`): thinking, words between tools, each call.
    // Never throws back into the turn, and asks the model for its thinking in words.
    observe = null,
  } = options;
  const held = turnLedger({ tools: options.tools, ranHere: (name) => webNames.has(name) || localCalls.has(name) }); // the turn as its ledger keeps it (`sendBack.js`)
  const tell = (event) => {
    held.keep(event);
    if (typeof observe !== "function") return;
    try {
      observe(event);
    } catch {
      // A transcript that broke costs a transcript, never the turn.
    }
  };
  const began = clock();
  // The computer's tools (`computer.js`), offered beside the MCP ones and
  // dispatched to their own session, which carries the address guard.
  const webNames = new Set((web?.tools ?? []).map((tool) => tool.name));
  /*
    A streamed texting turn (`progress.js`) can text the person a line while
    it works. Dispatched here, like the web tools, never to the MCP: it reaches
    only the person who asked, on the channel their answer goes to anyway.
  */
  const [local, settles] = !sayNothing ? [localTools, endsTurn] : mustAnswer ? [[...localTools, sayNothingRefused], endsTurn] : [[...localTools, sayNothingLocal], withSayNothing(endsTurn)]; // silence ends the turn like a started job; a turn that must answer is offered it the same (one tool list, cached) and refused (`sayNothing.js`)
  const tools = [
    ...(options.tools ?? []),
    ...(web?.tools ?? []),
    ...local.map((entry) => entry.tool),
    ...(progress ? [progress.tool] : []),
  ];
  // Tools answered here rather than by the MCP (`texEntryPoint.js`'s earlier texts).
  const localCalls = new Map(local.map((entry) => [entry.tool.name, entry.call]));
  /*
    THE SIX (`sixTools.js`): the model is shown orient, search, fetch, write,
    manage and send, each listing only what `tools` grants, and a call to one
    is translated back into the granted tool before the allowlist below.
  */
  const six = sixToolsOver(tools, grants);
  // A slow tool (a browser step, a held email) names its own limit, cut to end 30 s past the budget so the answer still fits.
  // A move's own is in `slowMoves.js`, under whatever the caller set.
  const limits = { ...MOVE_TIMEOUTS, ...toolTimeouts };
  const timeoutFor = (name) =>
    Math.max(1, Math.min(Number.isInteger(limits[name]) && limits[name] > 0 ? limits[name] : toolTimeoutMs, toolBudgetMs + 30_000 - (clock() - began)));

  const provider = BUILTIN_PROVIDER;
  // Ours to pick on our bill, never the caller's: see `builtin.js`.
  let model = builtinModelOverride ?? builtinModel(env);
  // A streamed turn may raise the cap (`progress.js`); a setup only ever tightens it.
  const rounds = roundsFor(maxRounds, Number.isInteger(roundCap) && roundCap > 0 ? roundCap : MAX_ROUNDS);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, decision: 0 };
  // The same counts by the model that spent them: a turn can change model (`modelPlan.js`, the fallback).
  const usageByModel = {};
  // The setup's everyday model, which a planned turn drives on.
  const mainModel = model;
  // Which model runs each round when the router picked think and the setup names think_rounds.
  let plan = null;
  const trace = [];
  /*
    THE ROUTER PICKS THE MODEL BEFORE THE FIRST ROUND (`router.js`).

    The whole turn runs on the model picked, so the tool rounds are
    coherent, unless the setup plans with `think` and drives with `main`
    (`think_rounds`, `modelPlan.js`): then each round picks its model below,
    and `usageByModel` says what each spent. The pick, the router's own word
    and what it cost are recorded: a benchmark prices each model that ran,
    and a person watching the turn log sees which tier a slow or wrong answer
    came from.
  */
  const nudge = texting ? pushbackNudge(question, goalsIn(aboutMe)) : ""; // an opinion or a goal-touching ask (`pushback.js`)
  // A planner with no router (`jobsOnly`, `modelPlan.js` `turnRouter`) plans a background job and nothing else: every other text stays on `main`.
  if (router !== null && (router.jobsOnly !== true || options.planned)) {
    const asked = clock();
    // A background job always plans on `think` and drives on `main` (`background.js`), and so does a text asking for Tex's judgment (`pushback.js`): no router call.
    const routed = options.planned || nudge !== "" ? { tier: "think", pick: "think", tokens: 0 } : await pickTier({ decide: router.decide, text: [question, attachmentsLine(attachments)].filter(Boolean).join("\n"), history, routeAt: router.routeAt });
    usage.decision += routed.tokens;
    if (routed.tier === "think") model = router.think;
    plan = thinkRoundsFor(router, routed.tier, mainModel);
    // How sure the router was that this text needs thinking, kept whether or
    // not it cleared the setup's cutoff: a benchmark tunes the cutoff from the
    // near misses. Absent when it picked another tier or did not answer.
    const confidence = routed.pick === "think" && typeof routed.confidence === "number" ? { confidence: routed.confidence } : {};
    trace.push({ kind: "router", tier: routed.tier, pick: routed.pick, model, at: asked - began, ms: clock() - asked, ...confidence });
    tell({ kind: "model", step: "router", model, ms: clock() - asked, input: options.planned || nudge !== "" ? undefined : question, output: { tier: routed.tier, pick: routed.pick, ...confidence }, reason: options.planned ? "a long job is planned on the thinking model" : routed.tier === "think" ? "the router judged it needs thinking" : "picked by the router" });
  }
  const promptFor = (answering) => turnPrompt(place, answering, { texting, pictures, notes, models: router !== null ? { main: mainModel, think: router.think, jobsOnly: router.jobsOnly === true } : null, tools, history, threadNote, turnNote, webNames, progress, aboutMe, identity, jobs, voice, calendar, observe, workspaces, localNow, plan, nudge }); // `turnPrompt.js`
  let prompt = promptFor(model);
  // The person's own text, with the turn's facts carried ahead of it (`providers.js`): set before every round.
  const questionMessage = { role: "user", text: question, ...(attachments.length > 0 ? { attachments } : {}) };
  // Each of their earlier texts with its day and time, so "today" in one is that day's (Dev2, 2026-11-10; `localNow.js` `stamped`).
  // An answer in the chat's current stretch carries its calls and their results, then its words (`stretch.js`).
  const historyMessages = datedTurns(history).flatMap(({ turn: { role, text, calls }, at }) => role === "user"
    ? [{ role, text: stamped(text, at, localNow?.timeZone ?? null) }]
    : Array.isArray(calls) && calls.length > 0
      ? [{ role, text: "", toolCalls: calls.map(({ id, name, args }) => ({ id, name, args })) }, ...calls.map(({ id, name, result, isError }) => ({ role: "tool", id, name, text: result, ...(isError ? { isError: true } : {}) })), { role, text }]
      : [{ role, text }]);
  const messages = [...historyMessages, questionMessage];
  /*
    What the turn did, by name only. The arguments a tool was called with can
    carry a path and a query — facts about what somebody is looking for in their
    own notes — so the steps record *that* a call happened and what it was
    called, which is what a person watching a spinner wants, and nothing that
    would make this a transcript of their thinking.
  */
  const steps = [];
  /*
    Where the time went, in milliseconds and counts only: what a slow answer
    is diagnosed from (the owner, 2026-10-07: "it was EXTREMELY slow"); no note or question in it.
  */
  const timing = { rounds: 0, modelMs: 0, toolMs: 0, failures: [] }; // `failures`: each failed tool call, logged as it happens (`toolFailures.js`)
  const failed = failureRecorder(timing.failures, providerOptions, () => model);
  /*
    The same, in order: each model round and each tool call between them, by
    name, outcome and duration. What the turn log keeps, and what shows where
    one slow turn spent its time.
  */

  /*
    THE NARROWED LIST IS ENFORCED HERE, NOT ONLY IN THE PROMPT.

    `agentTools` decides what the model is *told about*. What comes back is a
    name the model wrote, and handing that to `callTool` — which is the client's
    own dispatcher, holding this connection's whole authority — would make
    "only what was offered" a property of the prompt rather than of the gateway.
    A model names a tool it was never offered when it is confused, and when a
    sentence in a note it just read told it to; a personal context takes email
    into `0-inbox/`, so that sentence is one anybody who knows the address can
    write.

    Built from `tools` rather than from a list of its own, so a tool withheld
    upstream — by the scope clamp, by a disabled plugin, by
    `WITHHELD_FROM_AGENT` — is undispatchable here for free, and there is still
    exactly one place that decides what the agent may reach.
  */
  const offeredNames = new Set((tools ?? []).map((tool) => tool.name));
  const offered = six.tools;

  /*
    CHANGING MODEL MID-TURN: the fallback, and a planned turn moving between
    `think` and `main` (`modelPlan.js`). The prompt is the new model's (it is
    told which model it is). The earlier blocks go back unchanged: the API drops
    thinking a model cannot read (platform.claude.com/docs/en/build-with-claude/thinking).
  */
  const switchTo = (next) => { model = next; prompt = promptFor(model); };
  let stripped = false, strippedNote = false; // blocks stripped after a 400 naming them: once a turn, traced
  // The last round's tool calls included one that failed: the next one plans again.
  let escalate = false;
  // The fallback is taken once a turn: a turn that moved models must never loop back to it.
  let fellBack = false;

  let lastWords = ""; // what the model last said, answered if the bound is reached (`lastRound.js`)
  for (let round = 0; round < rounds; round += 1) {
    const notice = roundNotice(round, rounds, { scheduled });
    if (notice !== null && messages.at(-1)?.text !== notice) messages.push({ role: "user", text: notice });
    const jobNudge = typeof roundNote === "function" ? roundNote(round, clock() - began) : null;
    if (typeof jobNudge === "string" && jobNudge !== "") messages.push({ role: "user", text: jobNudge });
    if (plan !== null) {
      const next = modelForRound(plan, round, escalate);
      if (next.model !== model) {
        tell({ kind: "model", model: next.model, reason: next.reason === "escalated" ? "after a step failed" : next.reason === "drive" ? "to carry out the plan" : "to plan" });
        switchTo(next.model);
      }
    }
    escalate = false;
    const asked = clock();
    let answer;
    questionMessage.preamble = prompt.preamble;
    try {
      answer = await requestBuiltin(
        // `cachedThrough`: the history is the cached stretch; the question and what follows it are not (`aiGateway.js`).
        { model, system: prompt.system, messages, tools: offered, effort: efforts?.[model], cachedThrough: historyMessages.length, ...(observe ? { display: "summarized" } : {}) },
        providerOptions.ai,
        providerOptions,
      );
    } catch (error) {
      // A provider that refused the earlier blocks (`aiGateway.js` names it): once more without them.
      if (error instanceof ProviderError && error.reason === THINKING_REFUSED && !stripped && messages.some((m) => m.content)) { stripped = strippedNote = true; timing.modelMs += clock() - asked; for (const m of messages) delete m.content; round -= 1; continue; }
      /*
        THE FALLBACK MODEL (decided by the owner, 2026-10-09). A provider that
        failed after its retry costs the person a slower answer, never no
        answer: the turn goes on from the same messages on the setup's
        fallback model, once. The trace says so with the status, the meter is
        told the model that answered, and a benchmark counts how often it
        happened, because this is what production does too.
      */
      // A turn carrying a picture names its fallback by the model that failed (`pictureFallback`, `attachments.js`).
      const next = typeof fallback === "function" ? fallback(model) : fallback;
      if (error instanceof ProviderError && next !== null && model !== next && !fellBack) {
        fellBack = true;
        const ms = clock() - asked;
        timing.modelMs += ms;
        trace.push({ kind: "fallback", from: model, model: next, status: error.status ?? null, ok: true, at: asked - began, ms });
        tell({ kind: "model", step: "fallback", model: next, ms, input: { from: model, status: error.status ?? null }, output: { model: next }, reason: `after ${model} failed` });
        // The rest of the turn stays on the fallback: a plan would send it back to what failed.
        plan = null;
        // Another model reads none of this one's thinking, and the prompt changed with it.
        switchTo(next);
        round -= 1;
        continue;
      }
      // A failed turn is the one most worth seeing in the log, so the trace
      // so far travels with the error to `texEntryPoint.js`.
      if (error instanceof ProviderError) {
        const ms = clock() - asked;
        error.model = model;
        error.timing = {
          rounds: timing.rounds + 1,
          modelMs: timing.modelMs + ms,
          toolMs: timing.toolMs, failures: timing.failures,
          trace: [...trace, { kind: "model", model, ok: false, at: asked - began, ms, ...(error.status === null || error.status === undefined ? {} : { status: error.status }) }],
        };
      }
      throw error;
    }
    const roundMs = clock() - asked;
    timing.rounds += 1;
    timing.modelMs += roundMs;
    trace.push({
      kind: "model",
      // Which model ran this round: a planned or fallen-back turn has more than one.
      model,
      ok: true,
      // When it started, from the turn's start, for the chat's timeline (`turnTiming.js`).
      at: asked - began,
      ms: roundMs,
      // Retried once by the gateway (`aiGateway.js`): noted, with what it was retried after.
      ...(answer.retried ? { retried: true, ...(answer.retried.status === null ? {} : { status: answer.retried.status }) } : {}),
      // Stopped at the output cap (`aiGateway.js`): the round's thinking and
      // answer ran out of room, which the turn log and a benchmark count.
      ...(answer.stop === "max_tokens" ? { cut: true } : {}),
      ...(strippedNote ? { code: "thinking_stripped" } : {}),
      // What the round cost in tokens, and how much of its output was words or calls (the rest is thinking): `turnStages.js` `callPoints`.
      ...(answer.usage ? { usage: answer.usage, said: (answer.text ?? "").length, calls: answer.toolCalls.length } : {}),
    });
    strippedNote = false;
    if (answer.usage) {
      usage.input += answer.usage.input;
      usage.output += answer.usage.output;
      usage.cacheRead += answer.usage.cacheRead ?? 0;
      usage.cacheWrite += answer.usage.cacheWrite ?? 0;
      addModelUsage(usageByModel, model, answer.usage);
    }

    for (const block of Array.isArray(answer.content) ? answer.content : []) {
      if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        // With the round's time and output tokens, so the history shows what the thinking cost (`ledger.js`).
        tell({ kind: "thinking", text: block.thinking, ms: roundMs, ...(answer.usage ? { output: answer.usage.output } : {}) });
      }
    }

    if (answer.toolCalls.length === 0) {
      // A call typed out as the reply is never a text (a group, 2026-11-06 20:01 UTC): silence typed is silence, any other is sent back to be made (`sayNothing.js`).
      const typed = typedCallOf(answer.text);
      if (typed === SAY_NOTHING_TOOL) {
        tell({ kind: "judge", by: "code", round, draft: answer.text, went: false, reason: "say_nothing typed as text: nothing is texted" });
        return { answer: SAID_NOTHING, provider, model, steps, usage, usageByModel, timing: { ...timing, trace }, settled: SAY_NOTHING_TOOL, live: liveTurn(prompt, messages) };
      }
      if (typed !== null && round < rounds - 1) {
        tell({ kind: "judge", by: "code", round, draft: answer.text, went: false, notice: typedCallNotice(typed) });
        messages.push({ role: "user", text: held.sendBack(typedCallNotice(typed), answer.text) });
        continue;
      }
      const lastRound = round === rounds - 1;
      const recheck = !lastRound || scheduled ? (await answerCheck?.(answer.text, { messages, mark: (entry) => trace.push({ ...entry, kind: "judge", at: clock() - began }), tell })) ?? null : null;
      // A scheduled run's last answer the reviewer sent back has no round left to be written again: nothing is texted (`lastRound.js`).
      if (lastRound && recheck !== null) {
        tell({ kind: "judge", by: "code", round, draft: answer.text, went: false, reason: "sent back on a scheduled run's last step: nothing is texted" });
        return { answer: SAID_NOTHING, provider, model, steps, usage, usageByModel, timing: { ...timing, trace }, settled: SAY_NOTHING_TOOL, live: liveTurn(prompt, messages) };
      }
      // A text that came in while it wrote this reply (a follow-up, a correction) joins it before it goes, not after (Dev2, 2026-10-31).
      const late = recheck === null && steer?.late === true && round < rounds - 1 ? await steer.next() : null;
      if (late !== null) {
        messages.push({ role: "user", text: held.lateText(answer.text, late) }); // the draft quoted as NOT sent, never put in as said
        if (answerCheck) tell({ kind: "judge", by: "late", draft: answer.text, went: false, reason: "a text came in while it was written, so it was written again with it" }); // a passed draft held after all: the history says so
        tell({ kind: "steered", text: steer.words.at(-1) ?? "" });
        continue;
      }
      if (recheck === null) return { answer: answer.text, provider, model, steps, usage, usageByModel, timing: { ...timing, trace }, live: liveTurn(prompt, messages) }; // `live`: the whole turn, for a job's check (`jobCheck.js`)
      messages.push({ role: "user", text: held.sendBack(recheck, answer.text) }); // the draft quoted as NOT sent, never put in as said (`sendBack.js`)
      continue;
    }

    if (answer.text?.trim()) {
      tell({ kind: "say", text: answer.text });
      lastWords = answer.text;
    }
    messages.push({
      role: "assistant",
      text: answer.text,
      toolCalls: answer.toolCalls,
      ...(Array.isArray(answer.content) ? { content: answer.content } : {}),
    });

    const settling = []; // calls this round that settle the turn, read once the whole round has run: one round may start several jobs
    for (const made of answer.toolCalls) {
      // One of the six, as the granted tool that carries it; an older name as itself.
      const resolved = six.resolve(made.name, made.args);
      if (resolved.error) {
        messages.push({ role: "tool", id: made.id, name: made.name, text: resolved.error, isError: true });
        escalate = true;
        tell({ kind: "tool", name: made.name.slice(0, 64), args: made.args, ok: false, ms: 0, reason: "no such action" });
        failed({ tool: made.name, cause: "no_such_action", text: resolved.error, round });
        continue;
      }
      const call = { ...made, name: resolved.name, args: resolved.args };
      const asSix = SIX_TOOLS.includes(made.name);
      if (!offeredNames.has(call.name)) {
        /*
          Answered in band rather than thrown, like every other refusal in this
          loop: the model reads it and uses a tool it was actually given, which
          is what a client would do. No `steps` entry, because nothing ran —
          and because `call.name` is unbounded text the model produced, and
          `steps` is rendered to the person.
        */
        messages.push({
          role: "tool",
          id: call.id,
          name: made.name,
          text: asSix ? "That is not something you were given. Use only the actions your tools list." : "There is no such tool. Use only the tools you were given.",
          isError: true,
        });
        escalate = true;
        tell({ kind: "tool", name: call.name.slice(0, 64), args: call.args, ok: false, ms: 0, reason: "no such tool" });
        failed({ tool: call.name, cause: "not_offered", text: asSix ? "not one of the actions it was given" : "no such tool", round });
        continue;
      }
      const repeated = held.refusal(call.name, call.args); // a write already made, asked again after a send-back
      if (repeated !== null) {
        messages.push({ role: "tool", id: call.id, name: made.name, text: repeated, isError: true });
        tell({ kind: "tool", name: call.name, args: call.args, ok: false, ms: 0, reason: "already done this turn" });
        failed({ tool: call.name, cause: "repeated", text: "already done this turn", round });
        continue;
      }
      if (clock() - began >= toolBudgetMs) {
        // Answered in band, like an unknown tool: the model's next round is
        // the answer, written from what the calls so far returned.
        trace.push({ kind: "tool", tool: call.name, ok: false, ms: 0 });
        messages.push({ role: "tool", id: call.id, name: made.name, text: OUT_OF_TIME, isError: true });
        tell({ kind: "tool", name: call.name, args: call.args, ok: false, ms: 0, reason: "out of time" });
        failed({ tool: call.name, cause: "out_of_time", text: "asked for after the turn's tool time was spent", round });
        continue;
      }
      let result;
      let thrown = null; // what the tool threw, for the failure log only (`toolFailures.js`)
      const called = clock();
      // Which model made this call, for the usage breakdown. Per call, because
      // routing and fallback can change the model mid-turn.
      options.onModel?.(model);
      // A tool starting, for a group's one early tapback (`apps/agent/src/groupModelTurn.ts`): a progress line or silence is not one.
      if (call.name !== PROGRESS_TOOL && call.name !== SAY_NOTHING_TOOL) try { options.onToolStart?.(call.name); } catch { /* a failed tapback never costs the turn */ }
      try {
        const viaMcp = !(progress && call.name === PROGRESS_TOOL) && !localCalls.has(call.name) && !webNames.has(call.name);
        result = viaMcp && isPlainNoteWrite(call.name, call.args)
          // A slow save is waited on, read back and retried, never told as failed unseen (`noteWriteRetry.js`).
          ? await settleNoteWrite({ run: () => callTool(call.name, call.args), callTool, args: call.args, ms: timeoutFor(call.name), remaining: () => toolBudgetMs + 30_000 - (clock() - began) })
          : await withinTime(
              progress && call.name === PROGRESS_TOOL
                ? progress.call(call.args, { messages }) // the turn so far, for the reviewer of the line (`progress.js`)
                : localCalls.has(call.name)
                ? localCalls.get(call.name)(call.args, { ...liveTurn(prompt, messages), system: [systemText(prompt.system), prompt.preamble].join("\n\n"), tools: offered }) // the turn so far, for a tool that reads it (`advisor.js`)
                : webNames.has(call.name)
                  ? web.call(call.name, call.args)
                  : callTool(call.name, call.args),
              timeoutFor(call.name),
            );
      } catch (error) {
        /*
          A tool that threw is the model's problem to work around, not the
          turn's to die of — it reads the refusal and tries something else, the
          way a client would. The *reason* is deliberately not relayed: a thrown
          error in this worker can carry plumbing state (`StorageUnavailable`'s
          own header reserves its reasons for the gateway's logs), and this
          string goes to a third-party model.
        */
        if (error instanceof ProviderError) throw error;
        thrown = error;
        const text =
          error instanceof ToolTimeout ? (call.name === BROWSE_TOOL ? BROWSE_TIMED_OUT : isMove(call.name) ? MOVE_TIMED_OUT : TOOL_TIMED_OUT) : "That call failed. Don't guess what it would have said.";
        result = { content: [{ type: "text", text }], isError: true };
      }
      // A refusal written in the older names, read by a model that holds the six (`speak.js`).
      if (asSix) result = resultInV2Names(result);
      const toolMs = clock() - called;
      timing.toolMs += toolMs;
      // A call the egress gate held for the person's yes is not a failure: it
      // runs when they give it (`texEntryPoint.js`), and a log that called it failed
      // would read as a broken tool.
      trace.push({ kind: "tool", tool: call.name, ok: result?.isError !== true, at: called - began, ms: toolMs, ...(result?.held === true ? { held: true } : {}), ...traceNames(made, call) }); // the six's name and action, for the Lab's Tools page (`turnLog.js`)
      steps.push({ tool: call.name, ok: result?.isError !== true, ...(Array.isArray(result?.sources) ? { sources: result.sources } : {}) });
      // A failed step sends the next round to the planner; one held for the person's yes does not.
      if (failedCall(result)) { escalate = true; failed({ tool: call.name, ...causeOf(thrown, ToolTimeout), result, ms: toolMs, round }); }
      tell({ kind: "tool", name: call.name, args: call.args, ...(made.name !== call.name ? { as: { name: made.name, args: made.args } } : {}), ok: result?.isError !== true, ms: toolMs, held: result?.held === true, reason: whyFailed(result), result: toolResultText(result), ...(typeof result?.thinking === "string" && result.thinking ? { thinking: result.thinking } : {}) }); // the result, for the chat's ledger (`ledger.js`)
      messages.push({
        role: "tool",
        id: call.id,
        name: made.name,
        text: toolResultText(result) || "(no result)",
        images: toolResultImages(result),
        // A held call reaches the model as what it is, waiting for the person, never as an
        // error: read as one, "Not sent yet" became "the email didn't go through" and a
        // second, different copy of the email texted beside the one held (Dev, 2026-10-19).
        isError: failedCall(result),
      });
      if (typeof settles === "function" && result?.isError !== true) settling.push(call);
    }
    // A job just started: the job does the work, so the person hears "on it" now, not after another model round.
    // Read after the round, not at its first start: a call after it in the same round (a second part) still runs (2026-11-04).
    for (const call of settling) {
      const settled = settles(call.name, call.args);
      if (typeof settled === "string" && settled !== "") {
        return { answer: settled, provider, model, steps, usage, usageByModel, timing: { ...timing, trace }, settled: call.name, live: liveTurn(prompt, messages) };
      }
    }
    if (steer !== null && typeof steer.cancelled === "function" && steer.wrote !== true && (await steer.cancelled())) return { answer: "", provider, model, steps, usage, usageByModel, timing: { ...timing, trace }, cancelled: true }; // the Worker cancelled it (`steer.js`)
    const steered = steer === null ? null : await steer.next();
    if (steered !== null) {
      messages.push({ role: "user", text: steered });
      tell({ kind: "steered", text: steer.words.at(-1) ?? "" });
    }
  }

  // The bound was reached: answered, not thrown, with what the model last said (`lastRound.js`).
  return {
    answer: exhaustedAnswer(lastWords),
    provider,
    model,
    steps,
    usage,
    usageByModel,
    timing: { ...timing, trace },
    exhausted: true,
    live: liveTurn(prompt, messages),
  };
}
