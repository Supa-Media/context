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
 * blobs: kind, outcome, the bucket calls by stage (`callsLine`). doubles, in order: waitMs, then one per `STAGES`
 * entry, then modelMs, toolMs, otherTurnMs (the turn's own time outside the
 * model and tools), afterMs, totalMs, rounds, retriedRounds, slowestRoundMs,
 * then allowedMs (the control plane's yes, asked beside the turn) and
 * allowedHeldMs (how long a model's reply waited on it: `turnAllowed.js`).
 */
export const COLUMNS = ["waitMs", ...STAGES.map((stage) => `${stage}Ms`), "modelMs", "toolMs", "otherTurnMs", "afterMs", "totalMs", "rounds", "retriedRounds", "slowestRoundMs", "allowedMs", "allowedHeldMs"];

/**
 * @param {{ TEX_TIMING?: { writeDataPoint(point: object): void } }} env
 * @param {() => number} [now]
 */
export function turnStages(env, now = Date.now) {
  const start = now();
  const marks = {};
  let report = null, allowed = null;
  let flushed = false;
  let rounds = null;
  const calls = {};
  return {
    /**
     * Count the bucket calls this turn makes, by where in the turn (b before the
     * model, t in it, a after the answer) and by the key's first folders, ids
     * blanked: which reads fill a stage, never a name or a word.
     */
    watch(store) {
      for (const op of ["get", "head", "put", "delete", "list"]) {
        const inner = store?.[op];
        if (typeof inner !== "function") continue;
        store[op] = function (key, ...rest) {
          const where = report !== null ? "a" : marks.ready !== undefined ? "t" : "b";
          const name = `${where}:${op}:${keyShape(op === "list" ? key?.prefix : key)}`;
          calls[name] = (calls[name] ?? 0) + 1;
          return inner.call(this, key, ...rest);
        };
      }
    },
    /** A step before the model is done (`STAGES`); the first mark of a name counts. */
    mark(stage) {
      if (marks[stage] === undefined) marks[stage] = now();
    },
    /** The control plane's answer, asked beside the turn (`turnAllowed.js`): read when the point is written. */
    allowedBy(gate) {
      allowed = gate;
    },
    /** The turn is about to call the model. */
    ready() {
      this.mark("ready");
    },
    /** The turn's row (`turnReport`): its kind, outcome, model and tool times; `trace`, its rounds as they ran, tokens included (`turn.js`). */
    ran(row, trace) {
      report = row;
      rounds = Array.isArray(trace) ? trace : null;
    },
    /** The response is ready: write the point, once. */
    flush() {
      if (flushed) return null;
      flushed = true;
      const point = stagesOf({ start, marks, end: now(), report, allowed });
      point.blobs.push(callsLine(calls));
      // The same numbers in the Worker's log, for a live tail (`wrangler tail`).
      if (env?.TEX_TIMING_LOG !== "off") console.log(JSON.stringify({ event: "turn_stages", kind: point.blobs[0], outcome: point.blobs[1], ...Object.fromEntries(COLUMNS.map((name, i) => [name, Math.round(point.doubles[i])])) }));
      const perCall = callPoints(point.blobs[0], rounds ?? report?.trace ?? []);
      for (const call of perCall) if (env?.TEX_TIMING_LOG !== "off") console.log(JSON.stringify({ event: "model_call", kind: call.blobs[0], model: call.blobs[1], ...Object.fromEntries(CALL_COLUMNS.map((name, i) => [name, call.doubles[i]])) }));
      write(env?.TEX_CALLS, perCall);
      return write(env?.TEX_TIMING, [point]) ? point : null;
    },
  };
}

/** Writes each point, best effort: diagnostics never fail a turn. False without the binding. */
function write(dataset, points) {
  if (!dataset || typeof dataset.writeDataPoint !== "function") return false;
  for (const point of points) {
    try {
      dataset.writeDataPoint(point);
    } catch {
      return true;
    }
  }
  return true;
}

/**
 * ONE POINT PER MODEL CALL (`TEX_CALLS`, dataset `tex_model_calls`), so a slow
 * call can be told apart from a slow turn (Dev2, 2026-10-31: Haiku calls took
 * 7 to 11 s against about 2.5 s expected). blobs: the turn's kind, the model,
 * "ok" or "failed". doubles, in order (`CALL_COLUMNS`): the round's number in
 * the turn, its milliseconds, the uncached input tokens, the cache reads, the
 * cache writes, the output tokens, the characters of words it wrote, and how
 * many tools it called. Output tokens past what the words and calls explain
 * are its thinking. Counts only, never a word; at most `MAX_CALL_POINTS`.
 */
export const CALL_COLUMNS = ["round", "ms", "input", "cacheRead", "cacheWrite", "output", "said", "calls"];
export const MAX_CALL_POINTS = 24;

export function callPoints(kind, trace) {
  const points = [];
  let round = 0;
  for (const entry of trace) {
    if (entry?.kind !== "model") continue;
    round += 1;
    if (points.length >= MAX_CALL_POINTS) break;
    const usage = entry.usage ?? {};
    const n = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
    const model = typeof entry.model === "string" ? entry.model.replace(/^[^/]*\//, "").slice(0, 64) : "unknown";
    points.push({
      blobs: [String(kind), model, entry.ok === false ? "failed" : "ok"],
      doubles: [round, n(entry.ms), n(usage.input), n(usage.cacheRead), n(usage.cacheWrite), n(usage.output), n(entry.said), n(entry.calls)],
      indexes: [String(kind)],
    });
  }
  return points;
}

export function stagesOf({ start, marks, end, report, allowed = null }) {
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
      allowed?.ms ?? 0,
      allowed?.heldMs ?? 0,
    ],
    indexes: [String(report?.kind ?? "unknown")],
  };
}

/** A key's first two folders, any part that looks like an id or a name blanked. */
export function keyShape(key) {
  if (typeof key !== "string") return "?";
  return key.split("/").slice(0, 3).map((part) => (/^[.a-z-]{1,24}$/.test(part) ? part : "*")).join("/");
}

/** The busiest call shapes, most first, in at most a thousand characters (blob3). */
export function callsLine(calls) {
  let line = "";
  for (const [name, count] of Object.entries(calls).sort((a, b) => b[1] - a[1])) {
    const part = `${name}=${count}`;
    if (line.length + part.length + 1 > 1000) break;
    line += (line ? " " : "") + part;
  }
  return line;
}
