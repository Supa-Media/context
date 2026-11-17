/**
 * Part end: what a background job does after one of its parts (Dev2, 2026-11-17, "jobs as config", step 5).
 *
 * A job runs in parts. Until now the choice after each part (start the next one, send the last draft, or end and
 * say how) and the limits behind it (10 parts, 30 minutes; 96 parts and 4 hours on the person's own computer) were
 * code inside the texting Worker's `runJob` (`apps/agent/src/jobRun.ts`). The timecards job showed what that costs:
 * every part died the same way and the next one was started anyway, ten times, and the answer was never sent. Here the
 * choice is one pure function, the Part end node's code (`apps/mcp/src/agent/graph/nodes/partEnd.js`), and the limits
 * are that node's config (`limits`), so the Lab shows, tests and changes both.
 *
 * Plain CommonJS with no imports, so the gateway and the texting Worker read the same rules.
 */

/** The limits a job's parts run under when the config names none: today's numbers, so wiring this changes nothing. */
const DEFAULT_LIMITS = Object.freeze({ parts: 10, minutes: 30, machineParts: 96, machineMinutes: 240 });

/** Why a part ended (`apps/agent/src/jobProgress.ts` `PartCause`). */
const CAUSES = Object.freeze(["done", "waiting", "stuck", "check_limit", "timeout", "crash", "model_down", "steps_out", "unfinished", "changed", "stopped", "refused"]);

/** Causes that would end the next part the same way: running it again only burns a part, so the last draft goes. */
const DETERMINISTIC = Object.freeze(["check_limit"]);

/** Causes where the part broke before it answered. */
const BROKEN = Object.freeze(["check_limit", "timeout", "crash"]);

/** Causes that leave work to do, so a next part picks it up while there is room. */
const CARRY = Object.freeze(["check_limit", "timeout", "crash", "steps_out", "unfinished", "changed"]);

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
 * (the part before it was idle too), `rejected` (turned down before it ran, as opposed to refused for now).
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
  if (CARRY.includes(cause) && room && !spinning) return { to: "carry", cause, room };
  return { to: "end", ended: endedAs(cause, input?.rejected === true), cause, room, ...(spinning ? { spinning: true } : {}) };
}

/** How a job that ends here ended, by why its last part did. */
function endedAs(cause, rejected) {
  if (cause === "refused") return rejected ? "failed" : "waiting";
  if (cause === "waiting") return "waiting";
  if (cause === "done" || cause === "changed") return "done";
  if (cause === "stuck" || cause === "unfinished" || cause === "steps_out") return "stuck";
  return "failed"; // stopped, a crash or a timeout with nothing saved, a model that stayed down
}

module.exports = { CAUSES, DEFAULT_LIMITS, DETERMINISTIC, configLimits, decidePartEnd, limitsOf, roomLeft };
