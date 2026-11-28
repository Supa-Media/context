/**
 * The gateway's tool contract, shared with Tex: the tool names Tex's own code is keyed by, the id prefixes and folder
 * name those tools use, the handle rule, the MCP result shapes and the v2 action lookup. Each piece moved here from the
 * file that named it, byte for byte, so the gateway and Tex read the same rule; the original module re-exports it.
 *
 * Plain CommonJS with no imports, so the gateway and the texting Worker read the same names.
 */

const EMAIL_TOOL = "send_email";

const REPORT_TOOL = "report_problem";

const TEXTS_ID_PREFIX = "texts:";

/**
 * Where a fact with no note goes: its own folder in the inbox, so memories do
 * not mix with everything else waiting there (the owner, 2026-10-07). The name
 * is ours, so the control plane lists it among the paths a share preview must
 * not confirm (`PRODUCT_MANDATED_PATHS`).
 */
const MEMORY_FOLDER = "inbox/memories";

function toolText(text) {
  return { content: [{ type: "text", text }] };
}
function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

/** The action a call names, with `write`'s default. */
function actionOf(tool, args) {
  if (tool === "write" && (args.action === undefined || args.action === null || args.action === "")) return "save";
  return args.action;
}

/** A handle as `functions/lib/names.ts` allows one. */
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;

/**
 * Whether words someone said yes or 👍 to were put to them by name (Tex names whom an offer or a group's ask is
 * for), so a yes in a group counts as the yes to that preview only from the person it asks. The handle is read
 * whole: "@jo" is not named by "@joan".
 */
function addressedTo(words, who) {
  if (typeof words !== "string" || !HANDLE.test(who ?? "")) return false;
  return new RegExp(`(?:^|[^a-z0-9-])@${who}(?![a-z0-9-])`, "i").test(words);
}

module.exports = { EMAIL_TOOL, REPORT_TOOL, TEXTS_ID_PREFIX, MEMORY_FOLDER, toolText, toolError, actionOf, HANDLE, addressedTo };
