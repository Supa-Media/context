/**
 * A CODE STEP'S OWN SETTINGS (Dev2, 2026-11-23: "code nodes should be able to define their own parameters, like number
 * parameters or Boolean parameters ... display that in the UI, and agents are able to tweak those parameters").
 *
 * A rule inside a step's code used to be a constant: a word limit, a trim that runs or doesn't. The Lab could not show it
 * and an agent could not change it, so a behaviour that changed what Tex said lived outside the config (the shadow-code
 * audit, @supa projects/tex-quality/shadow-code-audit-2026-11-23.md). Now the code that reads a setting declares it here,
 * by step id: its kind (a number with bounds, on or off, or one of a few choices), its default, and the words the Lab
 * shows. The value lives on the step in `texConfig.json` (`settings`), so the Lab draws it, `tex_dev edit` changes it,
 * `check` refuses a value outside its declaration, and Promote ships it like any other field.
 *
 * Rules:
 *   - Only code reads a setting, through `stepSettings(config, id)`, which fills in each default: a config that leaves a
 *     setting out runs on its default, so declaring one never changes behaviour by itself.
 *   - A setting on a Tex step that nothing declares is a knob that does nothing, and `configProblems` refuses it.
 *   - A search step's numbers are search's own (`apps/mcp/src/search/config/searchConfig.cjs`) and are not declared here.
 *
 * Decision: docs/decisions/texting-assistant/step-settings.md.
 */

const TYPES = Object.freeze(["number", "boolean", "choice"]);

/**
 * Every Tex step's declared settings, `{ [stepId]: { [name]: declaration } }`. A declaration is
 *   { type: "number", default, min, max, integer?, unit?, label, tip }
 *   { type: "boolean", default, label, tip }
 *   { type: "choice", default, options: [{ value, label }], label, tip }
 * `label` is the Lab's row name and `tip` the line under it, both in plain words.
 */
const on = (label, tip) => Object.freeze({ type: "boolean", default: true, label, tip });
const STEP_SETTINGS = Object.freeze({
  // Finish the text (`texEntryPoint/finishTheText.js`): what the gateway does to the model's words after every check.
  finish: Object.freeze({
    trimFlattery: on("Trim flattery", "Take an opening \"Absolutely,\" \"Great idea.\" or \"Sorry,\" off the reply before it goes (pushback.js)."),
    linkSavedNote: on("Link the saved note", "Add the link to a note this turn saved when the reply doesn't link it (noteLinks.js)."),
    dropStaleAnswer: on("Drop a stale answer", "When their text set aside a held step and the reply asks nothing, send only the ask line, not the model's words."),
  }),
  // Claim checks (`claimCheck.js` and the checks it runs): the code rules that send a draft back.
  claimChecks: Object.freeze({
    onTexts: Object.freeze({
      type: "boolean",
      default: false,
      label: "On every text",
      tip: "Run the full claim checks on a front-door text too. Off: a text gets only the stands, untried-web and do-it checks; jobs and reports get them all.",
    }),
    proseWords: Object.freeze({
      type: "number",
      default: 70,
      min: 20,
      max: 400,
      integer: true,
      unit: "words",
      label: "Prose limit",
      tip: "A reply with more words of sentences than this goes back to be shorter (wordy.js).",
    }),
    besideResultWords: Object.freeze({
      type: "number",
      default: 30,
      min: 5,
      max: 200,
      integer: true,
      unit: "words",
      label: "Beside a page",
      tip: "The most words next to a page or picture Tex made (wordy.js).",
    }),
  }),
  // The Nudge (`graph/nodes/nudgeOffer.js`, `nudges.js`): when one offer line may go after a finished 1:1 answer.
  nudgeOffer: Object.freeze({
    addLine: on("Add the line", "Add the offer line after the answer. Off: a shadow run that decides, keeps and counts the offer the same way but texts nothing."),
    minTexts: Object.freeze({
      type: "number",
      default: 5,
      min: 0,
      max: 100,
      integer: true,
      unit: "texts",
      label: "First texts left alone",
      tip: "No offer until the person has sent this many texts that reached the step: first just be fast and right.",
    }),
    cooldownHours: Object.freeze({
      type: "number",
      default: 24,
      min: 1,
      max: 720,
      integer: true,
      unit: "hours",
      label: "Between offers",
      tip: "The least time between two offers to the same person.",
    }),
  }),
  // Tool rules (`texEntryPoint/runTheModel.js`): what every tool call passes through. The security rules (vault, mail
  // agent, the chat's write lock, their notes kept) are always on and are not settings.
  toolRules: Object.freeze({
    sameAsk: on("Same ask twice", "Withdraw a held ask that repeats one already waiting, and tell the model to change it (sameAsk.js)."),
    folderFit: on("Where a new note goes", "Move a new note to the folder that fits it (folderFit.js)."),
    noteLinks: on("Links in results", "Add each note's link to what a tool answers (noteLinks.js)."),
  }),
});

/** Why `value` cannot be setting `name` of step `id`, in words; null when it can. */
function stepSettingProblem(id, name, value) {
  const decl = STEP_SETTINGS[id]?.[name];
  if (!decl) return `step "${id}" has a setting nothing reads: ${name} (declare it in texNodeSettings.cjs, where its code reads it)`;
  if (decl.type === "boolean") return typeof value === "boolean" ? null : `step "${id}" setting ${name} must be true or false`;
  if (decl.type === "choice") {
    const values = decl.options.map((o) => o.value);
    return values.includes(value) ? null : `step "${id}" setting ${name} must be one of ${values.join(", ")}`;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return `step "${id}" setting ${name} must be a number`;
  if (decl.integer && !Number.isInteger(value)) return `step "${id}" setting ${name} must be a whole number`;
  if (value < decl.min || value > decl.max) return `step "${id}" setting ${name} must be from ${decl.min} to ${decl.max}`;
  return null;
}

/** Everything wrong with one step's `settings`, as sentences; [] when it is sound. */
function stepSettingsProblems(id, settings) {
  if (settings === undefined) return [];
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return [`step "${id}" settings must be an object`];
  return Object.entries(settings)
    .map(([name, value]) => stepSettingProblem(id, name, value))
    .filter((p) => p !== null);
}

/**
 * A step's settings in `config` (`{ nodes }`), each declared one filled in with its default when the step leaves it out
 * or the value is not one its declaration allows. `{}` for a step that declares none.
 */
function stepSettings(config, id) {
  const declared = STEP_SETTINGS[id];
  if (!declared) return {};
  const node = Array.isArray(config?.nodes) ? config.nodes.find((n) => n && n.id === id) : null;
  const own = node && node.settings && typeof node.settings === "object" ? node.settings : {};
  const out = {};
  for (const [name, decl] of Object.entries(declared)) {
    out[name] = name in own && stepSettingProblem(id, name, own[name]) === null ? own[name] : decl.default;
  }
  return out;
}

/** Whether `STEP_SETTINGS` is itself sound: each declaration's kind, default and bounds. [] when it is. */
function declarationProblems(table = STEP_SETTINGS) {
  const out = [];
  for (const [id, settings] of Object.entries(table)) {
    for (const [name, decl] of Object.entries(settings)) {
      const at = `${id}.${name}`;
      if (!TYPES.includes(decl.type)) out.push(`${at} has kind ${decl.type}, not one of ${TYPES.join(", ")}`);
      if (typeof decl.label !== "string" || decl.label === "") out.push(`${at} has no label`);
      if (typeof decl.tip !== "string" || decl.tip === "") out.push(`${at} has no tip`);
      if (decl.type === "number" && !(decl.min <= decl.max)) out.push(`${at} has bounds that are not min <= max`);
      if (decl.type === "choice" && !(Array.isArray(decl.options) && decl.options.length > 1)) out.push(`${at} needs at least two options`);
      if (TYPES.includes(decl.type) && stepSettingProblem(id, name, decl.default) !== null) out.push(`${at} has a default its own declaration refuses`);
    }
  }
  return out;
}

module.exports = { TYPES, STEP_SETTINGS, stepSettingProblem, stepSettingsProblems, stepSettings, declarationProblems };
