/**
 * LONG TASKS OVER TEXT: PROGRESS WHILE THE TURN RUNS.
 *
 * A question about the person's notes is answered in seconds. A task, such as
 * "set Context up in my ChatGPT" or "find me a table for four on Friday", is
 * many steps, and a text that arrives after five silent minutes reads as
 * broken (the owner, 2026-10-10: text Tex and have it do real work). So a
 * texted turn may say where it has got to while it works:
 *
 * - the model is offered `text_progress`, which texts the person one short
 *   line now and returns at once, as many times in a turn as it judges useful
 *   (Dev2, 2026-11-01, `docs/decisions/texting-assistant/interleaved-updates.md`):
 *   a heads-up naming what it is about to do, then what it finds;
 * - a line never says something is done (`claimsDone`): that is the answer's,
 *   once a tool says it happened. A code check, so a line costs no model call;
 * - the texting Worker asks for the turn as a stream (`Accept:
 *   application/x-ndjson`), and this route writes each progress line as it
 *   happens, a heartbeat while nothing does, and the turn's ordinary JSON
 *   answer as the last line, with its status.
 *
 * The final line is exactly what the plain route would have returned, so the
 * authority, the meter, the turn log and the conversation history are the
 * route's own and nothing here decides any of them.
 *
 * A streamed turn is also the long one: it may take more rounds and more tool
 * time than a quick answer (`LONG_MAX_ROUNDS`, `LONG_TOOL_BUDGET_MS`), because
 * the person is being told what is happening rather than left with a bubble.
 *
 * Progress is words the model wrote, going to the person who asked, on the
 * channel the answer goes to anyway. It widens nothing: it is the answer,
 * early and in pieces.
 */

import { claimsAChange } from "./claimCheck.js";

export const PROGRESS_TOOL = "text_progress";
export const PROGRESS_CONTENT_TYPE = "application/x-ndjson";

/** One progress text is a line, not an answer. */
export const MAX_PROGRESS_CHARS = 280;

/** Lines the gateway itself may text in one turn (`say`), and how long each may be. */
export const MAX_GATEWAY_TEXTS = 4;
export const MAX_GATEWAY_CHARS = 1000;

/** The most model rounds a streamed (long) turn may take. */
export const LONG_MAX_ROUNDS = 30;
/**
 * How long a streamed turn may keep calling tools. Inside the texting
 * Worker's own cap (`apps/agent`, 12 minutes), which is inside a Durable
 * Object alarm's 15.
 */
export const LONG_TOOL_BUDGET_MS = 9 * 60_000;

/** A line every so often while nothing else is written, so no hop idles the stream out. */
export const HEARTBEAT_MS = 15_000;

/** Whether the caller asked for the turn as a stream of progress lines. */
export function wantsProgress(request) {
  const accept = request?.headers?.get?.("accept") ?? "";
  return accept.toLowerCase().includes(PROGRESS_CONTENT_TYPE);
}

export const PROGRESS_TOOL_DEFINITION = {
  name: PROGRESS_TOOL,
  description:
    "Text the person one short line now, while you keep working: what you're about to do (\"Checking your Friday calendar.\"), " +
    "something you just found, or a link they must open. It goes at once as its own text. Say what you're doing or found, never " +
    "that something is done, sent or booked: that is your reply, once a tool says it happened. Never to say you're on it, " +
    "that it will take a while, or that you'll text when it's done (the person called that the most useless text they get), " +
    "never for a question you can answer straight away, never to ask a question (ask in your answer and stop), and never " +
    "with the final answer, which is your reply.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "One short plain sentence, no Markdown." } },
    required: ["text"],
    additionalProperties: false,
  },
};

export const PROGRESS_PROMPT =
  "\n\nBefore work that needs tools, send with action progress, args { text }: one line naming what you're about to do " +
  "(\"Checking your Friday calendar.\"), then do it. While you work, send another line whenever you find something they'd " +
  "want now; each goes at once as its own text. A line says what you're doing or found, never that something is done, sent " +
  "or booked. Never send a line saying you're on it or that you'll text when it's done. Don't repeat a line in your reply.";

/**
 * A line that says something is done: the claim check's own words
 * (`claimCheck.js` `claimsAChange`) and the done-words a task ends on, said
 * of Tex's own work or as the line's last word ("Email sent."). Read in code,
 * so checking a line costs nothing a person waits on; what it found ("Bo
 * booked the 7pm last week") still goes.
 */
const DONE = [
  /^\W*(?:done|sent|booked|scheduled|confirmed|ordered|paid|submitted|reserved|finished|all set)\b/i,
  /\b(?:I(?:'ve| have)?|we(?:'ve| have)?|it'?s|that'?s|they'?re|(?:is|are) now|all)\s+(?:just\s+|now\s+|already\s+|all\s+)?(?:done|sent|booked|scheduled|confirmed|ordered|paid|submitted|cancell?ed|reserved|emailed|finished|completed|set up)\b/i,
  /\b(?:done|sent|booked|confirmed|ordered|paid|submitted|reserved|all set)\s*[.!]*\s*$/i,
];

export function claimsDone(text) {
  const said = String(text ?? "").replace(/[‘’]/g, "'");
  return claimsAChange(said) || DONE.some((pattern) => pattern.test(said));
}

export const DONE_NOTICE =
  "Not sent: a progress line says what you're doing or found, never that something is done, sent or booked. " +
  "Say that in your reply once a tool says it happened, or send what you're doing now.";

/**
 * The progress tool for one turn, around `send(text)` (which writes a line to
 * the stream). Returns an MCP-shaped result the model reads.
 */
export function progressChannel(send) {
  let said = 0;
  const lines = [];
  return {
    tool: PROGRESS_TOOL_DEFINITION,
    /**
     * Text the person a line the gateway wrote, not the model: a browser's
     * live sign-in link the moment it exists, so they can act while the task
     * waits. The model never sees what is said here; this has its own small cap.
     */
    async say(text) {
      const line = typeof text === "string" ? text.trim() : "";
      if (!line || said >= MAX_GATEWAY_TEXTS) return false;
      said += 1;
      await send(line.length > MAX_GATEWAY_CHARS ? line.slice(0, MAX_GATEWAY_CHARS) : line);
      return true;
    },
    async call(args) {
      const text = typeof args?.text === "string" ? args.text.replace(/\s+/g, " ").trim() : "";
      if (!text) return result("Nothing to send: pass one short line as text.", true);
      if (text === lines.at(-1)) return result("Already sent. Keep working.");
      if (claimsDone(text)) return result(DONE_NOTICE, true);
      lines.push(text);
      await send(text.length > MAX_PROGRESS_CHARS ? `${text.slice(0, MAX_PROGRESS_CHARS - 1)}…` : text);
      return result("Sent. Keep working.");
    },
    /** `answer` without the rows (or a row's opening) a line already said, unless nothing would be left. */
    unsaid(answer) {
      if (typeof answer !== "string" || lines.length === 0) return answer;
      const rows = answer.split("\n").map((row) => {
        let rest = row.replace(/\s+/g, " ").trim();
        for (const line of lines) if (rest === line || rest.startsWith(`${line} `)) rest = rest.slice(line.length).trim();
        return rest === row.replace(/\s+/g, " ").trim() ? row : rest;
      });
      const left = rows.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      return left === "" ? answer : left;
    },
  };
}

function result(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Run `run(progress)` (which returns the route's ordinary Response) and stream
 * it: `{"progress": "..."}` lines as they happen, `{"tick": n}` while nothing
 * does, and last `{"status": 200, "body": {...}}`.
 *
 * The HTTP status of the stream itself is 200; the turn's status travels in
 * the last line, because it is only known at the end.
 *
 * @param {(progress: (text: string) => Promise<void>) => Promise<Response>} run
 * @param {{waitUntil?: (work: Promise<unknown>) => void, heartbeatMs?: number}} [options]
 */
export function streamTurn(run, { waitUntil = null, heartbeatMs = HEARTBEAT_MS } = {}) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let open = true;
  let chain = Promise.resolve();
  const write = (line) => {
    chain = chain.then(async () => {
      if (!open) return;
      try {
        await writer.write(encoder.encode(`${JSON.stringify(line)}\n`));
      } catch {
        // The reader went away. The turn still finishes, so its history, meter
        // and log are kept; nobody is left to read the rest.
        open = false;
      }
    });
    return chain;
  };
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
    write({ tick: ticks });
  }, heartbeatMs);

  const work = (async () => {
    try {
      // `step`: a background job's own steps, for the chat to audit (`background.js`).
      const response = await run((text) => write({ progress: text }), (text) => write({ step: text }));
      const body = await response.json().catch(() => null);
      await write({ status: response.status, body });
    } catch (error) {
      // Opaque to the caller, like the route's own unhandled errors: the
      // error's name goes to this deployment's logs, never its message, which
      // can quote a note.
      console.log(JSON.stringify({ event: "agent_stream_error", name: error?.name ?? "Error" }));
      await write({ status: 500, body: { error: "server_error" } });
    } finally {
      clearInterval(heartbeat);
      await chain;
      open = false;
      await writer.close().catch(() => {});
    }
  })();
  if (typeof waitUntil === "function") waitUntil(work);

  return new Response(readable, {
    status: 200,
    headers: { "content-type": PROGRESS_CONTENT_TYPE, "cache-control": "no-store" },
  });
}
