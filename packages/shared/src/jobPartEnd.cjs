/**
 * Part end: what a background job does after one of its parts (Dev2, 2026-11-17, "jobs as config", step 5).
 *
 * A job runs in parts. Until now the choice after each part (start the next one, send the last draft, or end and
 * say how) and the limits behind it (10 parts, 30 minutes; 96 parts and 4 hours on the person's own computer) were
 * code inside the texting Worker's `runJob` (`packages/tex/worker/jobRun.ts`). The timecards job showed what that costs:
 * every part died the same way and the next one was started anyway, ten times, and the answer was never sent. Here the
 * choice is one pure function, the Part end node's code (`packages/tex/gateway/agent/graph/nodes/partEnd.js`), and the limits
 * are that node's config (`limits`), so the Lab shows, tests and changes both.
 *
 * Plain CommonJS with no imports, so the gateway and the texting Worker read the same rules.
 */

/** The limits a job's parts run under when the config names none: today's numbers, so wiring this changes nothing. */
const DEFAULT_LIMITS = Object.freeze({ parts: 10, minutes: 30, machineParts: 96, machineMinutes: 240, resumeAfterMinutes: 2, staleParts: 0 });

/** Why a part ended (`packages/tex/worker/jobProgress.ts` `PartCause`). */
const CAUSES = Object.freeze(["done", "waiting", "stuck", "check_limit", "timeout", "crash", "model_down", "steps_out", "unfinished", "changed", "stopped", "refused"]);

/** Causes that would end the next part the same way: running it again only burns a part, so the last draft goes. */
const DETERMINISTIC = Object.freeze(["check_limit"]);

/** How a part's own check can read its answer (`checked`). */
const ENDS = Object.freeze(["done", "waiting", "stuck"]);

/** Causes where the part broke before it answered. */
const BROKEN = Object.freeze(["check_limit", "timeout", "crash"]);

/** Causes that leave work to do, so a next part picks it up while there is room. */
const CARRY = Object.freeze(["check_limit", "timeout", "crash", "steps_out", "unfinished", "changed"]);

/** Causes where the part answered but was not done, so a next part would go on looking (the `stale` rule). */
const LOOKING = Object.freeze(["steps_out", "unfinished"]);

/** A whole, positive number from config, or the default. */
const whole = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);

/** The limits a node's config gives, each falling back to today's number. */
function limitsOf(config) {
  const given = config && typeof config === "object" ? config : {};
  return {
    parts: whole(given.parts, DEFAULT_LIMITS.parts),
    minutes: whole(given.minutes, DEFAULT_LIMITS.minutes),
    machineParts: whole(given.machineParts, DEFAULT_LIMITS.machineParts),
    machineMinutes: whole(given.machineMinutes, DEFAULT_LIMITS.machineMinutes),
    resumeAfterMinutes: whole(given.resumeAfterMinutes, DEFAULT_LIMITS.resumeAfterMinutes),
    staleParts: whole(given.staleParts, DEFAULT_LIMITS.staleParts),
  };
}

/** The limits a whole config sets on its Part end node: every reader of a job's limits takes them from here. */
function configLimits(config) {
  const node = Array.isArray(config?.nodes) ? config.nodes.find((n) => n && n.id === "partEnd") : null;
  return limitsOf(node?.limits);
}

/** Whether a part may follow this one: under the part count and inside the time, the computer's own when it runs there. */
function roomLeft({ part, startedAt, now, machine }, limits) {
  const most = machine ? limits.machineParts : limits.parts;
  const minutes = machine ? limits.machineMinutes : limits.minutes;
  return part < most && now - startedAt < minutes * 60_000;
}

/**
 * What follows a part.
 *
 * `to`: "carry" starts the next part; "deliver" sends the last draft the job saved; "end" ends the job as `ended` says.
 * `ended` (with "deliver" and "end"): "done", "waiting", "stuck" or "failed".
 *
 * Input: `cause` (above), `part` (this part's number, from 1), `startedAt` and `now` (ms), `machine` (it runs on the
 * person's own computer), `hasDraft` (a draft is saved), `idle` (this part called no tool and wasn't done), `wasIdle`
 * (the part before it was idle too), `rejected` (turned down before it ran, as opposed to refused for now), `refusal`
 * (why a part was refused for now: "daily_limit" or "no_model"), `fresh` (how many of this part's tool results brought
 * back something no earlier part had), `staleBefore` (how many parts in a row before it brought back nothing new).
 *
 * A job still looking that found nothing new in `staleParts` parts in a row ends (`stale`), its answer sent as it
 * stands: another part would read the same pages again (2026-11-17, a coworking job whose check sent back six parts
 * for day pass prices the spaces' own sites don't publish). 0 turns the rule off.
 *
 * A part refused at today's limit pauses the job: it ends waiting with `resumeAt`, just after the limit resets
 * (counted per UTC day, `apps/convex/functions/lib/jev/meter.ts` `utcDay`), and starts again by itself then
 * (`packages/tex/worker/jobPause.ts`); `resumeAfterMinutes` is how long after the reset.
 */
function decidePartEnd(input, config) {
  const limits = limitsOf(config);
  const cause = CAUSES.includes(input?.cause) ? input.cause : "crash";
  const room = roomLeft(
    { part: Number(input?.part) || 1, startedAt: Number(input?.startedAt) || 0, now: Number(input?.now) || 0, machine: input?.machine === true },
    limits,
  );
  // Two parts in a row that called no tool and still weren't done are going nowhere: it ends stuck (2026-10-31).
  // `idle` already means the part was not done, whatever ended it (out of steps too).
  const spinning = input?.idle === true && input?.wasIdle === true && CARRY.includes(cause) && !BROKEN.includes(cause);
  // A part that broke with a draft saved sends it when the next part would break the same way, or no part is left:
  // never a job that ends with nothing (2026-11-17, the timecards job).
  if (BROKEN.includes(cause) && input?.hasDraft === true && (DETERMINISTIC.includes(cause) || !room)) {
    return { to: "deliver", ended: DETERMINISTIC.includes(cause) ? "done" : "stuck", cause, room };
  }
  const stale = limits.staleParts > 0 && LOOKING.includes(cause) && input?.fresh === 0 && (Number(input?.staleBefore) || 0) + 1 >= limits.staleParts;
  if (CARRY.includes(cause) && room && !spinning && !stale) return { to: "carry", cause, room };
  const pause = cause === "refused" && input?.rejected !== true && input?.refusal === "daily_limit" ? { resumeAt: limitResetAt(Number(input?.now) || 0, limits) } : {};
  return { to: "end", ended: endedAs(cause, input?.rejected === true, input?.checked), cause, room, ...(spinning ? { spinning: true } : {}), ...(stale && !spinning ? { stale: true } : {}), ...pause };
}

/** When a job paused at today's limit at `now` starts again: the next midnight UTC, plus `resumeAfterMinutes`. */
function limitResetAt(now, limits = DEFAULT_LIMITS) {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1) + limits.resumeAfterMinutes * 60_000;
}

/** How a job that ends here ended, by why its last part did. */
function endedAs(cause, rejected, checked) {
  // Out of steps with no room left, its answer ends as the part's own check said (done unless it was judged short).
  if (cause === "steps_out" && ENDS.includes(checked)) return checked;
  if (cause === "refused") return rejected ? "failed" : "waiting";
  if (cause === "waiting") return "waiting";
  if (cause === "done" || cause === "changed") return "done";
  if (cause === "stuck" || cause === "unfinished" || cause === "steps_out") return "stuck";
  return "failed"; // stopped, a crash or a timeout with nothing saved, a model that stayed down
}

module.exports = { CAUSES, DEFAULT_LIMITS, DETERMINISTIC, configLimits, decidePartEnd, limitResetAt, limitsOf, roomLeft };
