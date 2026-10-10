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
 * ## Writes are proposals, except from a text
 *
 * The one exception is a texting turn, which edits notes directly (the owner,
 * 2026-10-08, "Edit directly"): `textingWrites.js` adds the connection's own
 * MCP write tools and fields, all of them. Everywhere else, what follows
 * holds.
 *
 * The agent is offered the read tools and `propose_note`, and never
 * `write_note`, `move_note`, `set_visibility` or anything else that changes the
 * bucket — and the list is enforced at the call as well as in the prompt, so a
 * model that names one anyway reaches nothing. It has to be both: what comes
 * back from the provider is a name the *model* wrote, and a note it read can
 * have told it what to write there.
 *
 * Not because a model cannot be trusted with a write — the scope clamp would
 * already refuse one this connection may not make — but because a note is the
 * customer's own record of their work, and an edit they did not read is a
 * different product. A proposal lands in the review queue the console already
 * has, and they say yes.
 *
 * That also makes the failure mode of a confused turn *noise* rather than
 * *damage*, which is the difference between a bad answer and a support ticket
 * about a rewritten note.
 *
 * ## The ambient place carries references, never content
 *
 * The app tells the agent where the person is — a route, the note open in front
 * of them, whether a meeting is running. `apps/mobile/features/agent/page.ts`
 * decided the shape and the rule: a path, an etag and a visibility, never the
 * text. If the agent wants the note it calls `read_note` and the same privacy
 * engine decides, rather than being handed something the clamp never saw.
 */

import { BUILTIN_PROVIDER, builtinModel, hasBuiltinModel, requestBuiltin } from "./builtin.js";
import { ProviderError } from "./providers.js";
import { webPrompt } from "./computer.js";
import { systemPrompt } from "./prompt.js";
import { pickTier } from "./router.js";

export { describePlace, systemPrompt } from "./prompt.js";

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
function roundsFor(maxRounds) {
  return Number.isInteger(maxRounds) ? Math.min(MAX_ROUNDS, Math.max(1, maxRounds)) : MAX_ROUNDS;
}

/** The one write the agent may make, and it is not a write to the bucket. */
const PROPOSAL_TOOL = "propose_note";

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

/** The longest question this route accepts. */
export const MAX_QUESTION_LENGTH = 8000;

/**
 * The biggest tool answer that goes back to the model.
 *
 * A long note is a legitimate answer, so this is generous — but it is a bound,
 * because without one a single `read_note` on a large file decides how many
 * tokens a turn is billed for, and the model gets a worse prompt out of
 * it than a truncated one with a line saying so.
 */
const MAX_TOOL_RESULT_CHARS = 60_000;

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

/** Settle `work` within `ms`, or throw `ToolTimeout`. */
async function withinTime(work, ms) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ToolTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class ToolTimeout extends Error {}

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
 * independently — so a connection with no write scope is not offered
 * `propose_note` either, and a tool the context's owner turned off stays off.
 * One authority decision, taken upstream, narrowed here.
 */
export function agentTools(offered) {
  return offered.filter(
    (tool) =>
      !WITHHELD_FROM_AGENT.has(tool.name) &&
      (tool.annotations?.readOnlyHint === true || tool.name === PROPOSAL_TOOL),
  );
}

/** Flatten an MCP tool result into the text the model reads back. */
export function toolResultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[truncated: the full result was ${text.length} characters]`;
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
 * The control plane says whether this grant may (a texting or routine grant on
 * a Premium workspace under the daily cap). That answer also counts the turn,
 * so it is asked once, here, and never per round.
 */
export async function openProvider(controlPlane, session, requested, env = {}) {
  if (requested !== undefined && requested !== null) throw noModel();
  if (!hasBuiltinModel(env)) throw noModel();
  const verdict = await controlPlane.startBuiltinTurn(session.accessToken, session.workspaceId);
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
 *   instead of `builtinModel(env)`; `route.js` checks it can be called
 * @param {number} [options.maxRounds] the most model rounds this turn may take,
 *   clamped to 1..MAX_ROUNDS
 * @param {{decide: Function|null, think: string}} [options.router] the setup's
 *   model router (`router.js`): the decision engine that picks a tier for this
 *   text, and the model a `think` text runs on; `route.js` checks it can be called
 * @param {() => number} [options.clock] milliseconds, for `timing`
 * @returns {Promise<{answer: string, provider: string, model: string, steps: Array}>}
 */
export async function runTurn(options) {
  const {
    question,
    place = null,
    callTool,
    env,
    providerOptions = {},
    history = [],
    web = null,
    texting = false,
    notes = null,
    builtinModelOverride = null,
    router = null,
    fallback = null,
    maxRounds = MAX_ROUNDS,
    clock = Date.now,
    toolTimeoutMs = TOOL_TIMEOUT_MS,
    toolBudgetMs = TURN_TOOL_BUDGET_MS,
  } = options;
  const began = clock();
  // The computer's tools (`computer.js`), offered beside the MCP ones and
  // dispatched to their own session, which carries the address guard.
  const webNames = new Set((web?.tools ?? []).map((tool) => tool.name));
  const tools = [...(options.tools ?? []), ...(web?.tools ?? [])];

  const provider = BUILTIN_PROVIDER;
  // Ours to pick on our bill, never the caller's: see `builtin.js`.
  let model = builtinModelOverride ?? builtinModel(env);
  const rounds = roundsFor(maxRounds);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, decision: 0 };
  const trace = [];
  /*
    THE ROUTER PICKS THE MODEL BEFORE THE FIRST ROUND (`router.js`).

    The whole turn runs on the model picked, so the tool rounds are
    coherent. The pick, the router's own word and what it cost are recorded:
    a benchmark prices the model that answered, and a person watching the
    turn log sees which tier a slow or wrong answer came from.
  */
  if (router !== null) {
    const asked = clock();
    const routed = await pickTier({ decide: router.decide, text: question, history });
    usage.decision += routed.tokens;
    if (routed.tier === "think") model = router.think;
    trace.push({ kind: "router", tier: routed.tier, pick: routed.pick, model, ms: clock() - asked });
  }
  const systemFor = (answering) =>
    systemPrompt(place, {
      texting,
      notes,
      model: answering,
      edits: tools.some((tool) => tool.name === "write_note"),
      continued: history.length > 0,
    }) +
    webPrompt(webNames);
  let system = systemFor(model);
  const messages = [
    ...history.map(({ role, text }) => ({ role, text })),
    { role: "user", text: question },
  ];
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
    is diagnosed from (the owner, 2026-10-07: "it was EXTREMELY slow"), and
    nothing a log line could leak a note or a question through.
  */
  const timing = { rounds: 0, modelMs: 0, toolMs: 0 };
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
    "writes are proposals" a property of the prompt rather than of the gateway.
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

  for (let round = 0; round < rounds; round += 1) {
    const asked = clock();
    let answer;
    try {
      answer = await requestBuiltin({ model, system, messages, tools }, providerOptions.ai, providerOptions);
    } catch (error) {
      /*
        THE FALLBACK MODEL (decided by the owner, 2026-10-09). A provider that
        failed after its retry costs the person a slower answer, never no
        answer: the turn goes on from the same messages on the setup's
        fallback model, once. The trace says so with the status, the meter is
        told the model that answered, and a benchmark counts how often it
        happened, because this is what production does too.
      */
      if (error instanceof ProviderError && fallback !== null && model !== fallback) {
        const ms = clock() - asked;
        timing.modelMs += ms;
        trace.push({ kind: "fallback", from: model, model: fallback, status: error.status ?? null, ok: true, ms });
        model = fallback;
        system = systemFor(model);
        round -= 1;
        continue;
      }
      // A failed turn is the one most worth seeing in the log, so the trace
      // so far travels with the error to `route.js`.
      if (error instanceof ProviderError) {
        const ms = clock() - asked;
        error.model = model;
        error.timing = {
          rounds: timing.rounds + 1,
          modelMs: timing.modelMs + ms,
          toolMs: timing.toolMs,
          trace: [...trace, { kind: "model", ok: false, ms, ...(error.status === null || error.status === undefined ? {} : { status: error.status }) }],
        };
      }
      throw error;
    }
    const roundMs = clock() - asked;
    timing.rounds += 1;
    timing.modelMs += roundMs;
    trace.push({
      kind: "model",
      ok: true,
      ms: roundMs,
      // Retried once by the gateway (`aiGateway.js`): noted, with what it was retried after.
      ...(answer.retried ? { retried: true, ...(answer.retried.status === null ? {} : { status: answer.retried.status }) } : {}),
    });
    if (answer.usage) {
      usage.input += answer.usage.input;
      usage.output += answer.usage.output;
      usage.cacheRead += answer.usage.cacheRead ?? 0;
      usage.cacheWrite += answer.usage.cacheWrite ?? 0;
    }

    if (answer.toolCalls.length === 0) {
      return { answer: answer.text, provider, model, steps, usage, timing: { ...timing, trace } };
    }

    messages.push({ role: "assistant", text: answer.text, toolCalls: answer.toolCalls });

    for (const call of answer.toolCalls) {
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
          name: call.name,
          text: "There is no such tool. Use only the tools you were given.",
          isError: true,
        });
        continue;
      }
      if (clock() - began >= toolBudgetMs) {
        // Answered in band, like an unknown tool: the model's next round is
        // the answer, written from what the calls so far returned.
        trace.push({ kind: "tool", tool: call.name, ok: false, ms: 0 });
        messages.push({ role: "tool", id: call.id, name: call.name, text: OUT_OF_TIME, isError: true });
        continue;
      }
      let result;
      const called = clock();
      try {
        result = await withinTime(
          webNames.has(call.name) ? web.call(call.name, call.args) : callTool(call.name, call.args),
          toolTimeoutMs,
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
        const text =
          error instanceof ToolTimeout ? TOOL_TIMED_OUT : "That call failed. Don't guess what it would have said.";
        result = { content: [{ type: "text", text }], isError: true };
      }
      const toolMs = clock() - called;
      timing.toolMs += toolMs;
      // A call the egress gate held for the person's yes is not a failure: it
      // runs when they give it (`route.js`), and a log that called it failed
      // would read as a broken tool.
      trace.push({ kind: "tool", tool: call.name, ok: result?.isError !== true, ms: toolMs, ...(result?.held === true ? { held: true } : {}) });
      steps.push({ tool: call.name, ok: result?.isError !== true });
      messages.push({
        role: "tool",
        id: call.id,
        name: call.name,
        text: toolResultText(result) || "(no result)",
        isError: result?.isError === true,
      });
    }
  }

  /*
    The bound was reached. Answered rather than thrown, and with whatever the
    model last said, because a person who asked a question is owed the work that
    was done for them — and because a turn that hits eight rounds is usually one
    long question rather than a broken one.
  */
  return {
    answer:
      "I ran out of steps before I finished that one. Here is where I got to — " +
      "ask me again and narrow it down if this is not enough.",
    provider,
    model,
    steps,
    usage,
    timing: { ...timing, trace },
    exhausted: true,
  };
}
