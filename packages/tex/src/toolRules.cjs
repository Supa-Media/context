/**
 * Tex's four tool rules (Dev2, 2026-11-20), as code the gateway's CI check, the Lab's Tools tab and its tex_dev action
 * all read, so the three never disagree about what passes:
 *
 *   1. Don't add or remove tools between turns: a tool that can't be used right now returns a clear error.
 *   2. Each tool's description plus schema stays under 4,000 characters. send, the tool of tools, gets 8,000 (Dev2,
 *      2026-11-20: its actions' argument shapes have to be seen, or emails go out with `to` as one string).
 *   3. State is saved through a dedicated tool, not a shell command or a generic write, so reviewers see what changes.
 *   4. Errors say what to do next ("The computer is asleep. Use Shell or Read to wake it, then try again.").
 *
 * Audit: Context @supa projects/tex/tool-rules-audit.md. Plain CommonJS with no imports, so the gateway, the Convex
 * report and the Lab read the same rules.
 */

/** Rule 2's limit: a tool's description plus its JSON schema, in characters. */
const TOOL_CHAR_LIMIT = 4000;

/** Tools with a budget of their own (Dev2, 2026-11-20): send carries every outside action, each with its args shown.
 *  8,500 since 2026-11-26: main sat at 7,996 of 8,000, so send_sticker could not join without dropping another action. */
const TOOL_CHAR_LIMITS = { send: 8500 };

/** Rule 2's limit for one tool by name. */
function limitOf(name) {
  return Object.hasOwn(TOOL_CHAR_LIMITS, name) ? TOOL_CHAR_LIMITS[name] : TOOL_CHAR_LIMIT;
}

/** Rule 2's measure: the characters a model reads for one tool definition (description plus schema as JSON). */
function toolChars(tool) {
  if (!tool || typeof tool !== "object") return 0;
  const description = typeof tool.description === "string" ? tool.description : "";
  const schema = tool.input_schema ?? tool.inputSchema ?? {};
  return description.length + JSON.stringify(schema).length;
}

/*
  Rule 4's reading of an error. A heuristic, said as one so nobody mistakes it for a judge: an error is "actionable" when
  it tells the model a step to take (a verb from NEXT_STEP, not negated as "can't pass"), "partial" when it only lists
  what is allowed ("Yours: move, website", "permitted here: ...") or says to come back later without a step, and "not"
  when it only says what went wrong ("not found").
*/
const NEXT_STEP = [
  "use", "call", "pass", "try", "retry", "ask", "read", "re-read", "reread", "fetch", "search", "answer", "tell", "text",
  "send", "write", "open", "add", "check", "wait", "split", "name", "put", "give", "pick", "choose", "connect", "reconnect",
  "sign in", "run", "move", "leave", "say", "file", "include", "stop", "keep", "offer", "drop", "reply", "set", "start",
  "save", "list", "look", "go", "make", "remove", "archive", "edit", "change", "fill", "attach", "share", "invite",
];
// A step is a verb where a clause starts (the start, after ". ", "; ", ": ", ", then", "and", "or", "to", "please"), so
// "Ask about this one" and "try again" count, and "send has no action" or "a check-in looks" (a tool's name as the subject) do not.
const CLAUSE = String.raw`(?:^|[.;:!?]\s+|,\s*(?:then\s+)?|\b(?:and|or|to|then|please|instead)\s+)`;
const VERBS = NEXT_STEP.map((word) => word.replace(/-/g, "\\-")).join("|");
const SUBJECT = String.raw`(?!\s+(?:has|have|takes|is|was|needs|can|lists|only|says)\b)`;
const NEXT_STEP_RE = new RegExp(String.raw`${CLAUSE}(?:${VERBS})(?![\w-])${SUBJECT}`, "i");
const OPTIONS_ONLY = /(Yours:|permitted here:|takes args:|\bmust be\b|\bneeds\b)/i;

/** "actionable" | "partial" | "not": whether an error string says what to do next (rule 4). */
function rateError(text) {
  const said = String(text ?? "").replace(/\$\{[^}]*\}/g, "X").trim();
  if (NEXT_STEP_RE.test(said)) return "actionable";
  return OPTIONS_ONLY.test(said) ? "partial" : "not";
}

/**
 * Rule 3: the files Tex keeps its own state in, each with the dedicated action that should change it. `write` means a
 * plain note write is the way, by design: voice and routines are notes the person reads and edits. `action: null`
 * would be a file with no dedicated action yet, and the CI check counts it. A plain note write to a file whose action
 * is another one (`setting`, `remember`) is logged as a bypass and shown in the Lab's Tools tab.
 */
const TEX_STATE_FILES = Object.freeze([
  { file: "tex/heartbeat.md", what: "check-in settings (pause, quiet hours)", action: "setting" },
  { file: "tex/attention.md", what: "how much other agents may ping them", action: "setting" },
  { file: "tex/voice.md", what: "how they talk", action: "write" },
  { file: "tex/routines/", what: "routines and reminders", action: "write" },
  { file: "tex/about.md", what: "what Tex knows about them", action: "remember" },
]);

/** The state file a note path is, or null: `tex/routines/daily/x.md` is `tex/routines/`. */
function stateFileOf(path) {
  const clean = String(path ?? "").replace(/^\/+/, "");
  return TEX_STATE_FILES.find((entry) => (entry.file.endsWith("/") ? clean.startsWith(entry.file) : clean === entry.file)) ?? null;
}

/** Names that would hand a model a shell: none may be a Tex tool or a `send` action (rule 3). */
const SHELL_NAMES = Object.freeze(["shell", "bash", "exec", "run_command", "terminal", "sh"]);

module.exports = { TOOL_CHAR_LIMIT, TOOL_CHAR_LIMITS, limitOf, toolChars, rateError, TEX_STATE_FILES, stateFileOf, SHELL_NAMES };
