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
