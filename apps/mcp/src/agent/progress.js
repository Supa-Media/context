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
    "Text the person one short line now, while you keep working, only for something they could act on before your answer, like a " +
    "link they must open or a sign-in code, or a step that will change something outside their notes (\"Booking the 7pm at Lilia now.\"). " +
    "Never to narrate a search, a lookup or which sites you're checking (Nov Babies, 2026-11-11: \"Searching NYC karaoke spots…\" added " +
    "nothing): a long task goes to a background job, whose start line says what they'll get. Every " +
    "line must be new to them or something to act on, fewer the longer the task runs. Start it with what you're doing now. Never before " +
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

/** The chat's progress updates, said up front (Dev2, 2026-11-01). Off says nothing: the tool is not offered. */
export const NORMAL_LEAD = "This chat gets your progress lines.";
export const PLAN_ONLY_LEAD = "This chat wants only your plan line: at most one progress line per turn, and none for a quick ask.";

/** The plan line, for a task you expect to run past about a minute. The example must pass `claimsDone`. */
export const PLAN_EXAMPLE = "Checking OpenTable and Resy for Friday, then the best three.";
const PLAN_LINE =
  "For a task you expect to take more than about a minute (opening sites, browsing, a long job of many steps), send with action " +
  `progress, args { text }, one line with your plan ("${PLAN_EXAMPLE}"), then start at once without asking; they can text to stop you. `;
const NEVER =
  "Never the answer itself or that something is done. Never send a line saying you're on it or that you'll text when it's done.";

/**
 * No plan line and no "Opening OpenTable" line any more (Dev2, 2026-11-12, Nov Babies 6d): two "Searching…" lines went
 * to a group and added nothing. A long task goes to a background job, whose start line says what they'll get (`jobStart.js`).
 */
export const PROGRESS_PROMPT =
  `\n\n${NORMAL_LEAD} ` +
  "Text a line (send with action progress, args { text }) only for something they could act on before your answer (a link to open, a sign-in code), or just before a step " +
  "that changes something outside their notes (\"Booking the 7pm at Lilia now.\"). Never to narrate a search, a lookup or which " +
  "sites you're checking, and never before a search, a note read or asking your advisor: a long task goes to a background job, " +
  "whose start line says what they'll get. " +
  NEVER;

export const PLAN_ONLY_PROMPT = `\n\n${PLAN_ONLY_LEAD} ${PLAN_LINE}${NEVER}`;

/** What a turn is told of progress at a chat's level (`readUpdates`): off is told nothing. */
export const progressPrompt = (level) => (level === "off" ? "" : level === "planOnly" ? PLAN_ONLY_PROMPT : PROGRESS_PROMPT);

/*
  A line opens with what Tex is doing ("Opening OpenTable for Friday.", "Now
  checking Bo's calendar"), names what it found ("Found 3 tables at Nopa."),
  or carries a link; one with any clause opening with a change made ("Emailed Bo",
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
  const clauses = said.split(/[,;.!?]+|\band\b|\bthen\b/i).map((clause) => clause.trim());
  if (clauses.some((clause) => CHANGED.test(clause) || /^all set\b/i.test(clause))) return true;
  if (/https?:\/\//i.test(said) || /^found\b/i.test(said)) return false;
  return !clauses.some((clause) => {
    const doing = DOING.exec(clause);
    return doing !== null && !NOT_A_VERB.test(doing[1]);
  });
}

export const DONE_NOTICE =
  "Not sent: start a progress line with what you're doing now (\"Opening OpenTable for Friday.\"), never with what is done, " +
  "sent or booked. That is your reply, once a tool says it happened.";

/** Said when a chat set progress updates to plan only (Dev2, 2026-11-01) and its one line went. */
export const PLAN_ONLY_NOTICE = "Not sent: this chat gets one plan line per turn, and that one went. Keep working; your reply says the rest.";

/**
 * The progress tool for one turn, around `send(text)` (which writes a line to
 * the stream). Returns an MCP-shaped result the model reads. `planOnly`: the
 * chat's progress updates are plan only, so one line goes and the rest are
 * refused, a backstop to what the prompt says (part B of the owner's decisions).
 * `level` (off, planOnly or normal) is the chat's setting; at off the route
 * keeps the channel for `say` alone, so a sign-in link still goes.
 */
export function progressChannel(send, { planOnly = false, level = planOnly ? "planOnly" : "normal", job = false } = {}) {
  let said = 0;
  const lines = [];
  const plan = level === "planOnly";
  return {
    tool: plan ? { ...PROGRESS_TOOL_DEFINITION, description: `${PLAN_ONLY_LEAD} ${PROGRESS_TOOL_DEFINITION.description}` } : PROGRESS_TOOL_DEFINITION,
    /** Off: the model is not offered the tool, though `say` still texts the gateway's own lines. */
    offered: level !== "off",
    prompt: progressPrompt(level),
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
    // No reviewer reads a progress line (Dev2, 2026-11-11, one-judge PR 3): the code checks above do.
    async call(args) {
      const text = typeof args?.text === "string" ? args.text.replace(/\s+/g, " ").trim() : "";
      if (!text) return result("Nothing to send: pass one short line as text.", true);
      if (lines.includes(text)) return result("Not sent: you already sent that line in this turn. Keep working.");
      if (claimsDone(text)) return result(DONE_NOTICE, true);
      if (plan && lines.length > 0) return result(PLAN_ONLY_NOTICE, true);
      lines.push(text);
      await send(text.length > MAX_PROGRESS_CHARS ? `${text.slice(0, MAX_PROGRESS_CHARS - 1)}…` : text);
      // A job's line is texted only when it holds a link (`apps/agent/src/jobRun.ts` `HAS_LINK`); the rest update its
      // status. Told "Sent", a job believed the chat had heard from it (Nov Babies, 2026-11-12).
      if (job && !HAS_LINK.test(text)) return result(JOB_NOTED);
      return result("Sent. Keep working.");
    },
  };
}

const HAS_LINK = /https?:\/\//i;
/** What a job is told for a line with no link: it updates the job's status, and nobody is texted. */
export const JOB_NOTED = "Noted on your job's status, not texted: only a line with a link reaches them, and they hear your result when you report. Keep working.";

function result(text, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Run `run(progress)` (which returns the route's ordinary Response) and stream
 * it: `{"progress": "..."}` lines as they happen, `{"step": "..."}` for a
 * job's own steps, `{"tick": n}` while nothing does, for a job's part one
 * `{"answered": {...}}` as soon as its answer is ready (before the advisor's
 * check, so the answer outlives a failure after it), and last
 * `{"status": 200, "body": {...}}`.
 *
 * The HTTP status of the stream itself is 200; the turn's status travels in
 * the last line, because it is only known at the end.
 *
 * @param {(progress: (text: string) => Promise<void>, step: (text: string, how?: object) => Promise<void>, answered: (body: object) => Promise<void>) => Promise<Response>} run
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
      // `answered`: a job's part's answer, sent before its advisor's check, so a reader whose stream then dies still has it
      // (`texEntryPoint/sendTheReply.js`; 2026-11-08, the gateway ran out of memory in the check and the part ran again).
      const response = await run(
        (text) => write({ progress: text }),
        (text, how) => write({ step: text, ...(how?.failed ? { failed: true } : {}), ...(how?.why ? { why: how.why } : {}) }),
        (body) => write({ answered: body }),
      );
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
