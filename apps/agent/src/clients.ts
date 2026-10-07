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

export type Fetch = typeof fetch;

const TIMEOUT_MS = 30_000;
/** A turn that calls several tools can take a while; the gateway caps it too. */
const AGENT_TIMEOUT_MS = 120_000;

export class ServiceError extends Error {
  constructor(
    readonly service: "linq" | "control_plane" | "gateway",
    readonly status: number | null,
  ) {
    super(`${service} request failed${status === null ? "" : ` (${status})`}`);
    this.name = "ServiceError";
  }
}

async function post(
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

function record(value: unknown): Record<string, unknown> {
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

// ── Control plane ─────────────────────────────────────────────────────────

export type SessionAnswer = { status: "linked"; accessToken: string } | { status: "unlinked" };

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
    return { status: "linked", accessToken: body.accessToken };
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
  | { kind: "answer"; text: string }
  | { kind: "no_model" }
  | { kind: "daily_limit" }
  | { kind: "unavailable" };

/**
 * Ask the gateway's `/agent` route. `conversation` names the thread the
 * gateway keeps history for, in the person's own bucket; this Worker keeps
 * none.
 */
export async function askAgent(
  fetcher: Fetch,
  gatewayOrigin: string,
  accessToken: string,
  question: string,
): Promise<AgentAnswer> {
  let result: { status: number; json: unknown };
  try {
    result = await post(
      fetcher,
      "gateway",
      `${gatewayOrigin}/agent`,
      accessToken,
      { question, conversation: "texts" },
      AGENT_TIMEOUT_MS,
    );
  } catch {
    return { kind: "unavailable" };
  }
  const body = record(result.json);
  if (result.status === 200 && typeof body.answer === "string" && body.answer.trim()) {
    return { kind: "answer", text: body.answer.trim() };
  }
  if (result.status === 409) return { kind: "no_model" };
  if (result.status === 429) return { kind: "daily_limit" };
  return { kind: "unavailable" };
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
  accessToken: string;
  path: string;
  timeZone: string;
  send: RoutineSend;
  phones: string[];
};

/** Most runs one tick takes on; the rest are still due on the next. */
export const MAX_DUE_RUNS = 100;
const E164 = /^\+[1-9]\d{6,14}$/;

const isSend = (value: unknown): value is RoutineSend => value === "text" || value === "note" || value === "both";
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The runs that are due now. A malformed one is dropped, never guessed at. */
export async function fetchDueRoutines(fetcher: Fetch, origin: string, secret: string): Promise<DueRoutine[]> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/routines/due`, secret, {});
  if (status !== 200) throw new ServiceError("control_plane", status);
  const runs = record(json).runs;
  if (!Array.isArray(runs)) throw new ServiceError("control_plane", status);
  const due: DueRoutine[] = [];
  for (const value of runs.slice(0, MAX_DUE_RUNS)) {
    const run = record(value);
    if (!nonEmpty(run.runId) || !nonEmpty(run.accessToken) || !nonEmpty(run.path) ||
        typeof run.timeZone !== "string" || !isSend(run.send) || !Array.isArray(run.phones)) {
      continue;
    }
    // A phone names a Durable Object, so only a well-formed number is one.
    const phones = [...new Set(run.phones.filter((phone): phone is string => typeof phone === "string" && E164.test(phone)))];
    due.push({
      runId: run.runId,
      accessToken: run.accessToken,
      path: run.path,
      timeZone: run.timeZone,
      send: run.send,
      phones,
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
