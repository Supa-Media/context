/**
 * Job start: whether a background job Tex asks for starts now (Dev2, 2026-11-17, "jobs as config", step 7).
 *
 * The front door starts a job with `start_background_job`. Whether it may (a title and a brief, not the same job as
 * one already running, a free slot where it would run) and the limits behind it (three cloud jobs a chat, at most
 * eight on one computer) were code inside the gateway's job tool (`packages/tex/gateway/agent/background.js`). Here the choice
 * is one pure function, the Job start node's code (`packages/tex/gateway/agent/graph/nodes/jobStart.js`), and the limits are
 * that node's config (`limits`), so the Lab shows, tests and changes both.
 *
 * "already" is the steering choice: the ask is a job already running, so its words go to that job, not a second one.
 *
 * Plain CommonJS with no imports, so the gateway and the texting Worker read the same rules.
 */

/** The limits when the config names none: today's numbers, so wiring this changes nothing. */
const DEFAULT_LIMITS = Object.freeze({ cloudSlots: 3, machineSlots: 8 });

const whole = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);

/** The limits a node's config gives, each falling back to today's number. */
function limitsOf(config) {
  const given = config && typeof config === "object" ? config : {};
  return { cloudSlots: whole(given.cloudSlots, DEFAULT_LIMITS.cloudSlots), machineSlots: whole(given.machineSlots, DEFAULT_LIMITS.machineSlots) };
}

/** The Job start node's limits in a whole config (`texConfig.json`), today's numbers while it names none. */
function configStartLimits(config) {
  const node = Array.isArray(config?.nodes) ? config.nodes.find((n) => n && n.id === "jobStart") : null;
  return limitsOf(node?.limits);
}

/** A computer's own slots: its owner's count, one when it names none, never over the limit. */
function slotsOn(computer, limits) {
  const slots = computer?.slots;
  return Number.isSafeInteger(slots) && slots > 0 ? Math.min(slots, limits.machineSlots) : 1;
}

/**
 * What follows an ask to start a job. `input`: `hasTitle`, `hasBrief`, `already` (the running job it is the same as,
 * `{ title, startedAt?, status? }`, or null), `computer` (`{ id, slots }` where it would run, or null for the cloud),
 * `cloudBusy` and `machineBusy` (jobs already running there, this turn's starts included).
 * Answers `{ to: "start" | "already" | "full" | "refuse", ... }`.
 */
function decideStart(input, config) {
  const limits = limitsOf(config);
  if (input?.hasTitle !== true || input?.hasBrief !== true) return { to: "refuse", why: "a job needs a title and a brief" };
  const already = input.already && typeof input.already === "object" && typeof input.already.title === "string" ? input.already : null;
  if (already !== null) return { to: "already", title: already.title, ...(Number.isFinite(already.startedAt) ? { startedAt: already.startedAt } : {}), ...(typeof already.status === "string" && already.status ? { status: already.status } : {}) };
  const computer = input.computer && typeof input.computer === "object" && typeof input.computer.id === "string" ? input.computer : null;
  const busy = Number.isInteger(computer ? input.machineBusy : input.cloudBusy) ? (computer ? input.machineBusy : input.cloudBusy) : 0;
  const room = computer ? slotsOn(computer, limits) : limits.cloudSlots;
  if (busy >= room) return { to: "full", where: computer ? "computer" : "cloud", slots: room };
  return { to: "start", where: computer ? "computer" : "cloud", slots: room };
}

module.exports = { DEFAULT_LIMITS, configStartLimits, decideStart, limitsOf, slotsOn };
