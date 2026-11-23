/**
 * A SIX-TOOL CALL IN THE WRONG SHAPE, REFUSED WITH ITS FIX WRITTEN OUT (Dev2, 2026-11-23).
 *
 * The Kansi reply (2026-11-22): Tex answered "can you respond to the email looping her in" with three `send` calls that
 * were all refused, then an empty answer. Its first call wrote the email's fields beside the action
 * (`send { action: "email", to, cc, subject, body, from, in_reply_to }`) and was told only "unknown argument from;
 * permitted here: action, args, ...". Its second put the sender in `mailbox` (the id of a joined note's mail, not an
 * address). Its third went back to the flat shape. Dev2: "we should only be using the send tool shape, with email as
 * the action", and every failure answers with the manual. So a call in the wrong shape is refused, never folded, and
 * the refusal writes the call it should have been, from its own arguments, so the next try is a copy.
 *
 * Only `send`'s actions that run on a Context tool (`ACTIONS.send`): the assistant's own actions (browse, search_web and
 * the like) already take their arguments written beside the action (`sixTools.js` `own`), and `manage` folds its own
 * (`manageOwn`).
 */

/** What a family call carries itself, never an action's own argument (`sixTools.js` `CALL_KEYS`). */
const CALL_KEYS = new Set(["action", "args", "context", "mailbox", "person_said"]);

/** An address-shaped `mailbox`: the sender, written where the id of a joined note's mail goes. */
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The actions whose sender is `args.from`. */
const FROM_ACTIONS = new Set(["email", "email_draft"]);

/** The most characters of a corrected call written into a refusal; past it, the shape alone. */
const MAX_CALL_CHARS = 1_500;

/** The call written as the model writes it: `send { action: "email", args: {...} }`, or its shape when too long. */
function written(family, action, args, rest) {
  const call = JSON.stringify({ action, args, ...rest });
  if (call.length <= MAX_CALL_CHARS) return `${family} ${call}`;
  return `${family} { "action": "${action}", "args": { ${Object.keys(args).map((key) => `"${key}": ...`).join(", ")} } }`;
}

/**
 * The refusal for a `send` call to a Context-tool action (`table`, `ACTIONS.send`) in the wrong shape, as
 * `{ error, cause }`, or null when its shape is right. `takes` is the carrying tool's argument names.
 */
export function sendShapeRefusal(call, table, takes) {
  if (!call || typeof call !== "object" || typeof call.action !== "string" || !Object.hasOwn(table, call.action)) return null;
  const action = call.action;
  const nested = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {};
  const beside = Object.fromEntries(Object.entries(call).filter(([key, value]) => !CALL_KEYS.has(key) && value !== undefined));
  const rest = Object.fromEntries(["context", "person_said"].filter((key) => call[key] !== undefined).map((key) => [key, call[key]]));
  const sender = FROM_ACTIONS.has(action) && typeof call.mailbox === "string" && ADDRESS.test(call.mailbox.trim()) && nested.from === undefined && beside.from === undefined;
  const misplaced = Object.keys(beside).filter((key) => takes === null || takes.has(key));
  if (misplaced.length === 0 && !sender && !(typeof call.mailbox === "string" && ADDRESS.test(call.mailbox.trim()))) return null;
  const args = { ...Object.fromEntries(misplaced.map((key) => [key, beside[key]])), ...nested, ...(sender ? { from: call.mailbox.trim() } : {}) };
  const said = [];
  if (misplaced.length > 0) said.push(`${misplaced.join(", ")} go inside args, never beside action`);
  if (sender) said.push("the mailbox it goes from is args.from; mailbox is only the id of a note's mail you joined");
  else if (typeof call.mailbox === "string" && ADDRESS.test(call.mailbox.trim())) said.push("mailbox is only the id of a note's mail you joined, never an address: leave it out");
  return {
    error: `Not run: ${said.join("; ")}. Call it again exactly like this: ${written("send", action, args, rest)}`,
    cause: "bad_arguments",
  };
}
