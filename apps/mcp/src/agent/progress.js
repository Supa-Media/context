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
 *   line now and returns at once;
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

export const PROGRESS_TOOL = "text_progress";
export const PROGRESS_CONTENT_TYPE = "application/x-ndjson";

/** Progress texts one turn may send: enough for a long task, never a flood. */
export const MAX_PROGRESS_TEXTS = 8;
/** One progress text is a line, not an answer. */
export const MAX_PROGRESS_CHARS = 280;

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
    "Text the person one short line now, while you keep working: what you are about to do or what you just found " +
    "(\"Opening ChatGPT now.\", \"Signed in. Adding the connector.\"). Use it on a task that takes several steps, " +
    "first to say you're on it and then at real milestones. Never for a question you can answer straight away, " +
    "never to ask a question (ask in your answer and stop), and never with the final answer, which is your reply.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "One short plain sentence, no Markdown." } },
    required: ["text"],
    additionalProperties: false,
  },
};

export const PROGRESS_PROMPT =
  "\n\nThis can be a long task over text. If it will take more than a couple of steps (opening websites, filling " +
  "forms, working through several notes), first call text_progress with one short line saying what you're doing, " +
  "then again at real milestones, and finish with the result as your reply. Don't send progress for a quick question.";

/**
 * The progress tool for one turn, around `send(text)` (which writes a line to
 * the stream). Returns an MCP-shaped result the model reads.
 */
export function progressChannel(send, { max = MAX_PROGRESS_TEXTS } = {}) {
  let sent = 0;
  let last = "";
  return {
    tool: PROGRESS_TOOL_DEFINITION,
    get sent() {
      return sent;
    },
    async call(args) {
      const text = typeof args?.text === "string" ? args.text.replace(/\s+/g, " ").trim() : "";
      if (!text) return result("Nothing to send: pass one short line as text.", true);
      if (text === last) return result("Already sent. Keep working.");
      if (sent >= max) return result("That's enough progress texts for this task. Keep working and reply with the result.", true);
      sent += 1;
      last = text;
      await send(text.length > MAX_PROGRESS_CHARS ? `${text.slice(0, MAX_PROGRESS_CHARS - 1)}…` : text);
      return result("Sent. Keep working.");
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
      const response = await run((text) => write({ progress: text }));
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
