/**
 * A TURN CARRIES ON WHERE ITS LAST TRY STOPPED (Dev2, 2026-11-17: "yeah lets take that idea immediately", LangGraph's
 * save-after-every-step, built on our own pieces; plan and code reviewed by Fable the same day).
 *
 * A texted turn that dies after its tools ran (a crash in its checks, the gateway out of memory, a dropped stream) is
 * tried again by the texting Worker, and until now that try started from the person's text: the same mail search, the
 * same note written again, minutes later. Now, after each tool call returns, the turn keeps what it has done so far
 * (the model's own calls and what each returned, after the question) in the chat's own home beside its ledger
 * (`texStore/rounds.js`), and the next try of the same text goes on from there (`turn.js` `resumeFrom`, `turnResume.js`).
 *
 * WHAT IS NEVER CARRIED ON. A snapshot is the transcript, not the turn's other state, so it only ever holds calls whose
 * whole effect is the words they returned: reads the MCP answered, and a progress line (the Worker sends each once per
 * text). The first call with an effect beyond that (a note write, anything held for the person's yes, a job started, a
 * picture made or read, a web or browser step, a call that settles the turn) freezes the snapshot before it, so a try after a
 * crash runs that call again, exactly as every try did before this. What the carried reads told the turn's checks
 * (figures, note links, facts its reply keeps) is told them again before the model runs (`runTheModel.js`). Never worse than
 * starting over; the outside-read mark (`privacy/egress.js`) travels with it, so a resumed turn is as untrusted as
 * the try that read the outside thing.
 *
 * Keyed by the text: a hash of the question, the chat events it answers and, in a group, the chat lines it was shown,
 * so a newer text merged in, or a group that moved on, starts over. Pictures stay out (one line says so), long results
 * are cut, and a snapshot too large is not kept.
 */
import { PROGRESS_TOOL } from "./progress.js";

/** One tool result's words, kept whole up to this: the model read it all, but a try after reads enough of it. */
export const ROUNDS_RESULT_CHARS = 12_000;
/** The largest snapshot kept, as JSON (`texStore/rounds.js` refuses more). */
export const ROUNDS_MAX_CHARS = 1_400_000;
/** What the model reads where a tool showed it a picture the snapshot did not keep. */
export const PICTURE_LEFT_OUT = "[A picture this call returned was shown to you in an earlier try and is not shown again.]";

const encoder = new TextEncoder();
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The text a turn answers, as the key its snapshot is kept under; null when nothing names the text (no events). */
export async function textKey({ question, covers, groupChat = null }) {
  const events = Array.isArray(covers) ? covers.filter((id) => typeof id === "string" && id !== "") : [];
  if (events.length === 0) return null;
  const named = JSON.stringify(["v1", String(question ?? ""), [...events].sort(), groupChat ?? null]);
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(named)));
}

/**
 * A background job's part, as the key its snapshot is kept under: the job, which restart of it (`resumeJob` starts
 * its parts at 1 again), and the part. Each part keeps its own, so a part still running past its time never writes
 * over the next one's.
 */
export async function jobKey({ id, resumes = 0, part }) {
  if (typeof id !== "string" || id === "" || !Number.isSafeInteger(part) || part < 1) return null;
  const named = JSON.stringify(["job-v1", id, Number.isSafeInteger(resumes) && resumes >= 0 ? resumes : 0, part]);
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(named)));
}

/** One message as the snapshot keeps it: pictures out, a long result cut. */
export function keptMessage(message) {
  if (message?.role === "tool") {
    const text = String(message.text ?? "");
    const pictures = Array.isArray(message.images) && message.images.length > 0;
    const cut = text.length > ROUNDS_RESULT_CHARS ? `${text.slice(0, ROUNDS_RESULT_CHARS)}\n[cut: the rest was read in an earlier try]` : text;
    return { role: "tool", id: message.id, name: message.name, text: pictures ? `${cut}\n${PICTURE_LEFT_OUT}` : cut, ...(message.isError ? { isError: true } : {}) };
  }
  if (message?.role === "assistant") {
    return {
      role: "assistant",
      text: String(message.text ?? ""),
      ...(Array.isArray(message.toolCalls) && message.toolCalls.length > 0 ? { toolCalls: message.toolCalls.map(({ id, name, args }) => ({ id, name, args })) } : {}),
      ...(Array.isArray(message.content) ? { content: message.content } : {}),
    };
  }
  return { role: "user", text: String(message?.text ?? "") };
}

/**
 * Tools marked read-only whose effect is still more than their words: a picture or visual made goes out with the
 * reply (`pictureMaker.js`, `visuals/index.js`), so a try after a crash makes it again. The turn's web and local tools
 * never carry on either: `turn.js` leaves them out of `readOnly`.
 */
export const NEVER_CARRIED = new Set(["draw_picture", "make_picture", "draw_visual", "open_page", "search_web", "browse"]);

/**
 * Whether a try after a crash may read a call's result instead of running it: a read the turn was offered as one and
 * the MCP answered, a progress line, or (with `acts`, the offered MCP actions) an action the MCP answered; never one
 * held for the person's yes, never a picture, and never a web, browser or local step.
 * `readOnly` is the set of offered MCP tool names marked read-only.
 */
export function carriesOn(call, result, readOnly, acts = null) {
  if (result?.held === true) return false;
  // A picture it returned was numbered for this try alone (`outgoingPictures.js`): a try after could not text it.
  if (Array.isArray(result?.content) && result.content.some((part) => part?.type === "image")) return false;
  if (call.name === PROGRESS_TOOL) return true;
  if (NEVER_CARRIED.has(call.name)) return false;
  // An action the MCP answered (a note saved, a share made): it happened, so a try after reads that it did rather than
  // doing it again; its log entry was kept before it ran (`turnResume.js` `starting`). Its checks are told it as a write.
  return readOnly.has(call.name) || acts?.has(call.name) === true;
}

/**
 * What a try after a crash reads for an action an earlier try started and never heard back from: it may have taken
 * effect, so it is checked, never made again blind (Dev2, 2026-11-20, durable jobs option A). An error to the
 * turn's checks, so a reply never claims it was done on its word.
 */
export const STARTED_UNSURE =
  "[An earlier try started this call and stopped before it returned, so it may or may not have taken effect. Check first (read the note back, or look at what it would have changed), and make it again only if it did not happen.]";

const ROLES = new Set(["user", "assistant", "tool"]);

/** A snapshot as the store gave it back, checked: `{ round, messages, untrusted, outside }`, or null. */
export function checkedSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== "object" || snapshot.v !== 1) return null;
  if (!Number.isSafeInteger(snapshot.round) || snapshot.round < 1 || !Array.isArray(snapshot.messages) || snapshot.messages.length === 0) return null;
  if (!snapshot.messages.every((message) => message !== null && typeof message === "object" && ROLES.has(message.role))) return null;
  // Every call answered: a model given a call with no result is refused by its provider.
  const answered = new Set(snapshot.messages.filter((message) => message.role === "tool").map((message) => message.id));
  if (!snapshot.messages.every((message) => message.role !== "assistant" || !Array.isArray(message.toolCalls) || message.toolCalls.every((call) => answered.has(call.id)))) return null;
  // Each call once: a provider that numbers calls per round (`builtin.js`) would pair one round's name with another's result.
  const ids = snapshot.messages.flatMap((message) => (message.role === "assistant" && Array.isArray(message.toolCalls) ? message.toolCalls.map((call) => call.id) : []));
  if (new Set(ids).size !== ids.length) return null;
  const ran = snapshot.ran !== null && typeof snapshot.ran === "object" && !Array.isArray(snapshot.ran) ? snapshot.ran : {};
  return { round: snapshot.round, messages: snapshot.messages, ran, untrusted: snapshot.untrusted === true, outside: snapshot.outside === true };
}

/**
 * The calls a snapshot holds, each with whether it went, for the turn's own record of what it did (`sendBack.js`):
 * by the tool that ran (`ran`, as the six resolved it: `read_note`, never `fetch`), else as the model named it.
 */
export function callsIn(messages, ran = {}) {
  const results = new Map(messages.filter((message) => message.role === "tool").map((message) => [message.id, message]));
  const resolved = ran !== null && typeof ran === "object" ? ran : {};
  return messages
    .filter((message) => message.role === "assistant" && Array.isArray(message.toolCalls))
    .flatMap((message) =>
      message.toolCalls.map((call) => {
        const as = Object.hasOwn(resolved, call.id) && typeof resolved[call.id]?.name === "string" ? resolved[call.id] : call;
        return { id: call.id, name: as.name, args: as.args, ok: results.get(call.id)?.isError !== true, text: String(results.get(call.id)?.text ?? "") };
      }),
    );
}
