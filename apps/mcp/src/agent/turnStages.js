/**
 * WHERE A TURN'S TIME WENT, WHERE CLAUDE CAN READ IT (Dev2, 2026-10-31: "hi
 * Tex" took over three minutes one to one, and Haiku answered in two seconds
 * of it).
 *
 * A one-to-one chat's history lives in the person's own workspace, which the
 * people debugging Tex can't read, and Workers logs need the dashboard. So
 * each `/agent` turn writes one point to Workers Analytics Engine
 * (`TEX_TIMING`, read with the account's SQL API): the turn's kind and
 * outcome, and how its milliseconds split between the wait before the
 * gateway, each step before the first model round (`STAGES`, marked in
 * `route.js`), the model, the tools, the rest of the turn, and the work after
 * the answer until the response. Numbers, a kind and an outcome only: never a
 * workspace, a person, a model's words or theirs. Without the binding
 * (self-hosting, tests) nothing is written.
 */

/** The marks `route.js` sets before the model, in order; each one's double is the time since the one before. */
export const STAGES = ["provider", "tools", "history", "web", "setup", "skills", "pictures", "ready"];

/**
 * blobs: kind, outcome. doubles, in order: waitMs, then one per `STAGES`
 * entry, then modelMs, toolMs, otherTurnMs (the turn's own time outside the
 * model and tools), afterMs, totalMs, rounds, retriedRounds, slowestRoundMs.
 */
export const COLUMNS = ["waitMs", ...STAGES.map((stage) => `${stage}Ms`), "modelMs", "toolMs", "otherTurnMs", "afterMs", "totalMs", "rounds", "retriedRounds", "slowestRoundMs"];

/**
 * @param {{ TEX_TIMING?: { writeDataPoint(point: object): void } }} env
 * @param {() => number} [now]
 */
export function turnStages(env, now = Date.now) {
  const start = now();
  const marks = {};
  let report = null;
  let flushed = false;
  return {
    /** A step before the model is done (`STAGES`); the first mark of a name counts. */
    mark(stage) {
      if (marks[stage] === undefined) marks[stage] = now();
    },
    /** The turn is about to call the model. */
    ready() {
      this.mark("ready");
    },
    /** The turn's row (`turnReport`): its kind, outcome, model and tool times. */
    ran(row) {
      report = row;
    },
    /** The response is ready: write the point, once. */
    flush() {
      if (flushed) return null;
      flushed = true;
      const point = stagesOf({ start, marks, end: now(), report });
      // The same numbers in the Worker's log, for a live tail (`wrangler tail`).
      if (env?.TEX_TIMING_LOG !== "off") console.log(JSON.stringify({ event: "turn_stages", kind: point.blobs[0], outcome: point.blobs[1], ...Object.fromEntries(COLUMNS.map((name, i) => [name, Math.round(point.doubles[i])])) }));
      const dataset = env?.TEX_TIMING;
      if (!dataset || typeof dataset.writeDataPoint !== "function") return null;
      try {
        dataset.writeDataPoint(point);
      } catch {
        // Diagnostics never fail a turn.
      }
      return point;
    },
  };
}

export function stagesOf({ start, marks, end, report }) {
  const answered = report && typeof report.ms === "number" ? start + report.ms : end;
  const gaps = [];
  let from = start;
  for (const stage of STAGES) {
    const at = marks[stage];
    if (at === undefined) {
      gaps.push(0);
      continue;
    }
    gaps.push(Math.max(0, at - from));
    from = at;
  }
  const modelMs = report?.modelMs ?? 0;
  const toolMs = report?.toolMs ?? 0;
  const turnMs = marks.ready === undefined ? 0 : Math.max(0, answered - marks.ready);
  const rounds = (report?.trace ?? []).filter((entry) => entry.kind !== "tool" && entry.kind !== "router" && entry.kind !== "fallback");
  const waitMs = report?.waitMs ?? 0;
  return {
    blobs: [String(report?.kind ?? "unknown"), String(report?.outcome ?? "unfinished")],
    doubles: [
      waitMs,
      ...gaps,
      modelMs,
      toolMs,
      Math.max(0, turnMs - modelMs - toolMs),
      Math.max(0, end - answered),
      Math.max(0, end - start) + waitMs,
      report?.rounds ?? 0,
      rounds.filter((entry) => entry.retried).length,
      rounds.reduce((most, entry) => Math.max(most, entry.ms ?? 0), 0),
    ],
    indexes: [String(report?.kind ?? "unknown")],
  };
}
