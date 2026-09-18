/**
 * One agent turn: a question, the tools this connection already holds, and a
 * model account the customer connected.
 *
 * ## What this is, in one line
 *
 * The same authority as `/mcp`, driven by a model instead of by a client. The
 * session, the store, the scope clamp and the tool dispatcher are the ones
 * `index.js` built for the request — so there is no second answer anywhere to
 * "may this caller do that", which is the property that matters most here.
 *
 * ## Writes are proposals
 *
 * The agent is offered the read tools and `propose_note`, and never
 * `write_note`, `move_note`, `set_visibility` or anything else that changes the
 * bucket. Not because a model cannot be trusted with a write — the scope clamp
 * would already refuse one this connection may not make — but because a note is
 * the customer's own record of their work, and an edit they did not read is a
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

import { AGENT_PROVIDERS, ProviderError, modelFor, requestCompletion } from "./providers.js";

/**
 * How many times the model may call tools before the turn ends.
 *
 * A bound on somebody's bill as much as on latency: each round is a model call
 * they pay for. Eight is enough for orient → search → read a few notes →
 * answer, which is the shape of almost every real question, and a turn that
 * needs more is one the person is better off steering.
 */
const MAX_ROUNDS = 8;

/** The one write the agent may make, and it is not a write to the bucket. */
const PROPOSAL_TOOL = "propose_note";

/** The longest question this route accepts. */
export const MAX_QUESTION_LENGTH = 8000;

/** The longest any one field of the ambient place may be. A path, not a page. */
const MAX_PLACE_FIELD = 512;

/**
 * The biggest tool answer that goes back to the model.
 *
 * A long note is a legitimate answer, so this is generous — but it is a bound,
 * because without one a single `read_note` on a large file decides how many
 * tokens the customer is billed for, and the model gets a worse prompt out of
 * it than a truncated one with a line saying so.
 */
const MAX_TOOL_RESULT_CHARS = 60_000;

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
    (tool) => tool.annotations?.readOnlyHint === true || tool.name === PROPOSAL_TOOL,
  );
}

/**
 * The system prompt.
 *
 * Deliberately short. A long one competes with the tool descriptions, which are
 * written for exactly this reader and are already the product's best statement
 * of what each call is for.
 */
export function systemPrompt(place) {
  const lines = [
    "You are the assistant inside Context, the person's own notes.",
    "Answer from their notes rather than from memory: search and read before you answer.",
    "Their notes are the record — when a note and your recollection disagree, the note wins.",
    "Be brief. Cite the note path you took something from.",
    "You cannot edit their notes. To suggest a change, use propose_note; they review and decide.",
  ];

  const where = describePlace(place);
  if (where) lines.push("", where);
  return lines.join("\n");
}

/**
 * Where the person is, as a sentence.
 *
 * References only — a path, a visibility, whether something is unsaved. The
 * note's text is not here and must not be: the agent reads it through the same
 * tools and the same privacy engine as any other caller, or the ambient context
 * becomes a way to hand a model something the clamp never approved.
 */
export function describePlace(place) {
  if (!place || typeof place !== "object") return "";
  const parts = [];
  const name = bounded(place.context);
  if (name) parts.push(`They are in the context @${name}.`);
  const note = place.note;
  const path = note && typeof note === "object" ? bounded(note.path) : "";
  if (path) {
    const state = note.unsaved === true ? " (with unsaved edits)" : "";
    parts.push(`The note open in front of them is ${path}${state}.`);
    if (note.readable === false) {
      // Said out loud rather than left to a failed read. A note that has never
      // been written, or one this build cannot decrypt, is not a note the agent
      // can fetch — and a model that knows why stops trying.
      parts.push("Its contents are not readable through your tools right now.");
    }
  }
  if (place.meetingLive === true) parts.push("A meeting is being recorded right now.");
  return parts.join(" ");
}

/**
 * A short string from the place, or nothing.
 *
 * The app builds the place and the app is the person's own client, so this is
 * not a trust boundary — it is a *length* boundary. Every field here ends up in
 * the system prompt on a request the customer pays for by the token, and a
 * client with a bug that puts a whole document in `note.path` should cost them
 * one confused answer rather than a bill.
 */
function bounded(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PLACE_FIELD
    ? value
    : "";
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

/**
 * Open the model account this turn will spend.
 *
 * With a provider named, that one or nothing. With none named, the providers
 * are tried in a fixed order and the first that opens wins — there is
 * deliberately no `selected` column on the control plane's table, because two
 * rows could both claim it, so "which provider" is a question the caller
 * answers and this is only the default for a caller that did not.
 */
export async function openProvider(controlPlane, session, requested) {
  if (requested !== undefined && requested !== null) {
    if (!AGENT_PROVIDERS.includes(requested)) {
      // The same refusal as "connected nothing". A distinguishable answer would
      // let a caller enumerate which providers this build can spend, which is
      // not a secret worth much — but the control plane already refuses to
      // distinguish them and two halves of one route disagreeing is how the
      // interesting version of that bug arrives.
      throw new AgentRefusal("no_provider", "No model account is connected to this context.");
    }
    const opened = await controlPlane.getProviderCredential(
      session.accessToken,
      session.workspaceId,
      requested,
    );
    if (opened === null) {
      throw new AgentRefusal("no_provider", "No model account is connected to this context.");
    }
    return opened;
  }

  for (const provider of AGENT_PROVIDERS) {
    const opened = await controlPlane.getProviderCredential(
      session.accessToken,
      session.workspaceId,
      provider,
    );
    if (opened !== null) return opened;
  }
  throw new AgentRefusal("no_provider", "No model account is connected to this context.");
}

/**
 * Run one turn to completion.
 *
 * @param {object} options
 * @param {string} options.question what the person asked
 * @param {object|null} options.place the ambient context; references only
 * @param {{provider: string, apiKey: string}} options.credential
 * @param {Array} options.tools the offered tool definitions, already clamped
 * @param {(name: string, args: object) => Promise<object>} options.callTool
 * @param {object} options.env the Worker environment, for the model default
 * @param {string} [options.model] a model this call names instead of the default
 * @param {{fetchImpl?: Function}} [options.providerOptions]
 * @returns {Promise<{answer: string, provider: string, model: string, steps: Array}>}
 */
export async function runTurn(options) {
  const {
    question,
    place = null,
    credential,
    tools,
    callTool,
    env,
    model: requestedModel,
    providerOptions = {},
  } = options;

  const provider = credential.provider;
  const model = modelFor(provider, env, requestedModel);
  const system = systemPrompt(place);
  const messages = [{ role: "user", text: question }];
  /*
    What the turn did, by name only. The arguments a tool was called with can
    carry a path and a query — facts about what somebody is looking for in their
    own notes — so the steps record *that* a call happened and what it was
    called, which is what a person watching a spinner wants, and nothing that
    would make this a transcript of their thinking.
  */
  const steps = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const answer = await requestCompletion(
      provider,
      { model, system, messages, tools, apiKey: credential.apiKey },
      providerOptions,
    );

    if (answer.toolCalls.length === 0) {
      return { answer: answer.text, provider, model, steps };
    }

    messages.push({ role: "assistant", text: answer.text, toolCalls: answer.toolCalls });

    for (const call of answer.toolCalls) {
      let result;
      try {
        result = await callTool(call.name, call.args);
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
        result = { content: [{ type: "text", text: "That call failed." }], isError: true };
      }
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
    exhausted: true,
  };
}
