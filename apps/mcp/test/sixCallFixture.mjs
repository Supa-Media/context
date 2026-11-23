/**
 * A scripted model's tool call, in the six tools' shape (Dev2, 2026-11-23: Tex calls only the six; an older tool's
 * name is refused, `sixTools.js` `olderName`). Scripts written before then name the older tools (`read_note`,
 * `write_note`, `browse`); a real model is shown only the six, so the scripted one now calls them the same way. A name
 * this has no six call for is passed on as written, and the turn refuses it, as it would a real model's.
 * `agentSixOlderNames.test.mjs` proves the refusal itself on raw older names.
 */

import { ACTIONS } from "../src/tools/v2/actions.js";
import { ASSISTANT_SEND_ACTIONS } from "../../../packages/tex/gateway/agent/sixTools.js";

const SIX = new Set(["orient", "search", "fetch", "write", "manage", "send"]);

/** The readers the six reach by a `fetch` id, from what the older call named. */
const FETCH = {
  read_note: (a) => ({ id: a.path, rest: omit(a, ["path"]) }),
  list_notes: (a) => ({ id: typeof a.prefix === "string" && a.prefix !== "" ? (a.prefix.endsWith("/") ? a.prefix : `${a.prefix}/`) : "/", rest: omit(a, ["prefix"]) }),
  read_file: (a) => ({ id: a.path, rest: omit(a, ["path"]) }),
  read_image: (a) => ({ id: a.note, rest: omit(a, ["note"]) }),
  read_email: (a) => ({ id: a.id, rest: omit(a, ["id"]) }),
  read_calendar: (a) => ({ id: "calendar:", rest: a }),
  read_skill: (a) => ({ id: `skill:${a.name}`, rest: omit(a, ["name"]) }),
  read_learned_skill: (a) => ({ id: `learned:${a.name}`, rest: omit(a, ["name"]) }),
  earlier_texts: (a) => ({ id: "texts:", rest: a }),
  earlier_chat: (a) => ({ id: "chat:", rest: a }),
  read_back: (a) => ({ id: `read:${a.ref}`, rest: omit(a, ["ref"]) }),
  read_day: (a) => ({ id: `day:${a.day}`, rest: omit(a, ["day"]) }),
  read_thread: (a) => ({ id: a.thread === undefined ? "thread:" : `thread:${a.thread}`, rest: omit(a, ["thread"]) }),
  vault_list: (a) => ({ id: "vault:", rest: a }),
  app_read: (a) => ({ id: "apps:", rest: a }),
};

function omit(args, keys) {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !keys.includes(key)));
}

/** `{ name, args }` as one of the six would call it. */
export function asSixCall(call) {
  if (!call || typeof call.name !== "string" || SIX.has(call.name)) return call;
  const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {};
  // `write` takes path, content and expected_etag on top; a note's other fields (images, visibility, share) go in args (`actions.js` `withNote`).
  if (call.name === "write_note") {
    const rest = omit(args, ["path", "content", "expected_etag"]);
    return { ...call, name: "write", args: { ...omit(args, Object.keys(rest)), ...(Object.keys(rest).length ? { args: rest } : {}) } };
  }
  if (call.name === "search_notes") return { ...call, name: "search", args: { query: args.query, ...(Object.keys(omit(args, ["query"])).length ? { args: omit(args, ["query"]) } : {}) } };
  if (call.name === "search_email") return { ...call, name: "search", args: { query: args.query, args: { email: true, ...omit(args, ["query"]) } } };
  // A vault entry used to fetch a page is send action api, never a vault listing (`ACTIONS.send.api`).
  if (call.name === "vault_list" && args.fetch !== undefined) return { ...call, name: "send", args: { action: "api", args } };
  if (Object.hasOwn(FETCH, call.name)) {
    const { id, rest } = FETCH[call.name](args);
    return { ...call, name: "fetch", args: { id, ...(Object.keys(rest).length ? { args: rest } : {}) } };
  }
  for (const [family, table] of [["send", { ...ACTIONS.send, ...ASSISTANT_SEND_ACTIONS }], ["manage", ACTIONS.manage], ["write", ACTIONS.write]]) {
    const action = Object.keys(table).find((each) => table[each].tool === call.name);
    if (action !== undefined) return { ...call, name: family, args: { action, args } };
  }
  return call;
}
