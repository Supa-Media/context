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
 *   just before a slow step outside their notes, and for something they could
 *   act on before the answer, never the answer itself;
 * - a line opens with what Tex is doing and never says something is done
 *   (`claimsDone`): that is the answer's. A code check, so a line costs no model call;
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
    "Text the person one short line now, while you keep working. Only just before a slow step that reaches outside their notes " +
    "(opening a site, browsing, a long job of many steps), saying what you're doing (\"Opening OpenTable for Friday.\"), or for " +
    "something they could act on before your answer, like a link they must open. Start it with what you're doing now. Never before " +
    "a search, a note read or asking your advisor, never the answer itself, and never that something is done, sent or booked: " +
    "that is your reply. Never to say you're on it, that it will take a while, or that you'll text when it's done (the person " +
    "called that the most useless text they get), and never to ask a question (ask in your answer and stop).",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "One short plain sentence, no Markdown." } },
    required: ["text"],
    additionalProperties: false,
  },
};

export const PROGRESS_PROMPT =
  "\n\nJust before a slow step that reaches outside their notes (opening a site, browsing, a long job of many steps), you may " +
  "send with action progress, args { text }: what you're doing (\"Opening OpenTable for Friday.\"). Never before a search, a note " +
  "read or asking your advisor. After that, only what they could act on before your answer. Never the answer itself or that " +
  "something is done. Never send a line saying you're on it or that you'll text when it's done.";

/*
  A line opens with what Tex is doing ("Opening OpenTable for Friday.", "Now
  checking Bo's calendar"), names what it found ("Found 3 tables at Nopa."),
  or carries a link; one that opens with a change made ("Emailed Bo",
  "Booked the 7pm") never goes, whatever follows it. Checked by its shape,
  not by the turn's tool results: a true "Emailed Bo." is the answer's too.
  Measured on the three reviews' probes (2026-11-01, 39 doing or finding
  lines, 44 done claims): 4 refused and 1 sent ("Holding Friday at 6."),
  against 21 and 30 for the done-word list it replaces.
*/
const CHANGED = /^\W*(?:emailed|booked|sent|added|cancell?ed|moved|reserved|paid|ordered|invited|rescheduled|submitted|placed|replied|forwarded|deleted|removed|created|saved|updated|signed up|bought|got)\b/i;
const DOING = /^(?:(?:now|still|just|also|next|i'm|we're)\s+)?([a-z]{3,}ing)\b(?!\s+(?:went|is|was|has|worked|succeeded|failed|done)\b)/i;
const NOT_A_VERB = /^(?:nothing|something|anything|everything|morning|evening|thing|king|ring|string|wing|ceiling|wedding|spring)$/i;

export function claimsDone(text) {
  const said = String(text ?? "").replace(/[\u2018\u2019]/g, "'").trim();
  if (CHANGED.test(said)) return true;
  if (/https?:\/\//i.test(said) || /^found\b/i.test(said)) return false;
  return !said.split(/[,;.!?]+|\band\b|\bthen\b/i).some((clause) => {
    const doing = DOING.exec(clause.trim());
    return doing !== null && !NOT_A_VERB.test(doing[1]);
  });
}

export const DONE_NOTICE =
  "Not sent: start a progress line with what you're doing now (\"Opening OpenTable for Friday.\"), never with what is done, " +
  "sent or booked. That is your reply, once a tool says it happened.";

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
      if (lines.includes(text)) return result("Not sent: you already sent that line in this turn. Keep working.");
      if (claimsDone(text)) return result(DONE_NOTICE, true);
      lines.push(text);
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
