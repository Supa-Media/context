/**
 * Which tool calls in one front-door round may run together (`turn.js`).
 *
 * A round runs its calls at the same time only when every resolved call is a
 * parallel read (`isParallelRead`): its name is in `PARALLEL_READS`, and its
 * arguments do not turn that name into a write. One that is not keeps the
 * whole round serial: a write, any `send` action other than web search, a
 * browser call (one shared browser), a tool that can be held for a yes, or a
 * call that can settle the turn. Names are what `six.resolve` hands the
 * dispatcher, not the six the model is shown (`sixTools.js`,
 * `tools/v2/searchFetch.js`).
 *
 * search (`translateSearch`, or the older name as itself):
 *   search_notes, search_email, search_texts
 *   group_chats — `search` with groups: true, and `fetch groups:`
 * fetch (`translateFetch`, and the assistant ids in `sixTools.js`):
 *   read_note, read_notes, list_notes, read_file, read_image, read_email,
 *   related_notes, evaluate_lists, read_meeting, read_channel_day, read_contact,
 *   list_meetings, read_calendar, list_channel_days, list_contacts, read_activity,
 *   list_changes, list_links, vault_list, list_plugins, scope_info, list_texts,
 *   read_texts, read_google_chat, read_skill, read_learned_skill, earlier_texts,
 *   earlier_chat, read_back, read_day, read_thread
 * web:
 *   search_web — `send` action search_web (`computer.js`). The search API,
 *   not the browser.
 *
 * Left out on purpose. `google_chat` is also the send action that posts a
 * message. `app_read` runs whichever remote tool the model names. `open_page`,
 * `browse`, `fill_login` and `fill_card` share one browser. `travel_time`
 * spends the same page budget. `vault_list` stays in the set for a plain
 * `fetch vault:` listing. `send` action `api` resolves to that same name with
 * `fetch` (`tools/v2/actions.js`): an outbound request with a vault secret,
 * which may write. `isParallelRead` returns false for that call, so the round
 * stays serial and a later call still sees that an earlier one was held or
 * failed. Everything else that writes, sends, is held for a yes, or settles
 * the turn (`start_background_job`, `plan_big_ask`, `restart_background_job`,
 * `say_nothing`, `tapback`, `ask_advisor`) is absent.
 */

export const PARALLEL_READS = new Set([
  "search_notes",
  "search_email",
  "search_texts",
  "group_chats",
  "read_note",
  "read_notes",
  "list_notes",
  "read_file",
  "read_image",
  "read_email",
  "related_notes",
  "evaluate_lists",
  "read_meeting",
  "read_channel_day",
  "read_contact",
  "list_meetings",
  "read_calendar",
  "list_channel_days",
  "list_contacts",
  "read_activity",
  "list_changes",
  "list_links",
  "vault_list",
  "list_plugins",
  "scope_info",
  "list_texts",
  "read_texts",
  "read_google_chat",
  "read_skill",
  "read_learned_skill",
  "earlier_texts",
  "earlier_chat",
  "read_back",
  "read_day",
  "read_thread",
  "search_web",
]);

/**
 * True when this resolved call may overlap another in the same round.
 * A name in `PARALLEL_READS` qualifies, except `vault_list` when `args.fetch`
 * is present (not null): that is `send` action `api`, not the `fetch vault:`
 * listing.
 *
 * @param {string | null | undefined} name
 * @param {object | null | undefined} [args]
 */
export function isParallelRead(name, args) {
  if (typeof name !== "string" || !PARALLEL_READS.has(name)) return false;
  if (name === "vault_list" && args?.fetch != null) return false;
  return true;
}

/**
 * True when a round's resolved calls may run together. One call stays on the
 * serial path: there is nothing to overlap. A null or unknown name does too,
 * and so does `vault_list` with `fetch` (`isParallelRead`). A string is a
 * name with no arguments.
 *
 * @param {Array<string | { name?: string | null, args?: object | null } | null | undefined>} calls
 */
export function roundIsParallel(calls) {
  if (!Array.isArray(calls) || calls.length < 2) return false;
  return calls.every((call) => {
    if (typeof call === "string" || call == null) return isParallelRead(call);
    if (typeof call !== "object") return false;
    return isParallelRead(call.name, call.args);
  });
}
