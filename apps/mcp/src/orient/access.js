/** How `orient` and `scope_info` describe what this connection may reach. Moved verbatim out of `src/index.js`. */

/**
 * What an agent may do in one of the other contexts, where it will read it.
 *
 * `member` and `editor` are this codebase's vocabulary; what an agent needs to
 * know before it tries to write somewhere is whether it can. So the row is
 * written from the connection's **reach** — `effectiveScopes(grantScopes,
 * role)`, the clamp the call itself will be held to — and not from the role,
 * which is only half of it and was wrong in both directions.
 *
 * Both halves are said out loud, and that is the point rather than verbosity:
 *
 *  - **Write is named when it is held.** The version that said only "yours, and
 *    you see private notes there" described an owned context in three facts
 *    about reading, and a model asked to file a note there — reading that row,
 *    then the closing "what you may do in another is decided by your role
 *    there" — concluded it had not established that it could write, and said so
 *    instead of writing. It had `context` on `write_note` throughout.
 *  - **Read-only is named when it is not.** An `editor` on a read-only grant
 *    was announced as writable, which spends an agent's turn on a refusal this
 *    sentence could have prevented — and names the connection as the reason,
 *    because that is the part the person can change.
 *
 * The tier comes from the same clamp for the same reason: an `owner` on a grant
 * carrying no `context:private` reads that context at `team`, and promising
 * private notes there describes a workspace this connection cannot see.
 *
 * An unknown role reaches this with no write in its clamp, so it is described
 * as read-only — the direction that costs a refused write rather than a
 * confident attempt that fails.
 */
export function accessSentence(entry) {
  const owner = entry?.role === "owner";
  const notes = owner && entry?.tier === "private" ? "private notes" : "team notes";
  if (entry?.canWrite) {
    return owner
      ? `yours: you read ${notes} and can write there`
      : `you can read and write ${notes} there`;
  }
  // Which half refused, in the two voices `callToolForSession` refuses in: a
  // grant is a reconnection the person can make, a role is not.
  const why = entry?.grantWrites
    ? "your role there does not carry write"
    : "this connection is read-only";
  return owner
    ? `yours: you read ${notes} there, but ${why}`
    : `you can read ${notes} there, but ${why}`;
}

/**
 * The connection's reach in the context it is acting in, for the write surface.
 *
 * `store.contexts` is the request-scoped list `contextsFor` built, and exactly
 * one entry is `current`. A store that has none — a self-host shim, a test
 * harness, an `openContext` hop — yields `null`, and the write surface says
 * what it always said rather than guessing that a connection is read-only.
 */
export function currentReach(store) {
  return (store?.contexts || []).find((entry) => entry.current) || null;
}

/**
 * The read-only line, or nothing.
 *
 * A grant its person deliberately connected read-only was still handed
 * "Writable: every non-reserved Markdown path" — the paragraph that decides
 * whether an agent tries at all. It is stated before the writable prefixes
 * rather than instead of them: the prefixes remain true of the context, and
 * which of them this connection may write is a different sentence.
 */
export function readOnlyNotice(reach) {
  if (!reach || reach.canWrite) return "";
  return reach.grantWrites
    ? "**You cannot write here.** Your role in this context does not carry write; " +
        "its owner can change that. Everything below describes the context, not this connection.\n\n"
    : "**This connection is read-only.** It holds no write scope, so every write is refused " +
        "whichever context it addresses — reconnect the client with write access from the Context " +
        "dashboard. Everything below describes the context, not this connection.\n\n";
}
