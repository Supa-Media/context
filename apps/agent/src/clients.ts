/**
 * The three services this Worker talks to, each behind one small function so
 * the conversation logic can be tested against fakes.
 *
 * - **Linq** sends the reply. Its API key is the Worker's own secret.
 * - **The control plane** (Convex) answers "whose phone is this", and links a
 *   phone to an account when someone texts the code the app showed them. It is
 *   called with `AGENT_WORKER_SECRET`, which opens nothing but these two
 *   routes — the same shape as the email worker's own secret.
 * - **The gateway's `/agent` route** answers the question, with a short-lived
 *   grant the control plane minted for that one person. The gateway applies
 *   that person's own scope clamp, privacy engine and audit identity, so this
 *   Worker never decides what anybody may read.
 *
 * No response body from any of them is ever logged or echoed: an error body can
 * quote the request, and the request is somebody's message.
 */

import type { GatewayAttachment } from "./attachments";
import { readTexStyle, type TexStyle } from "./texStyle";
import type { Reaction, Tapback } from "./reactions";
import type { JobReport } from "./jobs";
import { readPictures, type OutgoingPicture } from "./outgoing";
import { readChoices, type Choice } from "./pickCard";
import { readOffers, type Offer } from "./dataCards";
import { readStartedJobs, readSteers, type JobAsk, type JobSteerAsk, type JobVerdict, type RunningJob, type StartedJob } from "./jobs";
import type { TexEvent } from "./events";
import { readLog } from "./logHold";

/** The gateway seals a warm copy only this large (`apps/mcp/src/agent/warmCopy.js` `WARM_MAX_CHARS`). */
export const MAX_WARM_CHARS = 1_500_000;

export type Fetch = typeof fetch;

const TIMEOUT_MS = 30_000;
/** A turn that calls several tools can take a while; the gateway caps it too. */
const AGENT_TIMEOUT_MS = 120_000;

export class ServiceError extends Error {
  constructor(
    readonly service: "linq" | "sendblue" | "whapi" | "control_plane" | "gateway",
    readonly status: number | null,
  ) {
    super(`${service} request failed${status === null ? "" : ` (${status})`}`);
    this.name = "ServiceError";
  }
}

export async function post(
  fetcher: Fetch,
  service: ServiceError["service"],
  url: string,
  token: string,
  body: unknown,
  timeoutMs = TIMEOUT_MS,
): Promise<{ status: number; json: unknown }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ServiceError(service, null);
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ── Linq ──────────────────────────────────────────────────────────────────

export const LINQ_API = "https://api.linqapp.com/api/partner/v3";

/** iMessage itself has no small limit, but a wall of text is not an answer. */
export const MAX_REPLY_TEXT = 3000;

export async function sendLinqText(
  fetcher: Fetch,
  apiKey: string,
  chatId: string,
  text: string,
  idempotencyKey: string,
): Promise<void> {
  const { status } = await post(
    fetcher,
    "linq",
    `${LINQ_API}/chats/${encodeURIComponent(chatId)}/messages`,
    apiKey,
    {
      message: {
        parts: [{ type: "text", value: text.slice(0, MAX_REPLY_TEXT) }],
        idempotency_key: idempotencyKey.slice(0, 255),
      },
    },
  );
  if (status < 200 || status >= 300) throw new ServiceError("linq", status);
}

/**
 * Show the "…" bubble in the chat while an answer is being worked on. Linq
 * keeps it up for about 85 seconds, and sending a text clears it.
 *
 * Best effort and quick: a typing bubble that failed costs nothing, and one
 * that is slow must not delay the answer. Never throws.
 */
export const TYPING_TIMEOUT_MS = 3_000;

export async function startLinqTyping(fetcher: Fetch, apiKey: string, chatId: string): Promise<void> {
  try {
    await post(
      fetcher,
      "linq",
      `${LINQ_API}/chats/${encodeURIComponent(chatId)}/typing`,
      apiKey,
      {},
      TYPING_TIMEOUT_MS,
    );
  } catch {
    // See above.
  }
}

/**
 * Mark the chat read, so the person sees "Read" under their text, as they would
 * from someone who picked up their phone. Best effort and quick, like the
 * typing bubble: it never throws, and a refusal only costs the receipt.
 */
export async function markLinqRead(fetcher: Fetch, apiKey: string, chatId: string): Promise<void> {
  try {
    await post(fetcher, "linq", `${LINQ_API}/chats/${encodeURIComponent(chatId)}/read`, apiKey, {}, TYPING_TIMEOUT_MS);
  } catch {
    // See above.
  }
}

/**
 * Offer the line's contact card in this chat, so the person's Messages shows
 * "Context" and its icon in place of a bare number and a grey silhouette.
 *
 * The card itself is set once per line in Linq, not here: the name "Context"
 * and the photo at https://context.lc/texts-card.png, Tex the mascot
 * (`apps/mobile/public/texts-card.png`). This only shares it. Linq takes it only in an iMessage chat that already has an
 * outbound message, says it may not take effect in every chat, and gives no
 * confirmation the person saved it, so the inbox offers it at most once a day
 * per sender, after a reply has gone out. Best effort and quick, like the
 * typing bubble: it never throws, and a refusal (no card set up yet) costs one
 * small request. Returns whether Linq accepted it.
 */
export async function shareLinqContactCard(fetcher: Fetch, apiKey: string, chatId: string): Promise<boolean> {
  try {
    const { status } = await post(
      fetcher,
      "linq",
      `${LINQ_API}/chats/${encodeURIComponent(chatId)}/share_contact_card`,
      apiKey,
      {},
      TYPING_TIMEOUT_MS,
    );
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}

// ── Control plane ─────────────────────────────────────────────────────────

/** `timeZone` is the person's own (their reminders run in it), when the control plane sent one. */
/** `texStyle`: how their own Tex talks to them (`texStyle.ts`), only what they changed. */
export type SessionAnswer = { status: "linked"; accessToken: string; timeZone?: string; texStyle?: TexStyle } | { status: "unlinked" };

export async function openSession(
  fetcher: Fetch,
  origin: string,
  secret: string,
  phone: string,
): Promise<SessionAnswer> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/session`, secret, {
    phone,
  });
  if (status !== 200) throw new ServiceError("control_plane", status);
  const body = record(json);
  if (body.status === "linked" && typeof body.accessToken === "string" && body.accessToken) {
    const zone = typeof body.timeZone === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(body.timeZone) ? { timeZone: body.timeZone } : {};
    const texStyle = readTexStyle(body.texStyle);
    return { status: "linked", accessToken: body.accessToken, ...zone, ...(texStyle ? { texStyle } : {}) };
  }
  if (body.status === "unlinked") return { status: "unlinked" };
  throw new ServiceError("control_plane", status);
}

/** On success, the handle whose Context now answers this phone. */
export type LinkAnswer = { status: "linked"; handle: string } | { status: "refused" };

export async function linkPhone(
  fetcher: Fetch,
  origin: string,
  secret: string,
  phone: string,
  code: string,
): Promise<LinkAnswer> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/link`, secret, {
    phone,
    code,
  });
  if (status !== 200) throw new ServiceError("control_plane", status);
  const body = record(json);
  if (body.status === "linked" && typeof body.handle === "string" && /^[a-z0-9-]{1,64}$/.test(body.handle)) {
    return { status: "linked", handle: body.handle };
  }
  return { status: "refused" };
}

// ── Gateway ───────────────────────────────────────────────────────────────

export type AgentAnswer =
  /**
   * `verbatim`: parts of `text` the gateway needs texted exactly as written,
   * never reformatted (an email the person is asked to approve). Absent when none.
   */
  /** `steered`: the event ids of texts sent while it ran that the turn took in (`inbox.ts`). */
  /** `jobs`: background jobs the turn started (`jobs.ts`); `steers`: running jobs this text is handed to; `exhausted`: it ran out of steps; `unfinished`: a job's answer stopped short of the ask. */
  /** `vaultWatch`: the turn texted a link to save a login, so the inbox watches for the save (`vaultWatch.ts`). */
  /** `askFor`: in a group, the handle of the one person whose 👍 or yes the answer asks for, when that isn't the tagger (`groupInbox.ts`). */
  /** `askIds`: the approval records the turn armed, one ask event each (`events.ts`). */
  /** `warm`: the gateway's sealed copy of what this turn read, handed back with the next text (`warm.ts`). */
  | { kind: "answer"; text: string; pictures: OutgoingPicture[]; choices?: Choice[]; offers?: Offer[]; verbatim?: string[]; quiet?: true; steered?: string[]; jobs?: StartedJob[]; steers?: JobSteerAsk[]; exhausted?: true; unfinished?: true; untrusted?: true; verdict?: JobVerdict; advice?: string; vaultWatch?: true; askFor?: string; askIds?: string[]; warm?: string; log?: TexEvent[] }
  /** The turn was cancelled (`POST /agent/cancel`, a restart): nothing of it is sent. */
  | { kind: "cancelled" }
  | { kind: "no_model" }
  | { kind: "daily_limit" }
  /** The gateway could not start the turn (503: nothing ran), so asking again is safe. */
  | { kind: "not_started" }
  /** The gateway's 503 for a workspace with no bucket it can reach: a new one still starting, or a broken binding. */
  | { kind: "no_storage" }
  /** `timedOut`: a streamed turn that ran past its time, not one that failed. */
  | { kind: "unavailable"; timedOut?: true };

/**
 * Ask the gateway's `/agent` route. `conversation` names the thread the
 * gateway keeps history for, in the person's own bucket; this Worker keeps
 * none.
 *
 * With `onProgress`, the turn is asked for as a stream (`Accept:
 * application/x-ndjson`, `apps/mcp/src/agent/progress.js`): a long task texts
 * where it has got to while it works, each `{"progress"}` line is handed to
 * `onProgress` as it arrives, and the last line carries the turn's own status
 * and body. A gateway that answers plain JSON (one deployed before streaming)
 * is read exactly as before.
 */
export async function askAgent(
  fetcher: Fetch,
  gatewayOrigin: string,
  accessToken: string,
  question: string,
  onProgress?: (text: string) => Promise<void>,
  timeZone?: string,
  attachments: GatewayAttachment[] = [],
  /**
   * The words an inline reply answers, sent apart from the question: they are
   * somebody else's, and `question` is what the gateway's guards vouch from
   * (`apps/mcp/src/agent/quoted.js`). An empty string is a reply whose words
   * could not be read, sent as `replied` so the turn still knows it was one.
   */
  quoted?: string,
  /** The words that started the thread an inline reply was typed in, apart like `quoted`. */
  threadStart?: string,
  /**
   * An answered tapback's name, the tapbacks noted since the last text
   * (`reactions.ts`), and the name of this turn, which texts sent while it
   * runs are steered into (`apps/mcp/src/agent/steer.js`).
   */
  {
    tapback,
    reacted = [],
    turn,
    running,
    job,
    onStep,
    event,
    jobReport,
    covers,
    chat,
    told = [],
    texStyle,
    arrivedAt,
    warm,
    recent,
    holdsLog,
  }: {
    tapback?: Tapback;
    reacted?: Reaction[];
    turn?: string;
    /** What this chat has running in the background, which also says this Worker can run jobs (`jobs.ts`). */
    running?: RunningJob[];
    /** The background job this turn runs. */
    job?: JobAsk;
    /** Handed each step a background job's turn takes, as it takes it (`jobRun.ts`). */
    onStep?: (text: string) => Promise<void>;
    /** A turn with no text of theirs: a login Tex asked for was saved (`vaultWatch.ts`). */
    event?: "vault_saved" | "job_report";
    /** A background job's report to this chat's own turn, which decides what they get (`jobTexts.ts`). */
    jobReport?: JobReport;
    /** The chat's event ids this turn answers (`events.ts`), and the chat key those events carry. */
    covers?: string[];
    chat?: string;
    /** The fixed texts sent since the last turn, by name, for its history (`told.ts`), sent beside the events that carry them too. */
    told?: readonly string[];
    /** How this chat asked Tex to talk (`texStyle.ts`), said to the model by the gateway. */
    texStyle?: TexStyle;
    /** When the first text this turn answers came in (`apps/mcp/src/agent/turnLog.js` `waitBefore`). */
    arrivedAt?: number;
    /** The sealed copy the last answer handed back, and this chat's newest events (`warm.ts`). */
    warm?: string;
    recent?: readonly TexEvent[];
    holdsLog?: boolean; // `recent` is the chat's whole log (`events.ts` `holdsLog`): the gateway reads none from storage
  } = {},
): Promise<AgentAnswer> {
  // The person's zone, so the turn knows the time where they are, and what
  // they sent with the text (`attachments.ts`).
  const ask = {
    question,
    conversation: "texts",
    ...(timeZone ? { timeZone } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(quoted ? { quoted } : quoted === "" ? { replied: true } : {}),
    ...(quoted && threadStart ? { threadStart } : {}),
    ...(quoted && tapback ? { tapback } : {}),
    ...(reacted.length > 0 ? { reacted } : {}),
    ...(turn ? { turn } : {}),
    ...(running ? { running } : {}),
    ...(job ? { job } : {}),
    ...(event ? { event } : {}),
    ...(jobReport ? { jobReport } : {}),
    ...(covers && covers.length > 0 && chat ? { covers, chat } : {}),
    ...(told.length > 0 ? { told } : {}),
    ...(texStyle ? { texStyle } : {}),
    ...(arrivedAt !== undefined ? { arrivedAt } : {}),
    ...(warm ? { warm } : {}),
    ...(recent && recent.length > 0 ? { recent } : {}),
    ...(holdsLog === true ? { holdsLog: true } : {}),
  };
  if (onProgress) return askAgentStream(fetcher, gatewayOrigin, accessToken, ask, onProgress, onStep);
  let result: { status: number; json: unknown };
  try {
    result = await post(
      fetcher,
      "gateway",
      `${gatewayOrigin}/agent`,
      accessToken,
      ask,
      AGENT_TIMEOUT_MS,
    );
  } catch {
    return { kind: "unavailable" };
  }
  return agentAnswer(result.status, result.json);
}

/** At most a few verbatim parts, each one a string the answer really contains. */
function readVerbatim(value: unknown, answer: string): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((part): part is string => typeof part === "string" && part.trim() !== "" && answer.includes(part))
    .slice(0, 5);
}

export function agentAnswer(status: number, json: unknown): AgentAnswer {
  const body = record(json);
  if (status === 200 && body.cancelled === true) return { kind: "cancelled" };
  const pictures = readPictures(body.pictures);
  if (status === 200 && typeof body.answer === "string" && (body.answer.trim() || pictures.length > 0 || body.quiet === true)) { // `quiet`: a turn with nothing to text, as a flag (`apps/mcp/src/agent/jobReport.js`)
    const verbatim = readVerbatim(body.verbatim, body.answer);
    const steered = Array.isArray(body.steered) ? body.steered.filter((id): id is string => typeof id === "string").slice(0, 5) : [];
    const jobs = readStartedJobs(body.jobs);
    const steers = readSteers(body.steers);
    const askIds = Array.isArray(body.askIds)
      ? body.askIds.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id)).slice(0, 8)
      : [];
    return {
      kind: "answer",
      text: body.answer.trim(),
      pictures,
      ...(readChoices(body.choices).length > 0 ? { choices: readChoices(body.choices) } : {}),
      ...(readOffers(body.offers).length > 0 ? { offers: readOffers(body.offers) } : {}),
      ...(verbatim.length > 0 ? { verbatim } : {}), ...(body.quiet === true ? { quiet: true as const } : {}),
      ...(steered.length > 0 ? { steered } : {}),
      ...(jobs.length > 0 ? { jobs } : {}),
      ...(steers.length > 0 ? { steers } : {}),
      ...(body.exhausted === true ? { exhausted: true as const } : {}),
      ...(body.unfinished === true ? { unfinished: true as const } : {}), ...(body.untrusted === true ? { untrusted: true as const } : {}), ...(typeof body.verdict === "string" && ["done", "keep_going", "waiting", "stuck"].includes(body.verdict) ? { verdict: body.verdict as JobVerdict, ...(typeof body.advice === "string" && body.advice.trim() ? { advice: body.advice.trim().slice(0, 600) } : {}) } : {}), // the advisor's check on a job's part (`apps/mcp/src/agent/jobCheck.js`); `untrusted`: it read from outside (`route.js`)
      ...(body.vaultWatch === true ? { vaultWatch: true as const } : {}),
      ...(askIds.length > 0 ? { askIds } : {}),
      ...(typeof body.askFor === "string" && /^[a-z0-9](?:[a-z0-9-]{0,63})$/.test(body.askFor) ? { askFor: body.askFor } : {}),
      ...(typeof body.warm === "string" && body.warm.length <= MAX_WARM_CHARS ? { warm: body.warm } : {}),
      ...(readLog(body.log).length > 0 ? { log: readLog(body.log) } : {}), // the chat's log the gateway read, held here from now on (`events.ts` `keepLog`)
    };
  }
  if (status === 409) return { kind: "no_model" };
  if (status === 429) return { kind: "daily_limit" };
  // Only the gateway's own 503, sent before the turn runs (`apps/mcp/src/agent/route.js`):
  // a platform 503 (a Worker over its limits) can come after tools ran.
  if (status === 503 && body.error === "model_unavailable") return { kind: "not_started" };
  if (status === 503 && body.error === "storage_unavailable") return { kind: "no_storage" };
  return { kind: "unavailable" };
}

/**
 * The most a streamed (long) turn may take, end to end: inside a Durable
 * Object alarm's 15 minutes, with room to send the answer. The gateway stops
 * calling tools well before it (`LONG_TOOL_BUDGET_MS`).
 */
export const AGENT_STREAM_TIMEOUT_MS = 12 * 60_000;
/** The gateway writes a heartbeat every 15 seconds; this long with no line is a dead stream. */
export const AGENT_STREAM_IDLE_MS = 60_000;
/** One line of the stream is a progress text or a final JSON body, which may carry pictures (`outgoing.ts`). */
const MAX_STREAM_LINE = 24 * 1024 * 1024;

/** `/agent` asked for as a stream: progress lines, a background job's `step` lines, then the answer. */
export async function askAgentStream(
  fetcher: Fetch,
  gatewayOrigin: string,
  accessToken: string,
  ask: { question: string } & Record<string, unknown>,
  onProgress: (text: string) => Promise<void>,
  onStep?: (text: string) => Promise<void>,
): Promise<AgentAnswer> {
  const abort = new AbortController();
  let timedOut = false;
  const expire = () => {
    timedOut = true;
    abort.abort();
  };
  const overall = setTimeout(expire, AGENT_STREAM_TIMEOUT_MS);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(expire, AGENT_STREAM_IDLE_MS);
  };
  try {
    touch();
    const response = await fetcher(`${gatewayOrigin}/agent`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/x-ndjson",
      },
      body: JSON.stringify(ask),
      signal: abort.signal,
    });
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("application/x-ndjson") || !response.body) {
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        json = null;
      }
      return agentAnswer(response.status, json);
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      touch();
      buffer += value;
      if (buffer.length > MAX_STREAM_LINE && !buffer.includes("\n")) return { kind: "unavailable" };
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = record(JSON.parse(line));
        } catch {
          continue;
        }
        if (typeof parsed.progress === "string" && parsed.progress.trim()) {
          await onProgress(parsed.progress.trim());
          touch();
          continue;
        }
        if (typeof parsed.step === "string" && parsed.step.trim()) {
          await onStep?.(parsed.step.trim().slice(0, 140));
          touch();
          continue;
        }
        if (typeof parsed.status === "number") return agentAnswer(parsed.status, parsed.body);
      }
    }
    // The stream ended with no final line: the turn died on the way.
    return { kind: "unavailable" };
  } catch {
    return timedOut ? { kind: "unavailable", timedOut: true } : { kind: "unavailable" };
  } finally {
    clearTimeout(overall);
    clearTimeout(idle);
    abort.abort();
  }
}

/** A sign-in link for a phone nobody has linked, or none for now. */
export type InviteAnswer = { status: "issued"; url: string } | { status: "refused" };

export async function requestLinkInvite(
  fetcher: Fetch,
  origin: string,
  secret: string,
  phone: string,
): Promise<InviteAnswer> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/invite`, secret, {
    phone,
  });
  if (status !== 200) throw new ServiceError("control_plane", status);
  const body = record(json);
  // Only an https link to a path is ever texted to anybody: the URL is built by
  // the control plane, and this is the last place a bad one can be stopped.
  if (body.status === "issued" && typeof body.url === "string" && /^https:\/\/[^\s/]+\/\S+$/.test(body.url)) {
    return { status: "issued", url: body.url };
  }
  return { status: "refused" };
}

export async function unlinkPhone(
  fetcher: Fetch,
  origin: string,
  secret: string,
  phone: string,
): Promise<"unlinked" | "not_linked"> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/unlink`, secret, {
    phone,
  });
  if (status !== 200) throw new ServiceError("control_plane", status);
  const body = record(json);
  if (body.status === "unlinked" || body.status === "not_linked") return body.status;
  throw new ServiceError("control_plane", status);
}

// ── Routines ──────────────────────────────────────────────────────────────
//
// A routine is a note the control plane says is due (`docs/decisions/
// routines.md`). The control plane hands this Worker the runs and a grant for
// each; the gateway runs it; the answer comes back here and goes out as texts.
// The answer never passes through the control plane: what this Worker reports
// back is an outcome code and a count.

/** How a routine's run ended, as the control plane records it. */
export type RoutineOutcome =
  | "answered"
  | "skipped"
  | "finished"
  | "failed"
  | "paused"
  | "routine_gone"
  | "not_a_routine"
  | "daily_limit"
  | "no_provider"
  | "no_chat";

export type RoutineSend = "text" | "note" | "both";

export type DueRoutine = {
  runId: string;
  /** "" for a chat routine's run: the chat's own turn mints its grant (`groupRoutines.ts`). */
  accessToken: string;
  path: string;
  timeZone: string;
  send: RoutineSend;
  phones: string[];
  /** A chat routine's chat, by its key: answered into that group, never a phone. */
  chat?: string;
  /** A chat routine's last run, in ms: what "new" means to it (`wake: new mail`). */
  since?: number;
  /** When this routine runs next after this run (`null` when paused). */
  nextRunAt?: number | null;
};

/** Most runs one tick takes on; the rest are still due on the next. */
export const MAX_DUE_RUNS = 100;
const E164 = /^\+[1-9]\d{6,14}$/;

const isSend = (value: unknown): value is RoutineSend => value === "text" || value === "note" || value === "both";
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The runs due now (the cron's), or with `scope` the one routine an alarm asks for. A malformed run is dropped, never guessed at. */
export async function fetchDueRoutines(fetcher: Fetch, origin: string, secret: string, scope?: { workspaceId: string; path: string }): Promise<DueRoutine[]> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/routines/due`, secret, scope ? { scope } : {});
  if (status !== 200) throw new ServiceError("control_plane", status);
  const runs = record(json).runs;
  if (!Array.isArray(runs)) throw new ServiceError("control_plane", status);
  const due: DueRoutine[] = [];
  for (const value of runs.slice(0, MAX_DUE_RUNS)) {
    const run = record(value);
    const chat = typeof run.chat === "string" && /^[0-9a-f]{64}$/.test(run.chat) ? run.chat : undefined;
    if (!nonEmpty(run.runId) || (chat === undefined && !nonEmpty(run.accessToken)) || !nonEmpty(run.path) ||
        typeof run.timeZone !== "string" || !isSend(run.send) || !Array.isArray(run.phones)) {
      continue;
    }
    // A phone names a Durable Object, so only a well-formed number is one.
    const phones = [...new Set(run.phones.filter((phone): phone is string => typeof phone === "string" && E164.test(phone)))];
    due.push({
      runId: run.runId,
      accessToken: chat === undefined ? (run.accessToken as string) : "",
      path: run.path,
      timeZone: run.timeZone,
      send: run.send,
      phones,
      ...(chat === undefined ? {} : { chat }),
      ...(chat !== undefined && Number.isSafeInteger(run.since) && (run.since as number) > 0 ? { since: run.since as number } : {}),
      ...(typeof run.nextRunAt === "number" || run.nextRunAt === null ? { nextRunAt: run.nextRunAt as number | null } : {}),
    });
  }
  return due;
}

/** What became of a run: a code and a count, never its text. */
export async function reportRoutineResult(
  fetcher: Fetch,
  origin: string,
  secret: string,
  result: { runId: string; outcome: RoutineOutcome; texted: number },
): Promise<void> {
  const { status } = await post(fetcher, "control_plane", `${origin}/agent-texts/routines/result`, secret, {
    runId: result.runId,
    outcome: result.outcome,
    texted: result.texted,
  });
  if (status < 200 || status >= 300) throw new ServiceError("control_plane", status);
}

export type RoutineAnswer = {
  outcome: Exclude<RoutineOutcome, "no_chat">;
  /** The text to send, when the outcome is one that has something to say. */
  answer: string;
  /** The routine's `send:` as the gateway read it just now, when it said. */
  send: RoutineSend | null;
};

const GATEWAY_OUTCOMES = new Set(["answered", "skipped", "finished", "failed", "paused"]);

/**
 * Run one routine on the gateway's `/agent` with its own grant. The gateway
 * re-reads the note and decides whether it runs; this only reads the result.
 * Never throws: anything it cannot read is `failed`.
 */
export async function runRoutine(
  fetcher: Fetch,
  gatewayOrigin: string,
  accessToken: string,
  routine: { path: string; timeZone: string },
): Promise<RoutineAnswer> {
  const failed: RoutineAnswer = { outcome: "failed", answer: "", send: null };
  let result: { status: number; json: unknown };
  try {
    result = await post(
      fetcher,
      "gateway",
      `${gatewayOrigin}/agent`,
      accessToken,
      { routine: { path: routine.path, timeZone: routine.timeZone } },
      AGENT_TIMEOUT_MS,
    );
  } catch {
    return failed;
  }
  const body = record(result.json);
  if (result.status === 200) {
    if (typeof body.outcome !== "string" || !GATEWAY_OUTCOMES.has(body.outcome)) return failed;
    const outcome = body.outcome as RoutineAnswer["outcome"];
    const speaks = outcome === "answered" || outcome === "finished";
    return {
      outcome,
      answer: speaks && typeof body.answer === "string" ? body.answer.trim() : "",
      send: isSend(body.send) ? body.send : null,
    };
  }
  if (result.status === 404) return { ...failed, outcome: "routine_gone" };
  if (result.status === 400 && body.error === "not_a_routine") return { ...failed, outcome: "not_a_routine" };
  if (result.status === 409) return { ...failed, outcome: "no_provider" };
  if (result.status === 429) return { ...failed, outcome: "daily_limit" };
  return failed;
}

/** The words an ask showed: the parts texted exactly as written (the ask itself), or the whole answer. */
export const askLine = (answer: { text: string; verbatim?: string[] }): string => answer.verbatim?.join("\n") || answer.text;
