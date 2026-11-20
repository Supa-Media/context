/**
 * ONE TEST TEXT'S STEPS, KEPT AS THEY RUN (Dev2, 2026-11-16: the Lab's live sandbox; contract
 * `lab-live-sandbox/contract.md`; decision `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * Every step the text causes is one entry here, from the line it arrives on to the line that delivers each of Tex's
 * texts: the simulated line (`lineIn`, `lineOut`, kind `line`, transport, never a node of the config), the chat
 * object's own steps (`text`, `oldLine`, `triage`, `decide`, `lanes`, `send`, ...), every node the config graph runs
 * (the runner's `onStart` and `log`, `packages/tex/src/texGraph.cjs`), and each background job's passes.
 *
 * Each step has an `id` (unique in the sandbox: `<row id>.<n>`), `at` (ms from the text's arrival, the line's hold
 * included) and the `parent` that started it, recorded at run time and never inferred from times:
 *
 *  - a graph run's parent is the run the runner names (the caller of a `uses`, `loop` or `job` handle, or the node whose
 *    fired wire fed it); a graph's first run's parent is the step the graph was started from (`anchor`): the chat
 *    object's last step before it asked `/agent`, or the job pass a job's own turn runs in;
 *  - a chat object step's parent is the step before it on the text's way in (`lineIn` → `text` → `oldLine` → ...);
 *  - a `lineOut`'s parent is the step that handed the text to the line: the last `send` node since the anchor was set,
 *    else the anchor itself.
 *
 * A Tex text's `cause` (`causeOf`) is the chain of parents from its `lineOut` back to `lineIn`, with the helpers each
 * step on it called (`uses` and `loop` runs, and theirs). Tool calls (`calls`) are put on the model step running when
 * the call was logged; tokens on the model step running (or, once it ended, the last one) when the usage was told.
 */

/** A step's `in` and `out` are kept as their JSON up to this size, else as text cut to it (a row is one SQLite row). */
export const STEP_JSON_CHARS = 16_000;
/** The most steps one text keeps; more are counted, not kept. */
export const MAX_STEPS = 400;
/** The steps that are the simulated line, not Tex: never a node of `texConfig.json` (`scripts/tex-diagram-check.mjs`). */
export const TRANSPORT_STEPS = Object.freeze(["lineIn", "lineOut"]);
export const LINE_KIND = "line";

/** A value as a step keeps it: the value itself when its JSON is small enough, else its JSON (or text) cut. */
export function keptValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value).slice(0, STEP_JSON_CHARS);
  }
  if (typeof text !== "string") return null;
  if (text.length <= STEP_JSON_CHARS) return value;
  return `${text.slice(0, STEP_JSON_CHARS)}…`;
}

/** A node's model and effort as the config the turn ran on names them; none for code. */
function modelOf(config, node) {
  const found = Array.isArray(config?.nodes) ? config.nodes.find((n) => n.id === node) : null;
  if (!found || typeof found.model !== "string" || found.model === "code" || found.model === "") return {};
  return { model: found.model, ...(typeof found.effort === "string" && found.effort !== "" ? { effort: found.effort } : {}) };
}

/**
 * The book of one test text's steps. `rowId` names them, `arrivedAt` is when the person sent the text (the line's hold
 * counts from there), `config` the graph the turn runs (the draft over main's), `onChange` is told after every change.
 */
export function stepBook({ rowId, arrivedAt, config = null, now = Date.now, onChange = () => {} }) {
  /** @type {Array<Record<string, any>>} */
  const list = [];
  const byId = new Map();
  /** The runner's run ids (`r<n>`) to step ids. */
  const runs = new Map();
  let n = 0;
  let dropped = 0;
  /** The last step on the text's way in (the line, then the chat object's steps). */
  let tail = null;
  /** The step a graph's first run is caused by, while a job runs: its pass. */
  let anchor = null;
  let anchorAt = 0;
  const changed = () => {
    try {
      onChange();
    } catch {
      /* the Lab's view never stops a step */
    }
  };

  function begin({ node, kind = null, parent = null, at = now(), input, bg = false, helper = false }) {
    if (list.length >= MAX_STEPS) {
      dropped += 1;
      return null;
    }
    n += 1;
    const id = `${rowId}.${n}`;
    const step = {
      id,
      node,
      at: Math.max(0, Math.round(at - arrivedAt)),
      ...(input !== undefined ? { in: keptValue(input) } : {}),
      out: null,
      ok: true,
      ...(typeof parent === "string" ? { parent } : {}),
      ...(bg ? { bg: true } : {}),
      ...(kind ? { kind } : {}),
      ...(kind === LINE_KIND ? {} : modelOf(config, node)),
    };
    Object.defineProperties(step, { _start: { value: at, writable: true }, _open: { value: true, writable: true }, _helper: { value: helper } });
    list.push(step);
    byId.set(id, step);
    changed();
    return id;
  }

  function end(id, { out, ms, ok = true, think } = {}) {
    const step = byId.get(id);
    if (!step) return;
    step.out = keptValue(out ?? null);
    step.ms = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : Math.max(0, Math.round(now() - step._start));
    step.ok = ok !== false;
    if (typeof think === "string" && think !== "") step.think = think.slice(0, STEP_JSON_CHARS);
    step._open = false;
    changed();
  }

  /** The innermost model step still running, else the last one that ran. */
  function modelStep() {
    for (let at = list.length - 1; at >= 0; at -= 1) if (list[at]._open && list[at].model) return list[at];
    for (let at = list.length - 1; at >= 0; at -= 1) if (list[at].model) return list[at];
    return null;
  }

  /** The step that hands a text to the line now: the last `send` node since the anchor was set, else the anchor. */
  function deliverer() {
    for (let at = list.length - 1; at >= 0; at -= 1) {
      const step = list[at];
      if (step._start < anchorAt) continue;
      if (step.node === "send" && step.kind !== LINE_KIND && !step._open) return step.id;
    }
    return anchor ?? null;
  }

  const parentOfRun = (run) => (typeof run?.parent === "string" && runs.has(run.parent) ? runs.get(run.parent) : (anchor ?? tail));
  // A background wire's run, a job handle's, and a background job's own pass (run as `texJob.js` runs it, via "TexJob").
  const isBg = (via) => via === "background" || via === "TexJob" || (typeof via === "string" && via.endsWith(":job"));
  const isHelper = (via) => typeof via === "string" && (via.endsWith(":uses") || via.endsWith(":loop"));

  return {
    begin,
    end,
    /** The step a graph run (`r<n>`) is, or null. */
    stepOf: (runId) => runs.get(runId) ?? null,
    /** A graph run starting (the runner's `onStart`). */
    runStarted(run) {
      if (typeof run?.node !== "string" || typeof run.id !== "string" || runs.has(run.id)) return;
      const id = begin({ node: run.node, parent: parentOfRun(run), at: Number.isFinite(run.at) ? run.at : now(), input: run.input, bg: isBg(run.via), helper: isHelper(run.via) });
      if (id !== null) runs.set(run.id, id);
    },
    /** A graph run ended (the runner's `log`); one whose start was not seen is begun here. */
    runEnded(run) {
      if (typeof run?.node !== "string") return;
      if (typeof run.id !== "string" || !runs.has(run.id)) {
        const id = begin({ node: run.node, parent: parentOfRun(run), at: Number.isFinite(run.at) ? run.at : now() - (run.ms ?? 0), input: run.input, bg: isBg(run.via), helper: isHelper(run.via) });
        if (id === null) return;
        if (typeof run.id === "string") runs.set(run.id, id);
        end(id, { out: run.output ?? (run.error ? { error: run.error } : null), ms: run.ms, ok: run.ok });
        return;
      }
      end(runs.get(run.id), { out: run.output ?? (run.error ? { error: run.error } : null), ms: run.ms, ok: run.ok });
    },
    /** One of the chat object's own steps, logged as it finished: on the text's way in, or a send. */
    worker(step, at = now()) {
      const ms = Number.isFinite(step?.ms) ? step.ms : 0;
      const sending = step.node === "send";
      const parent = sending ? (deliverer() ?? tail) : (anchor ?? tail);
      const id = begin({ node: step.node, parent, at: at - ms, input: step.in, bg: false });
      if (id === null) return null;
      end(id, { out: step.out, ms, ok: step.ok });
      if (!sending && anchor === null) tail = id;
      return id;
    },
    /** The line's own step, `lineIn` (a root, from the text's arrival) or `lineOut` (under what handed the text over). */
    line(node, input, parent = null, at = now()) {
      const id = begin({ node, kind: LINE_KIND, parent, at, input });
      if (node === "lineIn" && id !== null) tail = id;
      return id;
    },
    /** While a job runs, the graphs it starts hang under its pass. */
    setAnchor(id) {
      anchor = id;
      anchorAt = now();
    },
    get anchor() {
      return anchor;
    },
    /** The last step on the text's way in. */
    get tail() {
      return tail;
    },
    deliverer,
    /** The last step of `node` (a finished one), or null. */
    last(node) {
      for (let at = list.length - 1; at >= 0; at -= 1) if (list[at].node === node && !list[at]._open) return list[at].id;
      return null;
    },
    /** A tool call, on the model step that made it. */
    call({ tool, kind, ms, d, think }) {
      const step = modelStep();
      if (!step || typeof tool !== "string") return;
      step.calls = [...(step.calls ?? []), { tool, kind: kind === "write" ? "write" : "read", ms: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0, d: String(d ?? "").slice(0, 200) }].slice(-100);
      if (typeof think === "string" && think !== "") step.think = `${step.think ? `${step.think}\n\n` : ""}${think}`.slice(0, STEP_JSON_CHARS);
      changed();
    },
    /** A model's usage, on the model step it was spent in. */
    usage({ model, tokIn, tokOut, cost }) {
      const step = modelStep();
      if (!step) return;
      if (Number.isFinite(tokIn)) step.tokIn = (step.tokIn ?? 0) + tokIn;
      if (Number.isFinite(tokOut)) step.tokOut = (step.tokOut ?? 0) + tokOut;
      if (Number.isFinite(cost)) step.cost = (step.cost ?? 0) + cost;
      if (typeof model === "string" && model !== "" && !step.model) step.model = model.slice(0, 80);
      changed();
    },
    /** A step's id chain from the root to it, and every helper a step on it called: a Tex text's `cause`, in run order. */
    causeOf(id) {
      const chain = new Set();
      for (let at = id; typeof at === "string" && byId.has(at) && !chain.has(at); at = byId.get(at).parent) chain.add(at);
      const kept = new Set(chain);
      for (let grew = true; grew; ) {
        grew = false;
        for (const step of list) if (!kept.has(step.id) && step._helper && kept.has(step.parent)) (kept.add(step.id), (grew = true));
      }
      return list.filter((step) => kept.has(step.id)).map((step) => step.id);
    },
    /** The steps as the Lab reads them, in start order; a running one has no `ms` yet. */
    view() {
      return list.map((step) => ({ ...step }));
    },
    /** The steps with these ids. */
    pick(ids) {
      const want = new Set(ids);
      return list.filter((step) => want.has(step.id)).map((step) => ({ ...step }));
    },
    get dropped() {
      return dropped;
    },
  };
}

/** The most a row's steps take, as JSON: a Durable Object row holds 2 MB, and the row has its words besides. */
export const STEPS_BUDGET = 1_200_000;

/** Steps that fit `budget`: each step's `in`, `out` and `think` cut shorter and shorter until they do. Ids never drop. */
export function fitSteps(steps, budget = STEPS_BUDGET) {
  if (JSON.stringify(steps).length <= budget) return steps;
  let fitted = steps;
  for (const most of [4_000, 1_000, 200, 0]) {
    const cut = (value) => {
      if (value === undefined || value === null) return value;
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (text.length <= most) return value;
      return most === 0 ? "…" : `${text.slice(0, most)}…`;
    };
    fitted = steps.map((step) => ({ ...step, ...("in" in step ? { in: cut(step.in) } : {}), out: cut(step.out), ...(step.think ? { think: cut(step.think) } : {}) }));
    if (JSON.stringify(fitted).length <= budget) return fitted;
  }
  return fitted;
}
