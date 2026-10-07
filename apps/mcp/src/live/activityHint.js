/**
 * What a finished tool call tells the workspace activity feed, beside its
 * answer rather than inside it.
 *
 * The feed (`agentActivity.js`) is told about a call after it returns, and
 * until the live map it only needed the path, which it took from the call's
 * arguments. A map needs two facts the arguments cannot give: whether a
 * `write_note` *created* the note or changed one that was there, and which
 * notes a move actually moved (a folder move names a folder; the feed wants
 * the notes inside it, as they were renamed). Only the handler knows either.
 *
 * So the handler attaches them to its result under a Symbol. A Symbol-keyed,
 * non-enumerable property is invisible to `JSON.stringify` and to object
 * spread, so it never reaches the MCP client, never changes a tool's text,
 * and is lost — harmlessly, back to the old "edit" — by any wrapper that
 * builds a new result instead of passing this one through.
 */

const ACTIVITY_HINT = Symbol("context.activityHint");

/** Attach `hint` to `result` and return `result`. */
export function withActivityHint(result, hint) {
  if (result && typeof result === "object" && hint && typeof hint === "object") {
    Object.defineProperty(result, ACTIVITY_HINT, { value: hint, enumerable: false });
  }
  return result;
}

/** The hint a handler attached, or `null`. */
export function activityHintOf(result) {
  const hint = result && typeof result === "object" ? result[ACTIVITY_HINT] : undefined;
  return hint && typeof hint === "object" ? hint : null;
}
