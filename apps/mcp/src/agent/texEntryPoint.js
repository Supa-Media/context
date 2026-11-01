/**
 * THE TEX ENTRY POINT: every step a texted turn takes, timed by name (Dev2,
 * 2026-11-01: "anything that runs has to be a function call inside of Tex
 * entry point, and everything in there has to log how much time it's
 * taking ... so that we are never guessing").
 *
 * `agentTurn` in `route.js` runs between the `TEX ENTRY POINT: begin` and
 * `end` markers, and every `await` in there is one of this object's calls:
 *
 * - `tex.step(name, run, off)`: run now and wait for it.
 * - `tex.ahead(name, run, off)`: start now, wait later (`tex.wait`).
 * - `tex.wait(name, promise)`: how long a started step held the turn up.
 * - `tex.after(name, run)`: ours, not the person's: runs once the response
 *   has gone, still timed.
 *
 * `scripts/tex-entry-check.mjs` fails CI (and the Claude Code hook in
 * `.claude/settings.json`) on any bare `await` between the markers, so a new
 * step cannot join the reply path untimed.
 *
 * Each finished step is one point in Workers Analytics Engine (`TEX_ENTRY`,
 * dataset `tex_entry`): blobs = surface ("gateway"), the turn's kind, the
 * step, its state (ok, failed, off); doubles = its milliseconds and when it
 * started, from the turn's start; index = the workspace, so one person's
 * texts and everyone's can both be added up. Names, counts and times only,
 * never a word anyone wrote. A `to_response` point marks when the answer was
 * handed back, and `after:*` points come later. Without the binding nothing
 * is written.
 *
 * TURNED OFF ON A CHAT'S TEXT. Dev2 (2026-11-01): everything but reading
 * what Tex holds, the model and the send is off for now, "and we'll go from
 * there". A step named in `OFF_IN_CHATS` is skipped on a one-to-one or group
 * text when the deployment sets `TEX_LEAN = "on"`, and its fallback is used
 * instead; it still logs, as `off`, so the list stays honest. Taking a name
 * off the list turns that step back on. Jobs, reports and routines are
 * nobody's wait and keep every step. What is never on the list: the session
 * and storage checks, the privacy engine, a texted yes, the approval held
 * for an email, and the cap check (`allowed`, which runs beside the model
 * instead of before it).
 */
export const OFF_IN_CHATS = new Set([
  "waiting_asks", // the open approvals listed for the model before it answers; a texted yes still settles them
  "kept_files_again", // files from earlier texts shown again
  "learned_skills", // the index of skills Tex wrote itself
  "google_offer", // the once-only "connect Google" line, and its mail-health call
  "group_turn_records", // a group turn is always treated as having read from outside, so its turn records add nothing
]);

/** The kinds a person is waiting on. */
const CHAT_KINDS = new Set(["one", "group"]);
/** Analytics Engine takes 250 points a request; a turn never needs this many. */
const MAX_POINTS = 200;

/**
 * @param {{ TEX_ENTRY?: { writeDataPoint(point: object): void }, TEX_LEAN?: string }} env
 * @param {{ who?: string, now?: () => number, later?: Array<Function> }} [options]
 */
export function texEntry(env, { who = "", now = Date.now, later = [] } = {}) {
  const start = now();
  const steps = [];
  let kind = "unknown";
  let written = 0;
  const record = (name, at, state) => {
    const ms = Math.max(0, now() - at);
    const entry = { name, ms, at: at - start, state };
    steps.push(entry);
    write(env, entry, kind, who, () => (written += 1) <= MAX_POINTS);
    return entry;
  };
  const off = (name) => env?.TEX_LEAN === "on" && CHAT_KINDS.has(kind) && OFF_IN_CHATS.has(name);
  const timed = (name, run) => {
    const at = now();
    let result;
    try {
      result = typeof run === "function" ? run() : run;
    } catch (error) {
      record(name, at, "failed");
      throw error;
    }
    return Promise.resolve(result).then(
      (value) => (record(name, at, "ok"), value),
      (error) => {
        record(name, at, "failed");
        throw error;
      },
    );
  };
  const tex = {
    /** What kind of turn this is (`turnKind`), once known: it picks which steps are off. */
    set kind(value) {
      kind = typeof value === "string" ? value : "unknown";
    },
    get kind() {
      return kind;
    },
    /** Whether `name` is turned off on this turn. */
    isOff: off,
    /** A chat's text on a lean deployment: what can wait runs beside the model instead of before it (`allowed`, `steer_begin`). */
    get lean() {
      return env?.TEX_LEAN === "on" && CHAT_KINDS.has(kind);
    },
    /** Run a step and wait for it; an off step returns `fallback` without running. */
    step(name, run, fallback) {
      if (off(name)) return (record(name, now(), "off"), Promise.resolve(fallback));
      return timed(name, run);
    },
    /** Start a step now, to `wait` for later; its rejection is never left unhandled. */
    ahead(name, run, fallback) {
      const started = tex.step(name, run, fallback);
      started.catch(() => {});
      return started;
    },
    /** How long a step started with `ahead` held the turn up. */
    wait(name, started) {
      return timed(`wait:${name}`, () => started);
    },
    /** Work that is ours, run once the response is ready (`deferred.js` `afterTurn`); a promise already running is only timed. */
    after(name, work) {
      if (typeof work === "function") later.push(() => timed(`after:${name}`, work));
      else timed(`after:${name}`, work).catch(() => {});
      return Promise.resolve();
    },
    /** After the response when `later` is true (the front door's chat save), else now. */
    behind(later, name, work) {
      return later ? tex.after(name, work) : tex.step(name, work);
    },
    /** The answer is handed back now. */
    responded() {
      record("to_response", start, "ok");
    },
    /** Every step so far, in the order they finished (tests, the log line). */
    steps,
  };
  return tex;
}

/**
 * A turn's tools, held until the model is allowed (`allowed` beside the model):
 * no tool runs on a turn whose check said no, or could not be had. With no
 * pending check, the tools as they were.
 */
export function allowedFirst(allowed, callTool) {
  if (allowed === null || allowed === undefined) return callTool;
  return async (name, args) => {
    await allowed;
    return callTool(name, args);
  };
}

function write(env, entry, kind, who, room) {
  const dataset = env?.TEX_ENTRY;
  if (!dataset || typeof dataset.writeDataPoint !== "function" || !room()) return;
  try {
    dataset.writeDataPoint({ blobs: ["gateway", kind, entry.name, entry.state], doubles: [entry.ms, entry.at], indexes: [String(who).slice(0, 96)] });
  } catch {
    // Diagnostics never fail a turn.
  }
}
