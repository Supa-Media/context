/**
 * The one filter every log value passes before it reaches a public page.
 *
 * Two workflows read production Worker logs and publish what they read:
 * `tex-alert.yml` writes an issue on this public repository every fifteen
 * minutes, and `agent-logs.yml` prints to a run page anyone can open. Both
 * promise "codes and counts only, never anyone's words, number or chat id".
 * A filter that *strips* characters cannot keep that promise — it turns
 * "+1 (555) 123-4567" into "1555123-4567" and "Seyi Ogundipe" into
 * "SeyiOgundipe", both perfectly readable. So the rule is an **allowlist**: a
 * value that does not look like a code the Worker chose is replaced whole by
 * "other", and nothing of it is published.
 *
 * Numbers are not codes and are not admitted here: a bare six digits is the
 * shape of a sign-in code. A workflow that wants a duration or a count says
 * so per key (`agent-logs.yml`'s `show`).
 *
 * `agent-logs.yml` reads the logs in a step with no checkout, so it cannot
 * import this file and carries the same expressions inline. Its copies are
 * held to these by `agent-logs-filter.test.mjs`, which runs the shipped text.
 */

/** A log code as written, or "other": anything else — words, a name, a number — never reaches a public page. */
export function code(value) {
  const text = String(value);
  return /^[a-z][a-z0-9_:-]{0,39}$/i.test(text) && !/\d{7}/.test(text) ? text : "other";
}

/**
 * An exception's class, which says what broke without publishing the message
 * it broke on. Only a token that reads as a class (`TypeError`,
 * `DOMException`, a project's own `FooError`) is published: the first word of
 * a thrown string is as likely to be a person's name as anything else.
 */
export function exceptionClass(error) {
  return (String(error).match(/^(?:[A-Za-z]\w{0,29})?(?:Error|Exception)\b/) ?? ["unknown"])[0];
}
