/**
 * What gets put in front of a model at the start of a session.
 *
 * Claude Code's `SessionStart` hook is the only mechanism in any of this that
 * does not depend on an agent choosing to do something. Its output is injected
 * into the session before the first turn, so orientation stops being a tool the
 * model might reach for and becomes something it has already read.
 *
 * There are two versions of that, and the difference is a scope on a
 * credential rather than a feature flag:
 *
 * **The directive.** No read access, nothing fetched, always available. It
 * tells the model that this context exists, that the answer is probably already
 * in it, and to call `orient` before answering. Strictly stronger than a tool
 * description, because it is in the conversation rather than in a list of
 * capabilities the model is free to skim.
 *
 * **The orientation itself.** Requires `context:read` on a credential that
 * lives unattended on a laptop, which is why it is opt-in at install time and
 * never the default. When it is on, the model starts every session already
 * knowing the shape of the person's context — which is the whole thing this was
 * ever trying to achieve.
 *
 * Either way this must not be able to break a session that has not started yet.
 * A slow gateway, an expired token, a revoked grant: all of them fall back to
 * the directive, which needs no network at all.
 */

/** A start hook that stalls is a client that will not open. */
const ORIENT_TIMEOUT_MS = 8_000;

/**
 * The no-network version.
 *
 * Written as an instruction to the model rather than a description of a
 * product, because that is what it is: it arrives as session context, and
 * context that reads like marketing gets treated like marketing.
 */
export function orientDirective() {
  return [
    "This user has a Context — their own notes about their work, in storage they own,",
    "connected to you over MCP.",
    "",
    "Before answering anything about their projects, decisions, people, preferences or",
    "past work, call the `orient` tool. It is one cheap call and returns their front",
    "page, what they touched recently, and a map of their folders. Assume the answer is",
    "already written down in there and look before asking them to repeat it.",
    "",
    "When this session produces something durable — a decision, a constraint, a fact",
    "they should not have to say twice — save it with `save_context` before you finish.",
  ].join("\n");
}

/**
 * Fetch the live orientation over MCP.
 *
 * One plain `tools/call` and no handshake: the gateway is dual-era and has
 * never had a protocol session, so a single POST is a complete interaction.
 * That is what makes this cheap enough to run before every session.
 *
 * Never throws. Every failure is a `null` that the caller turns back into the
 * directive — a hook that reports a stack trace over the top of somebody's
 * opening prompt has made their session worse than not being installed.
 */
export async function fetchOrientation({ endpoint, token, fetchImpl = fetch, timeoutMs = ORIENT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "orient", arguments: {} },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    // A JSON-RPC error arrives with HTTP 200, and `isError` marks a tool that
    // refused. Neither is orientation, and injecting either as if it were would
    // put an error message into the model's head as fact.
    if (!body || body.error || body.result?.isError) return null;
    const text = body.result?.content?.find((block) => block?.type === "text")?.text;
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The block Claude Code injects, given whatever we managed to get.
 *
 * The orientation is wrapped in a line saying where it came from and when. It
 * is a snapshot taken seconds ago, and a model that treats it as live will
 * happily tell somebody a note exists that was deleted this morning.
 */
export function startContext({ orientation, at = new Date() }) {
  if (!orientation) return orientDirective();
  return [
    "The user's Context, as of the moment this session started",
    `(${at.toISOString()}). Call \`orient\` again if you need it fresher, and`,
    "`save_context` before you finish if this session produces anything durable.",
    "",
    orientation.trim(),
  ].join("\n");
}

export { ORIENT_TIMEOUT_MS };
