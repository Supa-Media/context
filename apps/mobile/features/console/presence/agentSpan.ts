/**
 * Where an agent's write landed in a durable note.
 *
 * In a v1 room the gateway handed a tool's text to one client, which merged it
 * and reported the caret for everybody. A v2 room hands nobody the text: each
 * client re-reads the committed snapshot over HTTP, on its own authorization.
 * So each client also works out for itself where the change landed, from the
 * Yjs event its own read produced, and draws the agent's caret there. Nothing
 * about the position crosses the wire, so no peer can claim a caret for an
 * agent.
 *
 * What gets drawn is a *selection* from the first changed character to the
 * last one inserted. `remoteCarets` already tints a member's selection in
 * their colour and puts their name at the head. So the new text is tinted and
 * signed, with no new rendering. It goes when the agent's roster entry
 * expires.
 */

/** One entry of a `Y.YTextEvent` delta. */
export interface TextDeltaOp {
  retain?: number;
  insert?: unknown;
  delete?: number;
}

/**
 * The span one text change touched, in the document as it now stands.
 *
 * `from` is the first position anything was inserted or deleted at; `to` is
 * the end of the last insertion (or `from` for a pure deletion, which leaves
 * nothing to tint and a caret where the text was). `null` when nothing
 * changed.
 */
export function changedSpan(delta: readonly TextDeltaOp[]): { from: number; to: number } | null {
  let index = 0;
  let from: number | null = null;
  let to: number | null = null;
  for (const op of delta) {
    if (typeof op.retain === "number") {
      index += op.retain;
    } else if (op.insert !== undefined) {
      from ??= index;
      // An embed counts as one position; Y.Text has none in a note today.
      index += typeof op.insert === "string" ? op.insert.length : 1;
      to = index;
    } else if (typeof op.delete === "number") {
      // A deletion removes text from the old document and does not advance
      // the position in the new one.
      from ??= index;
      to = Math.max(to ?? index, index);
    }
  }
  return from === null ? null : { from, to: to ?? from };
}

/**
 * How long a client waits, after being told an agent committed, for the read
 * that brings the change in.
 *
 * The repair is one HTTP round trip. Past this, the change arrived some other
 * way or not at all, and attributing whatever the next remote update happens
 * to be would be a guess with a name on it.
 */
export const AGENT_SPAN_WAIT_MS = 10_000;
