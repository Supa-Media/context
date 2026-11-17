/**
 * WHAT A LAB TEST CHAT'S TURN MAY REACH (Dev2, 2026-11-16; decision `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * Three lists, each deny by default, each a fence on its own:
 *
 *  - `controlPlaneAnswer`: the control plane's routes a test turn may call for real (`CONTROL_PLANE_READS`, reads that
 *    change nothing), the few bookkeeping writes it is answered for as done without asking (`ANSWERED`), and a refusal
 *    for every other route. Wired into the one `post` every control-plane method uses (`controlPlane/client.js`).
 *  - `toolAnswer`: the tools a test turn may run for real (`READ_TOOLS`, reads only, a note the test chat wrote read
 *    from there), the job tools (`RUN_IN_SANDBOX`: a job they start runs in the test chat, `jobs.js`), the write tools
 *    the test chat does itself (`sandboxTools.js`: notes, pages, email kept there), a refusal for a browser or a
 *    computer (`NO_MACHINE`), and for every other tool a stub answer that says it was done, kept in its `writes`. Wired
 *    where Tex's model calls a tool (`agent/turn.js`) and where every MCP tool call passes (`tools/session.js`).
 *  - `sandboxEnvOf`: the Worker's bindings a test turn is given. No texting Worker, no browser, no Worker-run jobs, no
 *    live rooms, no secrets of other Workers; the objects only through `wire.js`, analytics as writers that keep nothing.
 */

import { overlayRead, sandboxWrite } from "./sandboxTools.js";
import { etagRefusalByName } from "../tools/etagPlace.js";

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
 * A chat shared with the developers (`gate.noNotes`) does not: its session is the sharer's and the token is the
 * caller's (`texLabSandbox.ts`), so those reads, and the other personal-account reads on the same path, are answered
 * empty here (`emptyPersonalRead`) and never sent.
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

/**
 * Personal-account reads a shared test chat answers empty (`emptyPersonalRead`). The developer's own test chat is not
 * in this set: `gate.noNotes` is set only for a chat shared with the developers (`chatRun.js`).
 */
export const NO_NOTES_PERSONAL_READS = Object.freeze(
  new Set([
    "/gateway/email/search", "/gateway/email/read", "/gateway/calendar/days", "/gateway/chat/recent", "/gateway/chat/spaces",
    "/gateway/mail/get", "/gateway/mail/jobs", "/gateway/mail-health", "/gateway/connect/apps", "/gateway/workspaces/connect-google",
    "/gateway/links/list", "/gateway/access/profiles", "/gateway/machines/owned", "/gateway/machines/for-chat",
    "/gateway/transcription/consent",
  ]),
);

const CHAT_SPACE = /^spaces\/[A-Za-z0-9_-]{1,64}$/;
const CHAT_ADDRESS = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

/**
 * An empty answer for one personal-account read, in the shape that route's caller already treats as nothing found.
 * No address, subject, or message from either person is in it. `/gateway/agent/identity` with `groups` is not here:
 * that list is the chats shared with the developers, answered above. A vault change is not here either.
 */
export function emptyPersonalRead(route, body) {
  if (route === "/gateway/email/search") return { ok: true, results: [], mailboxes: [] };
  if (route === "/gateway/email/read") return { ok: false, refused: "not_found" };
  if (route === "/gateway/calendar/days") return { ok: true, days: [] };
  if (route === "/gateway/chat/spaces") return { ok: true, from: "", accounts: [], spaces: [] };
  if (route === "/gateway/chat/recent") {
    const space = typeof body?.space === "string" && CHAT_SPACE.test(body.space) ? body.space : null;
    const to = typeof body?.to === "string" && CHAT_ADDRESS.test(body.to) ? body.to : null;
    if (space !== null) return { ok: true, from: "", place: { space }, messages: [] };
    if (to !== null) return { ok: true, from: "", place: { person: to }, messages: [] };
    return { ok: true, messages: [] };
  }
  if (route === "/gateway/mail/get") return { mailbox: null };
  if (route === "/gateway/mail/jobs" || route === "/gateway/mail-health") return { mailboxes: [] };
  if (route === "/gateway/connect/apps") return { apps: [] };
  if (route === "/gateway/workspaces/connect-google") return { google: null };
  if (route === "/gateway/links/list") return { links: [] };
  if (route === "/gateway/access/profiles") return { profiles: [] };
  if (route === "/gateway/machines/owned" || route === "/gateway/machines/for-chat") return { machines: [] };
  if (route === "/gateway/transcription/consent") return { allowed: false };
  if (route === "/gateway/agent/identity") return { identity: null };
  if (route === "/gateway/vault/text") return { status: "done", entries: [] };
  return null;
}

/** A personal-account read, for a shared test chat only. Group lists and vault changes are not. */
function personalReadWhenNoNotes(route, body) {
  if (route === "/gateway/agent/identity") return body?.groups !== true;
  if (route === "/gateway/vault/text") return body?.op === "list";
  return NO_NOTES_PERSONAL_READS.has(route);
}

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
  "/gateway/builtin-model/usage": () => ({ ok: true }), // its tokens put on the step that spent them (`controlPlaneAnswer`)
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
  // A shared chat's notes are not the developer's to open: its store is an empty one of the test chat's own.
  if (route === "/gateway/binding" && gate.noNotes === true) {
    return { answer: { binding: { provider: "r2-binding", bindingName: NO_NOTES_BINDING, status: "active", workspaceId: String(body?.expectedWorkspaceId ?? "") } } };
  }
  // The storage binding comes back with its keys blanked: a test turn reads notes from the workspace's object, and a
  // bucket it reached with these keys would refuse every request, a write above all.
  if (route === "/gateway/binding") return { pass: true, transform: withoutKeys };
  // The person's group chats, for a 1:1 that reads them (`agent/groupChats.js`): the list the Lab read for this chat,
  // since a test turn's token is the Lab's own and the control plane would know nobody by it.
  if (route === "/gateway/agent/identity" && body?.groups === true) return { answer: { groups: Array.isArray(gate.groups) ? gate.groups : null } };
  // Shared with the developers: the sharer's mail, calendar, chat and the other personal-account reads stay empty.
  // A route classed as personal with no empty shape is refused, never sent.
  if (gate.noNotes === true && personalReadWhenNoNotes(route, body)) {
    const answer = emptyPersonalRead(route, body);
    if (answer !== null) return { answer };
    gate.record({ kind: kindOfRoute(route), summary: `${route.replace("/gateway/", "")} (not sent: test chat)` });
    return { refuse: 403 };
  }
  if (CONTROL_PLANE_READS.has(route) || readByBody(route, body)) return { pass: true };
  const answered = ANSWERED[route];
  if (answered) {
    if (route === "/gateway/builtin-model/usage" && typeof gate.usage === "function") {
      try {
        gate.usage({ model: body?.model, tokIn: (body?.inputTokens ?? 0) + (body?.cacheReadTokens ?? 0) + (body?.cacheWriteTokens ?? 0), tokOut: body?.outputTokens });
      } catch {
        /* the Lab's view never stops a turn */
      }
    }
    return { answer: answered(body) };
  }
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
    "read_back", "read_thread", "read_day", "group_chats", "earlier_texts", "earlier_chat", "tex_settings_get", "chat_status", "job_status", "ask_advisor", "open_page",
    "search_web", "travel_time", "draw_visual", "draw_picture", "make_picture", "read_skill", "read_learned_skill", "say_nothing", "search", "fetch",
  ]),
);

/**
 * Tools that run for real in a test chat because what they do lands in it: a background job they start, steer or
 * restart runs in the test chat's own job objects (`jobs.js`), on the same fences; a progress line is texted on the
 * test chat's line; an ask of Tex in another chat goes through the Cross-chat gate and runs in a linked test chat of
 * that chat (`crossRuns.js`), and a do-ask's post lands in that test chat; a tapback as the whole answer ends the turn and
 * reacts in the test chat (`tapbackEnding.js`; answered as a write it never ended the turn, and Tex texted "Heart sent.").
 * Their note writes and calls pass the fences like any other.
 */
export const RUN_IN_SANDBOX = Object.freeze(new Set(["start_background_job", "steer_background_job", "restart_background_job", "plan_big_ask", "text_progress", "ask_chat", "post_in_chat", "tapback"]));

/**
 * Tools that need a browser or one of the person's computers, which a test chat never has: refused, said in words the
 * turn reads as a refusal, and listed. A job that would run on a computer is refused the same way (`jobs.js`).
 */
const NO_MACHINE = /^(browse|fill_login|fill_card|sign_out_browser|delegate)$|computer|machine/;
export const MACHINE_REFUSAL = "Not run: a Lab test chat has no browser and no computer, so this step can't run here. Say so plainly, and carry on with what you can do without it.";

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

/** A tool call's line, for a step's `calls` (`steps.js`). */
export { toolSummary };

/**
 * A test turn's answer for one tool, a Promise of: null to run it for real (a read, or a job tool), or the result it
 * gets instead. A read of a note the test chat wrote answers from there; a write the test chat does itself
 * (`sandboxTools.js`) is done there; a browser or computer is refused; anything else gets a stub that reads as done, so
 * the turn carries on as it would have. Every write and refusal is said to the gate, and kept in the test chat's
 * `writes`.
 */
export async function toolAnswer(name, args, gate) {
  if (typeof name !== "string") return null;
  if (READ_TOOLS.has(name)) return typeof gate.call === "function" ? await overlayRead(name, args, gate) : null;
  if (RUN_IN_SANDBOX.has(name)) return null;
  // An etag from another workspace is refused here as the gateway refuses it (`tools/etagPlace.js`), so a test chat
  // never shows a save the real one would not make. Only once a routed call said which workspace a plain path means.
  const own = typeof gate.ownWorkspace === "string" && gate.ownWorkspace !== "" ? gate.ownWorkspace : null;
  const wrongPlace = own !== null ? etagRefusalByName(name, args, own) : null;
  if (wrongPlace) {
    gate.record({ kind: "Refused", summary: `${toolSummary(name, args)} (an etag from another workspace)`, tool: name });
    return { content: [{ type: "text", text: wrongPlace }], isError: true };
  }
  const done = typeof gate.call === "function" ? await sandboxWrite(name, args, gate) : null;
  if (done !== null) return done;
  if (NO_MACHINE.test(name)) {
    gate.record({ kind: "Refused", summary: `${toolSummary(name, args)} (no browser or computer in a test chat)`, tool: name });
    return { content: [{ type: "text", text: MACHINE_REFUSAL }], isError: true };
  }
  gate.record({ kind: toolKind(name, args), summary: toolSummary(name, args), tool: name });
  // Said to the model as a real call's success, never "a test chat": told that, Tex texted "I couldn't confirm it's on
  // your calendar ... this chat is a lab test" (2026-11-17), which no real turn says. The run card lists it as a write.
  return { content: [{ type: "text", text: "Done." }] };
}

/** `toolAnswer` for a turn's env: null on every real turn, whose env carries no gate (`agent/turn.js`). */
export async function sandboxedTool(env, call) {
  const gate = sandboxGateOf(env);
  return gate === null ? null : await toolAnswer(call?.name, call?.args, gate);
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
/**
 * The bucket a chat shared with the developers gets in place of its person's notes (Dev2 chose "run without the
 * sharer's notes", 2026-11-17): a workspace's key is handed only to its members, so a developer's test text in someone
 * else's chat reads none of their notes. It holds nothing and keeps nothing: every read is empty and a save is refused,
 * which the turn reads as any failed save (its writes are the test chat's own anyway, `sandboxTools.js`).
 */
export const NO_NOTES_BINDING = "LAB_NO_NOTES";
export function noNotesBucket() {
  const refuse = async () => {
    throw new Error("This test chat was shared with the developers without its person's notes: nothing is saved here.");
  };
  return {
    get: async () => null,
    head: async () => null,
    list: async () => ({ objects: [], delimitedPrefixes: [], truncated: false }),
    put: refuse,
    delete: async () => undefined,
  };
}

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
  if (gate?.noNotes === true) {
    out[NO_NOTES_BINDING] = noNotesBucket();
    out.NATIVE_BINDINGS = [String(out.NATIVE_BINDINGS ?? ""), NO_NOTES_BINDING].filter((entry) => entry.trim() !== "").join(",");
  }
  return out;
}
