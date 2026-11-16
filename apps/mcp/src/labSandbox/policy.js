/**
 * WHAT A LAB TEST CHAT'S TURN MAY REACH (Dev2, 2026-11-16; decision `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * Three lists, each deny by default, each a fence on its own:
 *
 *  - `controlPlaneAnswer`: the control plane's routes a test turn may call for real (`CONTROL_PLANE_READS`, reads that
 *    change nothing), the few bookkeeping writes it is answered for as done without asking (`ANSWERED`), and a refusal
 *    for every other route. Wired into the one `post` every control-plane method uses (`controlPlane/client.js`).
 *  - `toolAnswer`: the tools a test turn may run for real (`READ_TOOLS`, reads only), and for every other tool a stub
 *    answer that says it was done in the test chat, kept in its `writes`. Wired where Tex's model calls a tool
 *    (`agent/turn.js`) and where every MCP tool call passes (`tools/session.js`).
 *  - `sandboxEnvOf`: the Worker's bindings a test turn is given. No texting Worker, no browser, no jobs, no live rooms,
 *    no secrets of other Workers; the objects only through `wire.js`, analytics as writers that keep nothing.
 */

/** The env key a test turn's env carries its gate under; never set on a real request's env. */
export const LAB_SANDBOX_KEY = "LAB_SANDBOX_GATE";

/** The gate a request's env carries, or null on every real request. */
export function sandboxGateOf(env) {
  const gate = env?.[LAB_SANDBOX_KEY];
  return gate && typeof gate === "object" && typeof gate.record === "function" ? gate : null;
}

/**
 * Routes that only read (`apps/convex/functions/lib/gatewayRoutes/*`). `/gateway/binding` hands back the workspace's
 * storage binding, as every real turn's store open does; asked with a key rotation in the body, it is refused below.
 * The person's own mail, calendar and Google Chat reads spend their hourly read allowance, as a real turn's do.
 */
export const CONTROL_PLANE_READS = Object.freeze(
  new Set([
    "/gateway/access/profiles", "/gateway/agent/identity", "/gateway/connect/apps", "/gateway/links/list", "/gateway/machines/chat/people",
    "/gateway/machines/for-chat", "/gateway/machines/owned", "/gateway/mail-health", "/gateway/mail/get", "/gateway/mail/jobs",
    "/gateway/note-ids/lookup", "/gateway/note-ids/resolve", "/gateway/objects/behind", "/gateway/tex-store/open", "/gateway/tex/chat-home",
    "/gateway/tex/page", "/gateway/time-zone", "/gateway/transcription/consent", "/gateway/tree/manifest", "/gateway/workspaces/connect-google",
    "/gateway/binding", "/gateway/email/search", "/gateway/email/read", "/gateway/calendar/days", "/gateway/chat/recent", "/gateway/chat/spaces",
  ]),
);

/** Names under which a storage binding carries a secret: blanked, so the bucket refuses whatever is asked of it. */
const SECRET_FIELDS = new Set(["secretAccessKey", "sessionToken", "secretKey", "apiToken", "password"]);

/** A control-plane answer with every secret field replaced (`/gateway/binding`). */
export function withoutKeys(value) {
  if (Array.isArray(value)) return value.map(withoutKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_FIELDS.has(key) && typeof inner === "string" ? "lab-sandbox-no-key" : withoutKeys(inner)]));
}

/** A route that reads or writes by its body: read only for these. */
function readByBody(path, body) {
  if (path === "/gateway/privacy") return body?.op === "resolveHandles";
  if (path === "/gateway/tree/facts") return body?.ask !== "forwarding" && body?.ask !== "chaos";
  if (path === "/gateway/tex-review") return body?.mode === "tier";
  if (path === "/gateway/tex/dev") return ["page", "list", "get"].includes(body?.action);
  if (path === "/gateway/vault/text") return body?.op === "list";
  return false;
}

/**
 * Bookkeeping a turn makes as it goes, answered as done without reaching the control plane: the model's verdict (a
 * test turn is never counted against the person's daily cap; the sandbox keeps its own, `route.js`), its usage, its
 * turn log, its signals. What they would have counted is a test chat's, so nothing is kept.
 */
const ANSWERED = Object.freeze({
  "/gateway/builtin-model": () => ({ verdict: { allowed: true, remaining: 100 } }),
  "/gateway/builtin-model/usage": () => ({ ok: true }),
  "/gateway/agent-turn": () => ({ ok: true }),
  "/gateway/tool-failures": () => ({ ok: true }),
  "/gateway/usage": () => ({ ok: true }),
  "/gateway/activity": () => ({ ok: true }),
  "/gateway/tree": () => ({ ok: true }),
  "/gateway/tree/touch": () => ({ ok: true }),
  "/gateway/routines": () => ({ ok: true }),
  "/gateway/search-timing": () => ({ ok: true }),
  "/gateway/search-open": () => ({ ok: true }),
  "/gateway/search-index/progress": () => ({ ok: true }),
  "/gateway/grants/tools-listed": () => ({ ok: true }),
  "/gateway/texts/opened": () => ({ ok: true }),
  "/gateway/mail/read": () => ({ ok: true }),
  "/gateway/mail-health/raised": () => ({ ok: true }),
});

/** What each refused route would have done, for the test chat's list of changes. */
function kindOfRoute(path) {
  if (/email/.test(path)) return "Email";
  if (/calendar/.test(path)) return "Calendar";
  if (/chat\/send|attention|forms\/notify/.test(path)) return "Chat";
  if (/jobs|machines|browser|mover/.test(path)) return "Job";
  if (/privacy|links|vault|workspaces\/invite|site|website/.test(path)) return "Sharing";
  if (/tex\/command|tex\/page\/settings|dreams/.test(path)) return "Setting";
  if (/moves|note-ids|rows|access\/mirror|page-cover|layout/.test(path)) return "Note";
  return "Other";
}

/**
 * The answer a test turn's control-plane call gets: `{ pass: true }` to send it on, `{ answer }` to answer it here, or
 * `{ refuse: status }`. Every refusal and every answered write is said to `gate.record`.
 */
export function controlPlaneAnswer(path, body, gate) {
  const route = typeof path === "string" ? path : "";
  if (route === "/gateway/binding" && (body?.startEncryptionRotation || body?.completeEncryptionRotation)) {
    gate.record({ kind: "Other", summary: "a key rotation, refused in the test chat" });
    return { refuse: 403 };
  }
  // The storage binding comes back with its keys blanked: a test turn reads notes from the workspace's object, and a
  // bucket it reached with these keys would refuse every request, a write above all.
  if (route === "/gateway/binding") return { pass: true, transform: withoutKeys };
  if (CONTROL_PLANE_READS.has(route) || readByBody(route, body)) return { pass: true };
  const answered = ANSWERED[route];
  if (answered) return { answer: answered(body) };
  gate.record({ kind: kindOfRoute(route), summary: `${route.replace("/gateway/", "")} (not sent: test chat)` });
  return { refuse: 403 };
}

/**
 * Tools a test turn runs for real: they only read the person's notes, mail, calendar, texts and the web, or ask a
 * model. `vault_list` (it can fetch with a secret) and `report_problem` (it sends a report) are not here although
 * their schemas call them read-only.
 */
export const READ_TOOLS = Object.freeze(
  new Set([
    "orient", "scope_info", "list_notes", "read_note", "read_notes", "evaluate_lists", "search_notes", "related_notes", "read_file", "read_image",
    "list_meetings", "read_meeting", "read_calendar", "list_channel_days", "read_channel_day", "list_contacts", "read_contact", "read_activity",
    "list_changes", "search_email", "read_email", "search_texts", "list_texts", "read_texts", "read_google_chat", "app_read", "list_links", "list_plugins",
    "read_back", "read_thread", "earlier_texts", "earlier_chat", "tex_settings_get", "chat_status", "job_status", "ask_advisor", "open_page",
    "search_web", "travel_time", "draw_visual", "draw_picture", "make_picture", "read_skill", "read_learned_skill", "say_nothing", "search", "fetch",
  ]),
);

/** What a stubbed tool would have done, for the test chat's list. */
const TOOL_KINDS = [
  [/email|forward_rule/, "Email"],
  [/calendar/, "Calendar"],
  [/remember|write_note|save_context|archive|move|fill_dates|apply_layout|dream_now|suggest_destination|encryption|storage_layout|write$/, "Note"],
  [/google_chat|notify|text_progress|slack|ask_personal_tex|chat_add_everyone|mail_agent/, "Chat"],
  [/background|delegate|plan_big_ask|steer|restart|computers|machine/, "Job"],
  [/browse|fill_login|fill_card|sign_out_browser/, "Browser"],
  [/visibility|link|vault|share|invite|create_workspace|site|review_sharing/, "Sharing"],
  [/setting|instructions|mute|chat_/, "Setting"],
  [/form|vote|submission|answer/, "Form"],
];

function toolKind(name, args) {
  const path = typeof args?.path === "string" ? args.path : "";
  if (/^tex\/(routines|heartbeat)/.test(path)) return "Reminder";
  for (const [pattern, kind] of TOOL_KINDS) if (pattern.test(name)) return kind;
  return "Other";
}

/** A line saying what a tool call was for: its target, never its whole text. */
function toolSummary(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const target = [a.path, a.to, a.subject, a.title, a.summary, a.query, a.url, a.name].find((value) => typeof value === "string" && value.trim() !== "");
  return `${name}${target ? `: ${target.trim().slice(0, 140)}` : ""}`;
}

/**
 * A test turn's answer for one tool: null to run it for real (a read), or the stub result it gets instead, said to
 * `gate.record`. The stub reads as done, so the turn carries on as it would have.
 */
export function toolAnswer(name, args, gate) {
  if (typeof name !== "string" || READ_TOOLS.has(name)) return null;
  gate.record({ kind: toolKind(name, args), summary: toolSummary(name, args), tool: name });
  return { content: [{ type: "text", text: "Done. (A Lab test chat: this was recorded, and nothing was changed or sent.)" }] };
}

/** `toolAnswer` for a turn's env: null on every real turn, whose env carries no gate (`agent/turn.js`). */
export function sandboxedTool(env, call) {
  const gate = sandboxGateOf(env);
  return gate === null ? null : toolAnswer(call?.name, call?.args, gate);
}

/** Bindings a test turn is given as they are: the model, pictures, the deploy's version. */
const PASSED_BINDINGS = new Set(["AI", "IMAGES", "CF_VERSION_METADATA"]);
/** Analytics datasets: given as writers that keep nothing, so a test turn never counts in production's numbers. */
const ANALYTICS = new Set(["TEX_TIMING", "TEX_CALLS", "TEX_ENTRY", "MCP_ENTRY", "CALL_COUNTS", "TEX_TEXTS", "TEX_COUNTS"]);
/** Secrets for other Workers, never needed to answer a text. */
const WITHHELD_STRINGS = new Set(["TRANSCRIBE_WORKER_SECRET", "AGENT_WORKER_SECRET", "TRANSCRIBE_WORKER_URL"]);

/**
 * A test turn's env: the real one's plain settings, the model's bindings, the objects through `wire.js`, analytics that
 * keep nothing, and `gate` under `LAB_SANDBOX_KEY`. Every other binding (the texting Worker, site shots, Tex's jobs and
 * chat queues, live rooms, tickets, the eval service) is left out, so no code path can reach one.
 */
export function sandboxEnvOf(env, { gate, workspaces, tex }) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      if (!WITHHELD_STRINGS.has(key)) out[key] = value;
    } else if (PASSED_BINDINGS.has(key)) out[key] = value;
    else if (ANALYTICS.has(key)) out[key] = { writeDataPoint() {} };
  }
  if (workspaces) out.WORKSPACE_STORE = workspaces;
  if (tex) out.TEX_STORE = tex;
  out[LAB_SANDBOX_KEY] = gate;
  return out;
}
