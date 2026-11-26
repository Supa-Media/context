/**
 * NEW RUN STEPS (Dev2, 2026-11-26: "yeah thats a bug, this would need some type of special configurable node?"; "this
 * is a special node ... details should exist in the side panel"). A finished background job used to report back to
 * the chat along a wire nothing read: the Worker always queued the report as the chat's next turn, whatever the config
 * drew. A step of kind `run` is where that is decided now. It is fire-and-forget, as every generator is (a job is not
 * part of the run that fired it): what it is handed starts a NEW run of the chat, at the input step its one wire out
 * goes to, or nowhere when it has none (the report is logged and dropped).
 *
 * Each run step is code, so its code says which input steps it can start, and the config can only pick among them
 * (`configProblems` refuses a wire to any other). The Lab's side panel shows the choice as "Starts a new run at".
 *
 * Rules:
 *   - Only code reads a run step's target, through `runTarget(config, id)`.
 *   - A config without the step (it is on the shelf) runs as before it existed: `runTarget` answers `fallback`.
 *   - A run step that is off, or wired to an input step that is off, starts nothing.
 */

/** Every run step: the input steps its code can start (its wire's possible `to`), and the start a config without it keeps. */
const RUN_STEPS = Object.freeze({
  // A background job's report (`packages/tex/worker/jobTexts.ts` `jobUpdate`): queued as the chat's next turn, read by
  // input step `jobReport` (`texEntryPoint/readTheText.js` `jobReportEvent`).
  reportRun: Object.freeze({ starts: Object.freeze(["jobReport"]), fallback: "jobReport", what: "a job's report" }),
});

/** The input step run step `id` starts in `config`: its wire's `to` when it and that step are on, else null. */
function runTarget(config, id) {
  const decl = RUN_STEPS[id];
  if (!decl) return null;
  const nodes = Array.isArray(config?.nodes) ? config.nodes : [];
  const step = nodes.find((n) => n?.id === id);
  if (!step) return decl.fallback;
  if (step.on === false) return null;
  const wire = (Array.isArray(config.edges) ? config.edges : []).find((e) => e?.from === id && decl.starts.includes(e.to));
  if (!wire) return null;
  return nodes.some((n) => n?.id === wire.to && n.on !== false) ? wire.to : null;
}

/** What is wrong with the config's run steps, as sentences; [] when sound. */
function runStepProblems(config) {
  const out = [];
  const nodes = Array.isArray(config?.nodes) ? config.nodes : [];
  const edges = Array.isArray(config?.edges) ? config.edges : [];
  for (const n of nodes) {
    if (n?.kind !== "run") continue;
    const decl = RUN_STEPS[n.id];
    if (!decl) {
      out.push(`${n.id}: unknown run step`);
      continue;
    }
    const outs = edges.filter((e) => e?.from === n.id);
    for (const e of outs) {
      if (!decl.starts.includes(e.to)) out.push(`${n.id} cannot start ${e.to}`);
      else if (e.mode !== "generator") out.push(`${n.id}→${e.to} needs generator`);
    }
    if (outs.length > 1) out.push(`${n.id} has several wires`);
  }
  for (const id of Object.keys(RUN_STEPS)) {
    const n = nodes.find((m) => m?.id === id);
    if (n && n.kind !== "run") out.push(`${id} needs kind run`);
  }
  return out;
}

module.exports = { RUN_STEPS, runTarget, runStepProblems };
